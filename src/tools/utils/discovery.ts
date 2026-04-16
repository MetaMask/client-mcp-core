import type { Page, Locator } from '@playwright/test';

import { TEXT_PREVIEW_MAX_LENGTH } from './constants.js';
import { debugWarn } from '../../utils';
import type {
  TestIdItem,
  A11yNodeTrimmed,
  RawA11yNode,
  IncludedRole,
} from '../types';
import { INCLUDED_ROLES } from '../types';

const INCLUDED_ROLES_SET = new Set<string>(INCLUDED_ROLES);

/**
 * Regular expression to parse a single ARIA snapshot line descriptor.
 *
 * Matches: `role` + optional `"name"` + optional `[attr]` / `[attr=value]` groups
 *
 * Examples:
 *   - `button "Submit"`
 *   - `heading "Title" [level=1]`
 *   - `checkbox "Accept" [checked]`
 *   - `listitem`
 */
const ARIA_LINE_RE =
  /^(?<role>[a-zA-Z]+)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<attrs>(?:\s+\[[^\]]*\])*)(?<hasChildren>:?)$/u;

/**
 * Regular expression to match individual `[key]` or `[key=value]` attribute groups.
 */
const ATTR_RE = /\[(?<key>[a-zA-Z]+)(?:=(?<value>[^\]]*))?\]/gu;

/**
 * Parse a Playwright ariaSnapshot() YAML string into RawA11yNode[].
 *
 * The YAML format emitted by Playwright's `locator.ariaSnapshot()` (v1.49+)
 * is a line-based, indentation-structured tree where each node line is:
 *   `- role "name" [attr=value]:` (children follow indented)
 *   `- role "name" [attr=value]`  (leaf node)
 *   `- text: some text content`   (text node, ignored for our purposes)
 *
 * @param yaml The YAML string returned by Playwright's ariaSnapshot()
 * @returns Array of parsed RawA11yNode trees
 */
export function parseAriaSnapshotYaml(yaml: string): RawA11yNode[] {
  if (!yaml?.trim()) {
    return [];
  }

  const lines = yaml.split('\n');
  const roots: RawA11yNode[] = [];
  const stack: { node: RawA11yNode; indent: number }[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const stripped = line.replace(/^ */u, '');
    const indent = line.length - stripped.length;

    if (!stripped.startsWith('- ')) {
      continue;
    }

    const descriptor = stripped.slice(2);

    if (descriptor.startsWith('text:') || descriptor === 'text') {
      continue;
    }

    if (descriptor.startsWith('/')) {
      continue;
    }

    const node = parseAriaNodeDescriptor(descriptor);
    if (!node) {
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      parent.children ??= [];
      parent.children.push(node);
    }

    stack.push({ node, indent });
  }

  return roots;
}

/**
 * Parse a single ARIA node descriptor string into a RawA11yNode.
 *
 * @param descriptor The descriptor after removing the `- ` prefix, e.g. `button "Submit" [disabled]:`
 * @returns A parsed node, or null if the descriptor cannot be parsed
 */
function parseAriaNodeDescriptor(descriptor: string): RawA11yNode | null {
  let desc = descriptor;

  // Strip trailing `:` (children indicator) or `: text` (inline text value)
  const trailingColonMatch = desc.match(
    /^(?<main>(?:[a-zA-Z]+)(?:\s+"(?:[^"\\]|\\.)*")?(?:\s+\[[^\]]*\])*)(?::(?<text>.*))?$/u,
  );
  if (trailingColonMatch?.groups?.main) {
    desc = trailingColonMatch.groups.main;
  }

  const match = ARIA_LINE_RE.exec(desc);
  if (!match?.groups) {
    return null;
  }

  const { role } = match.groups;
  const rawName = match.groups.name;

  const node: RawA11yNode = { role };

  if (rawName !== undefined) {
    node.name = rawName.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }

  const attrsStr = match.groups.attrs;
  if (attrsStr) {
    let attrMatch;
    ATTR_RE.lastIndex = 0;
    while ((attrMatch = ATTR_RE.exec(attrsStr)) !== null) {
      const key = attrMatch.groups?.key;
      const value = attrMatch.groups?.value;

      switch (key) {
        case 'disabled':
          node.disabled = value !== 'false';
          break;
        case 'checked':
          if (value === 'mixed') {
            node.checked = 'mixed';
          } else {
            node.checked = value !== 'false';
          }
          break;
        case 'expanded':
          node.expanded = value !== 'false';
          break;
        default:
          break;
      }
    }
  }

  return node;
}

