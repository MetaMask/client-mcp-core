import type { Page, Locator } from '@playwright/test';

import { TEXT_PREVIEW_MAX_LENGTH } from './constants.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
  RawA11yNode,
  IncludedRole,
} from './types';
import { INCLUDED_ROLES } from './types';
import { debugWarn } from './utils';

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

  return { nodes: trimmedNodes, refMap };
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
 * Resolve a target element to a Playwright Locator.
 *
 * @param page The Playwright page to search
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @returns Playwright Locator for the resolved element
 */
export async function resolveTarget(
  page: Page,
  targetType: 'a11yRef' | 'testId' | 'selector',
  targetValue: string,
  refMap: Map<string, string>,
): Promise<Locator> {
  switch (targetType) {
    case 'a11yRef': {
      const selector = refMap.get(targetValue);
      if (!selector) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
        );
      }
      return page.locator(selector);
    }
    case 'testId':
      return page.locator(`[data-testid="${targetValue}"]`);
    case 'selector':
      return page.locator(targetValue);
    default: {
      const exhaustiveCheck: never = targetType;
      throw new Error(`Unknown target type: ${exhaustiveCheck as string}`);
    }
  }
}

/**
 * Wait for a target element to become visible.
 *
 * @param page The Playwright page to search
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @param timeoutMs Maximum time to wait in milliseconds
 * @returns Playwright Locator for the visible element
 */
export async function waitForTarget(
  page: Page,
  targetType: 'a11yRef' | 'testId' | 'selector',
  targetValue: string,
  refMap: Map<string, string>,
  timeoutMs: number,
): Promise<Locator> {
  const locator = await resolveTarget(page, targetType, targetValue, refMap);
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  return locator;
}