/**
 * Collect all visible test IDs from the current page.
 *
 * @param page The Playwright page to scan for test IDs
 * @param limit Maximum number of test IDs to return (default: 150)
 * @returns Array of test ID items with visibility and text content
 */
export async function collectTestIds(
  page: Page,
  limit: number = 150,
): Promise<TestIdItem[]> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  const locators = await page.locator('[data-testid]').all();
  const results: TestIdItem[] = [];

  for (const locator of locators) {
    if (results.length >= limit) {
      break;
    }

    try {
      const testId = await locator.getAttribute('data-testid');
      if (!testId) {
        continue;
      }

      const isVisible = await locator.isVisible().catch(() => false);
      const textContent = await locator
        .textContent()
        .then(
          (text) =>
            text?.trim().substring(0, TEXT_PREVIEW_MAX_LENGTH) ?? undefined,
        )
        .catch(() => undefined);

      results.push({
        testId,
        tag: 'element',
        text: textContent,
        visible: isVisible,
      });
    } catch (error) {
      debugWarn('discovery.collectTestIds', error);
      continue;
    }
  }

  return results;
}

/**
 * Collect a trimmed accessibility tree snapshot with deterministic refs.
 *
 * @param page The Playwright page to snapshot
 * @param rootSelector Optional CSS selector to scope the snapshot to a specific element
 * @returns Object containing trimmed accessibility nodes and a reference map (e1, e2, etc.)
 */
export async function collectTrimmedA11ySnapshot(
  page: Page,
  rootSelector?: string,
): Promise<{
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
}> {
  const locator = rootSelector
    ? page.locator(rootSelector).first()
    : page.locator('body').first();

  const snapshotYaml: string = await locator.ariaSnapshot();

  if (!snapshotYaml) {
    return { nodes: [], refMap: new Map() };
  }

  const parsedRoots = parseAriaSnapshotYaml(snapshotYaml);

  if (parsedRoots.length === 0) {
    return { nodes: [], refMap: new Map() };
  }

  const trimmedNodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  let refCounter = 1;

  /**
   * Recursively traverse accessibility tree and collect included roles.
   *
   * @param node The current accessibility node to process
   * @param ancestorPath The path of ancestor nodes for context
   */
  function traverseNode(node: RawA11yNode, ancestorPath: string[]): void {
    const role = node.role?.toLowerCase() ?? '';
    const name = node.name ?? '';

    if (INCLUDED_ROLES_SET.has(role)) {
      const ref = `e${refCounter}`;
      refCounter += 1;
      const currentPath = [...ancestorPath];

      if (role === 'dialog' || role === 'heading') {
        currentPath.push(`${role}:${name}`);
      }

      const trimmedNode: A11yNodeTrimmed = {
        ref,
        role,
        name,
        path: currentPath,
      };

      if (node.disabled !== undefined) {
        trimmedNode.disabled = node.disabled;
      }
      if (node.checked !== undefined) {
        trimmedNode.checked = node.checked === true;
      }
      if (node.expanded !== undefined) {
        trimmedNode.expanded = node.expanded;
      }

      trimmedNodes.push(trimmedNode);

      const selector = buildA11ySelector(role as IncludedRole, name);
      refMap.set(ref, selector);
    }

    const updatedPath =
      role === 'dialog' || role === 'heading'
        ? [...ancestorPath, `${role}:${name}`]
        : ancestorPath;

    if (node.children) {
      for (const child of node.children) {
        traverseNode(child, updatedPath);
      }
    }
  }

  for (const root of parsedRoots) {
    traverseNode(root, []);
  }

  await enrichNodesWithDOMContext(page, trimmedNodes, refMap);

  const collapsedNodes = collapseIdenticalRuns(trimmedNodes);

  return { nodes: collapsedNodes, refMap };
}

const GENERIC_NAME_MAX_LENGTH = 20;
const ENRICHMENT_BATCH_LIMIT = 100;
const ENRICHMENT_ELEMENT_TIMEOUT_MS = 500;
const TEXT_CONTENT_MAX_LENGTH = 60;

type EnrichmentResult = {
  ref: string;
  testId: string | null;
  textContent: string | null;
};

/**
 * Enriches a11y nodes that have generic or empty names with data-testid
 * values and visible text content from the corresponding DOM elements.
 *
 * @param page - The Playwright page to query.
 * @param nodes - The trimmed a11y nodes to enrich (mutated in place).
 * @param refMap - Map of a11y refs to selectors for element lookup.
 */
async function enrichNodesWithDOMContext(
  page: Page,
  nodes: A11yNodeTrimmed[],
  refMap: Map<string, string>,
): Promise<void> {
  const candidates = nodes.filter(
    (node) => !node.name || node.name.length <= GENERIC_NAME_MAX_LENGTH,
  );

  if (candidates.length === 0) {
    return;
  }

  const enrichBatch = candidates.slice(0, ENRICHMENT_BATCH_LIMIT);

  const results = await Promise.allSettled(
    enrichBatch.map(async (node): Promise<EnrichmentResult> => {
      const selector = refMap.get(node.ref);
      if (!selector) {
        return { ref: node.ref, testId: null, textContent: null };
      }
      try {
        const locator = page.locator(selector).first();
        const [testId, rawText] = await Promise.all([
          locator
            .getAttribute('data-testid', {
              timeout: ENRICHMENT_ELEMENT_TIMEOUT_MS,
            })
            .catch(() => null),
          locator
            .textContent({ timeout: ENRICHMENT_ELEMENT_TIMEOUT_MS })
            .catch(() => null),
        ]);
        const trimmedText = rawText?.trim().slice(0, TEXT_CONTENT_MAX_LENGTH);
        const textContent =
          trimmedText && trimmedText !== node.name ? trimmedText : null;
        return { ref: node.ref, testId, textContent };
      } catch {
        return { ref: node.ref, testId: null, textContent: null };
      }
    }),
  );

  const enrichMap = new Map<string, EnrichmentResult>();
  for (const result of results) {
    if (result.status === 'fulfilled') {
      enrichMap.set(result.value.ref, result.value);
    }
  }

  for (const node of enrichBatch) {
    const data = enrichMap.get(node.ref);
    if (!data) {
      continue;
    }
    if (data.testId) {
      node.testId = data.testId;
    }
    if (data.textContent) {
      node.textContent = data.textContent;
    }
  }
}

const COLLAPSE_THRESHOLD = 3;

/**
 * Checks whether two string arrays contain identical elements in order.
 *
 * @param left - First array to compare.
 * @param right - Second array to compare.
 * @returns True if both arrays are equal.
 */
function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((val, idx) => val === right[idx])
  );
}

/**
 * Collapses consecutive runs of identical a11y nodes into a summary entry.
 * The refMap retains individual entries so refs still resolve — collapsing
 * only affects the agent-facing representation to reduce token waste.
 *
 * @param nodes - The flat list of trimmed a11y nodes to collapse.
 * @returns A new array with runs of 3+ identical nodes collapsed.
 */
function collapseIdenticalRuns(nodes: A11yNodeTrimmed[]): A11yNodeTrimmed[] {
  const collapsed: A11yNodeTrimmed[] = [];
  let cursor = 0;
  while (cursor < nodes.length) {
    const current = nodes[cursor];
    let runEnd = cursor + 1;
    while (
      runEnd < nodes.length &&
      nodes[runEnd].role === current.role &&
      nodes[runEnd].name === current.name &&
      nodes[runEnd].testId === current.testId &&
      nodes[runEnd].textContent === current.textContent &&
      arraysEqual(nodes[runEnd].path, current.path)
    ) {
      runEnd += 1;
    }

    const runLength = runEnd - cursor;
    if (runLength >= COLLAPSE_THRESHOLD) {
      collapsed.push(current);
      const lastInRun = nodes[runEnd - 1];
      collapsed.push({
        ref: `${current.ref}\u2013${lastInRun.ref}`,
        role: current.role,
        name: `\u2026 ${runLength - 1} more "${current.name || current.role}" (refs ${current.ref}\u2013${lastInRun.ref})`,
        path: current.path,
      });
    } else {
      for (let idx = cursor; idx < runEnd; idx += 1) {
        collapsed.push(nodes[idx]);
      }
    }
    cursor = runEnd;
  }
  return collapsed;
}

/**
 * Build an accessibility selector string from role and name.
 *
 * @param role The ARIA role for the selector
 * @param name The accessible name to match
 * @returns Formatted selector string (e.g., "role=button[name=\"Click me\"]")
 */
function buildA11ySelector(role: IncludedRole, name: string): string {
  const escapedName = name.replace(/"/gu, '\\"');
  return `role=${role}[name="${escapedName}"]`;
}

/**
 * Target type for scoping selectors.
 */
export type TargetType = 'a11yRef' | 'testId' | 'selector';

/**
 * Optional parent scope for chained locator resolution.
 */
export type WithinScope = {
  type: TargetType;
  value: string;
};

/**
 * Resolve a target element to a Playwright Locator, optionally scoped within a parent.
 *
 * @param scope The Playwright Page or Locator to search within
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @returns Playwright Locator for the resolved element
 */
function resolveTargetScoped(
  scope: Page | Locator,
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): Locator {
  switch (targetType) {
    case 'a11yRef': {
      const selector = refMap.get(targetValue);
      if (!selector) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
        );
      }
      return scope.locator(selector);
    }
    case 'testId':
      return scope.locator(`[data-testid="${targetValue}"]`);
    case 'selector':
      return scope.locator(targetValue);
    default: {
      const exhaustiveCheck: never = targetType;
      throw new Error(`Unknown target type: ${exhaustiveCheck as string}`);
    }
  }
}

/**
 * Resolve a target element to a Playwright Locator (page-level).
 *
 * @param page The Playwright page to search
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @returns Playwright Locator for the resolved element
 */
export async function resolveTarget(
  page: Page,
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): Promise<Locator> {
  return resolveTargetScoped(page, targetType, targetValue, refMap);
}

/**
 * Wait for a target element to become visible, optionally scoped within a parent.
 *
 * @param page The Playwright page to search
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param within Optional parent scope — resolves the target within this element
 * @returns Playwright Locator for the visible element
 */
export async function waitForTarget(
  page: Page,
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
  timeoutMs: number,
  within?: WithinScope,
): Promise<Locator> {
  let scope: Page | Locator = page;
  if (within) {
    const parentLocator = resolveTargetScoped(
      page,
      within.type,
      within.value,
      refMap,
    );
    await parentLocator
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    // Use .first() to guarantee the child search is scoped to exactly one
    // parent element.  Without this, Playwright chains the child locator
    // across ALL matching parents, producing phantom multi-matches
    // (e.g. 63 "end-accessory" buttons across 63 account cells).
    scope = parentLocator.first();
  }
  const locator = resolveTargetScoped(scope, targetType, targetValue, refMap);
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  return locator;
}
