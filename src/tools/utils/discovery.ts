import type { Page, Locator, CDPSession, Frame } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  callInIsolatedWorld,
  callOnNodeInIsolatedWorld,
  withCdpSession,
} from './cdp.js';
import {
  TESTID_COLLECT_TIMEOUT_MS,
  TEXT_PREVIEW_MAX_LENGTH,
} from './constants.js';
import { selectorInFrame } from './frame-scope.js';
import {
  animationsSettled,
  buildUniqueSelectorInPage,
  collectTestIdsInPage,
  stampRefInPage,
  waitUntilInPage,
} from './in-page.js';
import type { InPageStampResult, InPageTestIdItem } from './in-page.js';
import {
  buildTextFingerprint,
  describeTextFingerprint,
} from './ref-fingerprint.js';
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
 * Collect the `[data-testid]` elements of the current page, with a text
 * preview and visibility, in one in-page call (see `collectTestIdsInPage`
 * for order, text and visibility semantics).
 *
 * When the in-page call fails or takes longer than
 * `TESTID_COLLECT_TIMEOUT_MS`, falls back to per-element locator calls.
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

  let items: InPageTestIdItem[];
  try {
    items = await callInIsolatedWorld<InPageTestIdItem[]>(
      page,
      collectTestIdsInPage.toString(),
      [limit, TEXT_PREVIEW_MAX_LENGTH],
      TESTID_COLLECT_TIMEOUT_MS,
    );
  } catch (error) {
    debugWarn(
      'discovery.collectTestIds: in-page call failed, using locators',
      error,
    );
    return collectTestIdsViaLocators(page, limit);
  }

  return (items ?? []).map((item) => ({
    testId: item.testId,
    tag: 'element',
    text: item.text ?? undefined,
    visible: item.visible,
  }));
}

/**
 * Collects test IDs with per-element Playwright locator calls
 * (`getAttribute`, `isVisible`, `textContent`). Slower than the in-page
 * call; used only when that call fails.
 *
 * @param page The Playwright page to scan for test IDs
 * @param limit Maximum number of test IDs to return
 * @returns Array of test ID items with visibility and text content
 */
async function collectTestIdsViaLocators(
  page: Page,
  limit: number,
): Promise<TestIdItem[]> {
  const locators = await page
    .locator('[data-testid]')
    .all()
    .catch((error: unknown) => {
      debugWarn('discovery.collectTestIdsViaLocators', error);
      return [];
    });
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
      debugWarn('discovery.collectTestIdsViaLocators', error);
      continue;
    }
  }

  return results;
}

/**
 * Waits until the page's running, finite element animations end (see
 * `animationsSettled`), checking once per animation frame, for at most
 * `timeoutMs`. Never throws: a timeout or an unreadable page ends the wait.
 *
 * @param page - The Playwright page.
 * @param timeoutMs - Maximum time to wait in the page.
 * @param graceMs - Extra time before the daemon stops waiting for the page.
 * @returns True when the animations settled, false otherwise.
 */
export async function waitForAnimationsToSettle(
  page: Page,
  timeoutMs: number,
  graceMs: number,
): Promise<boolean> {
  const functionDeclaration = `function (timeoutMs) {
    return (${waitUntilInPage.toString()})(${animationsSettled.toString()}, timeoutMs);
  }`;
  try {
    return await callInIsolatedWorld<boolean>(
      page,
      functionDeclaration,
      [timeoutMs],
      timeoutMs + graceMs,
    );
  } catch (error) {
    debugWarn('discovery.waitForAnimationsToSettle', error);
    return false;
  }
}

type CdpAXProperty = {
  name: string;
  value?: {
    value?: unknown;
  };
};

type CdpAXNode = {
  nodeId: string;
  ignored: boolean;
  role?: {
    value?: unknown;
  };
  name?: {
    value?: unknown;
  };
  properties?: CdpAXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
};

/**
 * A node of the snapshot that gets a ref, in AX tree order.
 */
type RefCandidate = {
  role: string;
  name: string;
  backendDOMNodeId?: number;
  /**
   * False for nodes of a scoped snapshot that are outside the root subtree
   * (relatives returned by the `getPartialAXTree` fallback).
   */
  inScope: boolean;
};

/**
 * RefMap value for an element inside a closed shadow root, which no
 * Playwright selector can reach (see `stampRefInPage`). Resolving such a
 * ref throws at once instead of matching another element.
 */
export const UNREACHABLE_REF_SELECTOR = 'mm-unreachable=closed-shadow-root';

/**
 * Attribute that ties the refs of a snapshot to their DOM nodes (see
 * `stampRefInPage`).
 */
const REF_ATTRIBUTE = 'data-mm-ref';

/**
 * Number of snapshot tokens kept on one element. A ref stays valid until
 * this many later snapshots have stamped its element.
 */
const REF_TOKENS_KEPT = 4;

/**
 * Maximum number of node stamps (`stampNode`) in flight at the same time
 * during one snapshot.
 */
const REF_STAMP_CONCURRENCY = 16;

/**
 * Longest raw text `stampRefInPage` returns. Text that is still at most
 * `MAX_FINGERPRINT_TEXT_LENGTH` once whitespace is collapsed fits.
 */
const STAMP_TEXT_MAX_LENGTH = 1_000;

/** Joins the stamp selector of a ref and its text fingerprint. */
const FINGERPRINT_SEPARATOR = ' >> internal:has-text=';

/**
 * Builds the selector of a stamped ref: it matches the one element that
 * holds the token, and only while its text matches the fingerprint of the
 * snapshot, when it has one.
 *
 * @param token - The token of the ref.
 * @param fingerprint - The text fingerprint (see `buildTextFingerprint`).
 * @returns The selector (e.g. `[data-mm-ref~="1a2b3c4d-0"] >> internal:has-text=/^\s*Next\s*$/`).
 */
function buildRefStampSelector(token: string, fingerprint?: string): string {
  const stamp = `[${REF_ATTRIBUTE}~="${token}"]`;
  return fingerprint === undefined
    ? stamp
    : `${stamp}${FINGERPRINT_SEPARATOR}${fingerprint}`;
}

/**
 * Checks whether a refMap value is the selector of a stamped ref.
 *
 * @param selector - The refMap value.
 * @returns True for a stamp selector.
 */
function isRefStampSelector(selector: string): boolean {
  return selector.startsWith(`[${REF_ATTRIBUTE}~=`);
}

/**
 * The element a scoped snapshot was taken from.
 */
type SnapshotScope = {
  /** Playwright selector for the root element (`css=<root> >> nth=0`). */
  selector: string;
  /** Backend DOM node id of the root element. */
  backendNodeId: number;
};

/**
 * The iframe whose content a snapshot tree comes from.
 */
type SnapshotFrame = {
  /** Playwright selector of the iframe element in the page. */
  iframeSelector: string;
  /** Prefix of the refs of the frame's nodes (`f1` gives `f1e1`, ...). */
  refPrefix: string;
  /** Path of the frame's nodes before their own ancestors. */
  path: string[];
};

/**
 * Maximum number of iframes whose content a page snapshot includes (hidden
 * and empty iframes do not count).
 */
const MAX_SNAPSHOT_FRAMES = 5;

/**
 * How long a snapshot waits for an iframe element, in milliseconds.
 */
const FRAME_ELEMENT_TIMEOUT_MS = 2_000;

/**
 * How long `describe_screen` with a frame waits for the iframe to be
 * attached, in milliseconds.
 */
const FRAME_ATTACH_TIMEOUT_MS = 5_000;

/**
 * Extracts the normalized ARIA role from a CDP accessibility node.
 *
 * @param node The raw CDP accessibility node.
 * @returns The lower-cased role name, or an empty string when absent.
 */
function getRole(node: CdpAXNode): string {
  return typeof node.role?.value === 'string'
    ? node.role.value.toLowerCase()
    : '';
}

/**
 * Extracts the accessible name from a CDP accessibility node.
 *
 * @param node The raw CDP accessibility node.
 * @returns The accessible name when present.
 */
function getName(node: CdpAXNode): string | undefined {
  return typeof node.name?.value === 'string' ? node.name.value : undefined;
}

/**
 * Coerces a CDP property value into a boolean.
 *
 * CDP accessibility properties may arrive as native booleans or as the
 * string literals `"true"` / `"false"`.
 *
 * @param value The raw CDP property value.
 * @returns The normalized boolean, or undefined when absent/unrecognized.
 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

/**
 * Reads a boolean accessibility property from a CDP node.
 *
 * @param node The raw CDP accessibility node.
 * @param propertyName The boolean property to read.
 * @returns The normalized boolean value when present.
 */
function getBooleanProperty(
  node: CdpAXNode,
  propertyName: 'disabled' | 'expanded',
): boolean | undefined {
  const property = node.properties?.find(
    (entry) => entry.name === propertyName,
  );
  return coerceBoolean(property?.value?.value);
}

/**
 * Reads the checked state from a CDP accessibility node.
 *
 * @param node The raw CDP accessibility node.
 * @returns The normalized checked state, including mixed values.
 */
function getCheckedProperty(node: CdpAXNode): boolean | 'mixed' | undefined {
  const property = node.properties?.find((entry) => entry.name === 'checked');
  const value = property?.value?.value;

  if (value === 'mixed') {
    return 'mixed';
  }

  return coerceBoolean(value);
}

/**
 * Converts a raw CDP accessibility node into the internal tree shape.
 *
 * @param node The raw CDP accessibility node.
 * @returns The normalized internal accessibility node.
 */
function normalizeAxNode(node: CdpAXNode): RawA11yNode {
  return {
    role: getRole(node),
    name: getName(node),
    disabled: getBooleanProperty(node, 'disabled'),
    checked: getCheckedProperty(node),
    expanded: getBooleanProperty(node, 'expanded'),
    backendDOMNodeId: node.backendDOMNodeId,
    ignored: node.ignored,
  };
}

/**
 * Rebuilds a nested accessibility tree from CDP's flat AX node list.
 *
 * @param nodes The flat CDP accessibility node list.
 * @returns Root nodes for the reconstructed tree.
 */
function buildAxTree(nodes: CdpAXNode[]): RawA11yNode[] {
  if (nodes.length === 0) {
    return [];
  }

  const rawNodesById = new Map<string, RawA11yNode>();

  for (const node of nodes) {
    rawNodesById.set(node.nodeId, normalizeAxNode(node));
  }

  for (const node of nodes) {
    const rawNode = rawNodesById.get(node.nodeId);
    if (!rawNode || !node.childIds?.length) {
      continue;
    }

    const children = node.childIds
      .map((childId) => rawNodesById.get(childId))
      .filter((child): child is RawA11yNode => child !== undefined);

    if (children.length > 0) {
      rawNode.children = children;
    }
  }

  return nodes
    .filter((node) => !node.parentId || !rawNodesById.has(node.parentId))
    .map((node) => rawNodesById.get(node.nodeId))
    .filter((node): node is RawA11yNode => node !== undefined);
}

/**
 * Resolves a root selector to the backend node id needed by CDP
 * accessibility APIs, with Playwright auto-waiting.
 *
 * Playwright's locator ensures the element is attached before CDP
 * resolves it, which prevents empty snapshots on late-appearing
 * elements (modals, popovers).  Element resolution itself uses CDP's
 * `DOM.querySelector` to stay compatible with LavaMoat-protected pages
 * where `page.evaluate()` is restricted.
 *
 * @param page The Playwright page that owns the target element.
 * @param cdpSession The active CDP session.
 * @param rootSelector The CSS selector to resolve.
 * @returns The backend node id, or null when the selector matches nothing.
 */
async function resolveRootBackendNodeId(
  page: Page,
  cdpSession: CDPSession,
  rootSelector: string,
): Promise<number | null> {
  try {
    await page.locator(rootSelector).first().waitFor({ state: 'attached' });
  } catch {
    return null;
  }

  const documentResult = await cdpSession.send('DOM.getDocument', { depth: 0 });
  const queryResult = await cdpSession.send('DOM.querySelector', {
    nodeId: documentResult.root.nodeId,
    selector: rootSelector,
  });

  if (!queryResult.nodeId) {
    return null;
  }

  const describeResult = await cdpSession.send('DOM.describeNode', {
    nodeId: queryResult.nodeId,
  });

  return describeResult.node.backendNodeId;
}

/**
 * Collects raw accessibility data from CDP and normalizes it into a tree.
 *
 * @param page The Playwright page to snapshot.
 * @param cdpSession The active CDP session.
 * @param rootSelector Optional CSS selector that scopes the snapshot.
 * @returns The normalized raw accessibility tree, and the backend node id of
 * the root element when the snapshot is scoped.
 */
async function collectRawAxTree(
  page: Page,
  cdpSession: CDPSession,
  rootSelector?: string,
): Promise<{ roots: RawA11yNode[]; rootBackendNodeId?: number }> {
  await cdpSession.send('Accessibility.enable');

  try {
    if (!rootSelector) {
      const result = await cdpSession.send('Accessibility.getFullAXTree');
      return { roots: buildAxTree(result.nodes) };
    }

    const backendNodeId = await resolveRootBackendNodeId(
      page,
      cdpSession,
      rootSelector,
    );
    if (backendNodeId === null) {
      return { roots: [] };
    }

    try {
      const result = await cdpSession.send('Accessibility.queryAXTree', {
        backendNodeId,
      });
      return {
        roots: buildAxTree(result.nodes),
        rootBackendNodeId: backendNodeId,
      };
    } catch (error) {
      debugWarn(
        `queryAXTree failed for selector="${rootSelector}", falling back to getPartialAXTree:`,
        error,
      );
      // getPartialAXTree also returns relatives of the root (ancestors,
      // siblings). Their role selectors stay page-wide, so ambiguous matches
      // fail in strict mode instead of being narrowed to the root subtree.
      const result = await cdpSession.send('Accessibility.getPartialAXTree', {
        backendNodeId,
      });
      return {
        roots: buildAxTree(result.nodes),
        rootBackendNodeId: backendNodeId,
      };
    }
  } finally {
    await cdpSession.send('Accessibility.disable').catch(() => undefined);
  }
}

/**
 * Determines whether a generic-role node is meaningful enough to expose.
 *
 * A generic node is only useful to an agent when it carries a non-empty
 * accessible name — without one, there is no way to build a stable selector
 * and the agent has no semantic context for what the element represents.
 *
 * @param node The normalized accessibility node.
 * @returns True when the generic node carries a meaningful name.
 */
function shouldIncludeGenericNode(node: RawA11yNode): boolean {
  if (node.role !== 'generic') {
    return false;
  }

  return (node.name ?? '').trim().length > 0;
}

/**
 * Determines whether a normalized accessibility node should become a ref.
 *
 * @param node The normalized accessibility node.
 * @returns True when the node belongs in the trimmed snapshot.
 */
function shouldIncludeNode(node: RawA11yNode): boolean {
  if (node.ignored) {
    return false;
  }
  return INCLUDED_ROLES_SET.has(node.role) || shouldIncludeGenericNode(node);
}

/**
 * Stamps the DOM node of a ref with its token (see `stampRefInPage`), in an
 * isolated world of the page (`callOnNodeInIsolatedWorld`): the
 * Extension's main world scuttles globals with LavaMoat, so page code must
 * not run there.
 *
 * @param page The Playwright page.
 * @param backendDOMNodeId The backend DOM node id of the element.
 * @param token The token of the ref.
 * @returns The ref selector: the stamp selector, `UNREACHABLE_REF_SELECTOR`
 * inside a closed shadow root, or undefined when the node was not stamped.
 */
async function stampNode(
  page: Page,
  backendDOMNodeId: number,
  token: string,
): Promise<string | undefined> {
  const result = await callOnNodeInIsolatedWorld<InPageStampResult | null>(
    page,
    backendDOMNodeId,
    stampRefInPage.toString(),
    [REF_ATTRIBUTE, token, REF_TOKENS_KEPT, STAMP_TEXT_MAX_LENGTH],
  );
  if (result?.status === 'stamped') {
    return buildRefStampSelector(
      token,
      result.text === null ? undefined : buildTextFingerprint(result.text),
    );
  }
  return result?.status === 'unreachable'
    ? UNREACHABLE_REF_SELECTOR
    : undefined;
}

/**
 * Runs an async function over items with at most `limit` calls in flight.
 *
 * @param items The items.
 * @param limit The maximum number of concurrent calls.
 * @param fn The function to run for each item.
 * @returns The results, in the order of `items`.
 */
async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  limit: number,
  fn: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Stamps the DOM node of each candidate (see `stampNode`), at most
 * `REF_STAMP_CONCURRENCY` at a time. Each candidate gets the token
 * `<snapshotId>-<index>`, where the snapshot id is new for each call. A
 * candidate without a backend node, or whose stamp fails (logged), gets no
 * selector.
 *
 * @param page The Playwright page.
 * @param candidates The nodes that can get a ref, in AX tree order.
 * @returns The stamp selector of each candidate (same order), when stamped.
 */
async function stampCandidates(
  page: Page,
  candidates: RefCandidate[],
): Promise<(string | undefined)[]> {
  const snapshotId = randomUUID().slice(0, 8);
  return mapWithConcurrency(
    candidates.map((candidate, index) => ({ candidate, index })),
    REF_STAMP_CONCURRENCY,
    async ({ candidate: { backendDOMNodeId }, index }) => {
      if (backendDOMNodeId === undefined || backendDOMNodeId === null) {
        return undefined;
      }
      try {
        return await stampNode(
          page,
          backendDOMNodeId,
          `${snapshotId}-${index}`,
        );
      } catch (error) {
        debugWarn(
          `Failed to stamp the ref of backendDOMNodeId=${backendDOMNodeId}:`,
          error,
        );
        return undefined;
      }
    },
  );
}

/**
 * Builds the selector of every ref of a snapshot, so that each ref matches
 * exactly one element or, when that cannot be guaranteed, makes the action
 * fail in Playwright's strict mode instead of hitting another element.
 *
 * Every candidate of a page snapshot is stamped with a token of this
 * snapshot (`stampCandidates`), and the ref selects the token
 * (`[data-mm-ref~="<token>"]`), so a ref always targets the element the
 * snapshot saw. It does not depend on the role or the accessible name:
 * Chromium's AX tree and Playwright's role engine do not always agree on a
 * role (an `<a>` without `href` is a link in the AX tree only), and names
 * can hold live values (prices) that change after the snapshot. When the
 * element has text, the ref also carries a fingerprint of it
 * (`buildTextFingerprint`, live values masked), so a node that React
 * reused for other content no longer matches. A node inside a closed
 * shadow root gets `UNREACHABLE_REF_SELECTOR`. Stamp selectors are unique
 * in the document and get no scope prefix.
 *
 * A candidate that cannot be stamped (no backend node, the node left the
 * page, resolve failure) falls back to:
 * - included roles (button, link, heading, ...):
 * `role=<role>[name="<name>" s]` (exact, case-sensitive name). It matches
 * every element with that role and name, so an action fails in strict
 * mode when several elements share it.
 * - generic nodes: `text="<name>"`, else no ref. `text=` also matches
 * wrappers of the text and elements that are not refs of this snapshot,
 * so an action on an ambiguous text ref fails in strict mode.
 * There is deliberately no `>> nth=<k>`: Chromium's AX tree and
 * Playwright's role engine do not always agree on the members of a group
 * and their order, so an index could act on another element.
 *
 * Scoped snapshots: the AX tree only holds the subtree of the root, so
 * fallback role and text selectors get the root as a prefix
 * (`css=<root> >> nth=0 >> role=...`). Playwright's role engine does not
 * match the scope element itself, so an unstamped root node gets the root
 * selector. With the `getPartialAXTree` fallback, the tree also holds
 * relatives of the root (ancestors, siblings); their fallback selectors
 * stay page-wide.
 *
 * Iframe content is not stamped. Stamps run in the page's main frame, and
 * a stamp selector does not cross into an iframe. Role and text selectors
 * continue inside the iframe
 * (`<iframe> >> internal:control=enter-frame >> role=...`). Duplicates keep
 * the role selector and fail in strict mode, and generic nodes use `text=`.
 *
 * @param page The Playwright page.
 * @param candidates The nodes that can get a ref, in AX tree order.
 * @param scope The root of a scoped snapshot.
 * @param frame The iframe the candidates are in.
 * @returns The selector of each candidate (same order), or null when the
 * candidate has no selector and gets no ref.
 */
async function buildRefSelectors(
  page: Page,
  candidates: RefCandidate[],
  scope?: SnapshotScope,
  frame?: SnapshotFrame,
): Promise<(string | null)[]> {
  const scoped = (selector: string, inScope: boolean): string => {
    if (frame) {
      return selectorInFrame(frame.iframeSelector, selector);
    }
    return scope && inScope ? `${scope.selector} >> ${selector}` : selector;
  };
  const isScopeRoot = (candidate: RefCandidate): boolean =>
    scope !== undefined && candidate.backendDOMNodeId === scope.backendNodeId;

  // Stamps run in the page's main frame. Skip them for iframe content:
  // the selector would not cross into the frame, and an out-of-process
  // frame's backend node ids belong to another renderer.
  const stampSelectors: (string | undefined)[] = frame
    ? candidates.map(() => undefined)
    : await stampCandidates(page, candidates);

  return candidates.map((candidate, index) => {
    const stampSelector = stampSelectors[index];
    if (stampSelector) {
      return stampSelector;
    }
    if (scope && isScopeRoot(candidate)) {
      return scope.selector;
    }
    if (INCLUDED_ROLES_SET.has(candidate.role)) {
      return scoped(
        buildA11ySelector(candidate.role as IncludedRole, candidate.name),
        candidate.inScope,
      );
    }
    if (!candidate.name) {
      return null;
    }
    debugWarn(
      `Using text= fallback selector for generic node (role=${candidate.role}, name=${candidate.name}). ` +
        `DOM resolution failed; targeting by visible text is less stable.`,
      undefined,
    );
    return scoped(buildTextSelector(candidate.name), candidate.inScope);
  });
}

/**
 * Trims a normalized AX tree into the public accessibility snapshot shape.
 *
 * @param page The Playwright page.
 * @param parsedRoots The normalized raw accessibility tree roots.
 * @param scope The root of a scoped snapshot.
 * @param frame The iframe the tree comes from.
 * @returns The trimmed nodes and their backing ref map.
 */
async function trimAxTreeToA11yNodes(
  page: Page,
  parsedRoots: RawA11yNode[],
  scope?: SnapshotScope,
  frame?: SnapshotFrame,
): Promise<{
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
}> {
  const candidates: RefCandidate[] = [];
  const candidateNodes: Omit<A11yNodeTrimmed, 'ref'>[] = [];

  // queryAXTree returns only the root subtree, which may not hold the root
  // node itself (when it is ignored). Every node is then in scope. When the
  // root node is present, only it and its descendants are.
  const rootInTree =
    scope !== undefined &&
    containsBackendNode(parsedRoots, scope.backendNodeId);

  /**
   * Walks the normalized tree and collects the nodes that can get a ref.
   *
   * @param node The current node being visited.
   * @param ancestorPath The semantic ancestor path collected so far.
   * @param insideRoot Whether an ancestor is the scope root.
   */
  function traverseNode(
    node: RawA11yNode,
    ancestorPath: string[],
    insideRoot: boolean,
  ): void {
    const role = node.role?.toLowerCase() ?? '';
    const name = node.name ?? '';
    const isPathNode = role === 'dialog' || role === 'heading';
    const childPath = isPathNode
      ? [...ancestorPath, `${role}:${name}`]
      : ancestorPath;
    const inScope =
      !rootInTree ||
      insideRoot ||
      node.backendDOMNodeId === scope?.backendNodeId;

    if (shouldIncludeNode(node)) {
      const trimmedNode: Omit<A11yNodeTrimmed, 'ref'> = {
        role,
        name,
        path: isPathNode ? childPath : ancestorPath,
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

      candidateNodes.push(trimmedNode);
      candidates.push({
        role,
        name,
        backendDOMNodeId: node.backendDOMNodeId,
        inScope,
      });
    }

    for (const child of node.children ?? []) {
      traverseNode(child, childPath, inScope);
    }
  }

  for (const root of parsedRoots) {
    traverseNode(root, frame?.path ?? [], false);
  }

  const selectors = await buildRefSelectors(page, candidates, scope, frame);
  const nodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  selectors.forEach((selector, index) => {
    if (selector === null) {
      return;
    }
    const ref = `${frame?.refPrefix ?? ''}e${nodes.length + 1}`;
    nodes.push({ ref, ...candidateNodes[index] });
    refMap.set(ref, selector);
  });

  return { nodes, refMap };
}

/**
 * Checks whether a tree holds the node of a backend DOM node id.
 *
 * @param nodes The tree roots.
 * @param backendNodeId The backend DOM node id.
 * @returns True when a node of the tree has that id.
 */
function containsBackendNode(
  nodes: RawA11yNode[],
  backendNodeId: number,
): boolean {
  return nodes.some(
    (node) =>
      node.backendDOMNodeId === backendNodeId ||
      containsBackendNode(node.children ?? [], backendNodeId),
  );
}

/**
 * An iframe of the page's AX tree.
 */
type IframeNode = {
  backendNodeId: number;
  name: string;
  /** The `role:name` of the dialogs and headings that contain it. */
  path: string[];
};

/**
 * Lists the iframes of a page AX tree, in tree order. CDP leaves hidden
 * iframes (`display: none`) out of the tree; their content is not listed
 * either.
 *
 * @param roots The tree roots.
 * @returns The iframes with a DOM node.
 */
function findIframeNodes(roots: RawA11yNode[]): IframeNode[] {
  const iframes: IframeNode[] = [];
  const visit = (node: RawA11yNode, path: string[]): void => {
    if (
      node.role === 'iframe' &&
      !node.ignored &&
      node.backendDOMNodeId !== undefined
    ) {
      iframes.push({
        backendNodeId: node.backendDOMNodeId,
        name: node.name ?? '',
        path,
      });
    }
    const childPath =
      node.role === 'dialog' || node.role === 'heading'
        ? [...path, `${node.role}:${node.name ?? ''}`]
        : path;
    for (const child of node.children ?? []) {
      visit(child, childPath);
    }
  };
  roots.forEach((root) => visit(root, []));
  return iframes;
}

/**
 * Reads the AX tree of an iframe's content.
 *
 * A same-process iframe (same origin) is part of the page's CDP session:
 * `getFullAXTree` takes its frame id. An out-of-process iframe (cross
 * origin, with site isolation) is not ("Frame with the given frameId is
 * not found") and gets its own CDP session from Playwright's `Frame`.
 *
 * @param page The Playwright page.
 * @param cdpSession The page's CDP session.
 * @param iframeSelector Playwright selector of the iframe element.
 * @param frameId The CDP frame id of the iframe's content, when known.
 * @returns The CDP AX nodes of the frame.
 */
async function collectFrameAxNodes(
  page: Page,
  cdpSession: CDPSession,
  iframeSelector: string,
  frameId: string | undefined,
): Promise<CdpAXNode[]> {
  if (frameId !== undefined) {
    try {
      const result = await cdpSession.send('Accessibility.getFullAXTree', {
        frameId,
      });
      return result.nodes;
    } catch {
      // Out of process: read it through the frame's own session below.
    }
  }

  const handle = await page
    .locator(iframeSelector)
    .first()
    .elementHandle({ timeout: FRAME_ELEMENT_TIMEOUT_MS });
  let frame: Frame | null | undefined;
  try {
    frame = await handle?.contentFrame();
  } finally {
    await handle?.dispose();
  }
  if (!frame) {
    throw new Error(`Frame not found: ${iframeSelector} is not an iframe`);
  }

  let frameSession: CDPSession;
  try {
    frameSession = await page.context().newCDPSession(frame);
  } catch {
    // Same process, but the frame id is unknown (not a CSS selector).
    throw new Error(
      `Frame ${iframeSelector} cannot be read: target the iframe by testId or CSS selector`,
    );
  }
  try {
    await frameSession.send('Accessibility.enable');
    const result = await frameSession.send('Accessibility.getFullAXTree');
    return result.nodes;
  } finally {
    await frameSession.detach().catch(() => undefined);
  }
}

/**
 * Gets the CDP frame id of an iframe's content from a CSS selector of the
 * iframe element.
 *
 * @param cdpSession The page's CDP session.
 * @param iframeSelector The selector of the iframe element.
 * @returns The frame id, or undefined when the selector is not CSS or
 * matches no iframe.
 */
async function findFrameIdByCss(
  cdpSession: CDPSession,
  iframeSelector: string,
): Promise<string | undefined> {
  try {
    const documentResult = await cdpSession.send('DOM.getDocument', {
      depth: 0,
    });
    const { nodeId } = await cdpSession.send('DOM.querySelector', {
      nodeId: documentResult.root.nodeId,
      selector: iframeSelector,
    });
    if (!nodeId) {
      return undefined;
    }
    const { node } = await cdpSession.send('DOM.describeNode', { nodeId });
    return node.frameId;
  } catch {
    return undefined;
  }
}

/**
 * Trims the AX tree of an iframe's content into snapshot nodes.
 *
 * @param page The Playwright page.
 * @param axNodes The CDP AX nodes of the frame.
 * @param frame The iframe.
 * @returns The trimmed nodes and their refs.
 */
async function trimFrameTree(
  page: Page,
  axNodes: CdpAXNode[],
  frame: SnapshotFrame,
): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
  return trimAxTreeToA11yNodes(page, buildAxTree(axNodes), undefined, frame);
}

/**
 * Builds the most stable Playwright selector available for a DOM-backed node.
 *
 * Runs `buildUniqueSelectorInPage` on the node in an isolated world of the
 * page (`callOnNodeInIsolatedWorld`): the Extension's main world scuttles
 * globals with LavaMoat, so page code must not run there. A unique
 * `data-testid`, else a unique `id`, else the shortest unique `nth-of-type`
 * path, checked the way Playwright's CSS engine matches (open shadow roots
 * included). Elements inside open shadow roots get a chained selector
 * (`css=<host> >> css=<inside>`), and elements inside a closed shadow root
 * get `UNREACHABLE_REF_SELECTOR`. There is no selector (`undefined`) when
 * no candidate is unique, and for detached elements.
 *
 * Used to address an iframe element in the page. Ref selectors themselves
 * are stamps (`stampCandidates`); this selector is only the prefix that
 * continues into the iframe, and a test id or id stays valid across
 * snapshots.
 *
 * @param page The Playwright page.
 * @param backendDOMNodeId The backend DOM node id for the target element.
 * @returns A Playwright-compatible selector when one can be synthesized.
 */
async function buildSelectorFromBackendNode(
  page: Page,
  backendDOMNodeId: number,
): Promise<string | undefined> {
  const selector = await callOnNodeInIsolatedWorld<unknown>(
    page,
    backendDOMNodeId,
    buildUniqueSelectorInPage.toString(),
  );
  return typeof selector === 'string' ? selector : undefined;
}

/**
 * Snapshots the content of the visible iframes of a page AX tree, at most
 * `MAX_SNAPSHOT_FRAMES` frames with nodes. The nodes of the k-th frame with nodes get refs
 * `f<k>e1`, `f<k>e2`, ..., and a path that starts with the iframe's own
 * path and `iframe:<name>`. Iframes inside iframes are not read. A frame
 * that cannot be read is logged and left out.
 *
 * @param page The Playwright page.
 * @param cdpSession The page's CDP session.
 * @param roots The page AX tree roots.
 * @returns The nodes and refs of the frames, in tree order.
 */
async function snapshotChildFrames(
  page: Page,
  cdpSession: CDPSession,
  roots: RawA11yNode[],
): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
  const nodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  const iframes = findIframeNodes(roots);
  if (iframes.length === 0) {
    return { nodes, refMap };
  }

  let frameCount = 0;
  await cdpSession.send('Accessibility.enable');
  try {
    for (const iframe of iframes) {
      if (frameCount === MAX_SNAPSHOT_FRAMES) {
        break;
      }
      try {
        const iframeSelector = await buildSelectorFromBackendNode(
          page,
          iframe.backendNodeId,
        );
        if (
          iframeSelector === undefined ||
          iframeSelector === UNREACHABLE_REF_SELECTOR ||
          !(await page.locator(iframeSelector).isVisible())
        ) {
          continue;
        }
        const { node } = await cdpSession.send('DOM.describeNode', {
          backendNodeId: iframe.backendNodeId,
        });
        const axNodes = await collectFrameAxNodes(
          page,
          cdpSession,
          iframeSelector,
          node.frameId,
        );
        const frameTree = await trimFrameTree(page, axNodes, {
          iframeSelector,
          refPrefix: `f${frameCount + 1}`,
          path: [...iframe.path, `iframe:${iframe.name}`],
        });
        if (frameTree.nodes.length === 0) {
          continue;
        }
        frameCount += 1;
        nodes.push(...frameTree.nodes);
        frameTree.refMap.forEach((selector, ref) => refMap.set(ref, selector));
      } catch (error) {
        debugWarn(
          `Failed to snapshot iframe backendDOMNodeId=${iframe.backendNodeId}:`,
          error,
        );
      }
    }
  } finally {
    await cdpSession.send('Accessibility.disable').catch(() => undefined);
  }
  return { nodes, refMap };
}

/**
 * Snapshots only the content of one iframe, for `describe_screen` with a
 * frame. Its refs are `f1e1`, `f1e2`, ...
 *
 * @param page The Playwright page.
 * @param cdpSession The page's CDP session.
 * @param iframeSelector Playwright selector of the iframe element.
 * @returns The trimmed nodes and their refs.
 */
async function snapshotFrame(
  page: Page,
  cdpSession: CDPSession,
  iframeSelector: string,
): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
  try {
    await page
      .locator(iframeSelector)
      .first()
      .waitFor({ state: 'attached', timeout: FRAME_ATTACH_TIMEOUT_MS });
  } catch {
    throw new Error(`Frame not found: no element matches ${iframeSelector}`);
  }
  await cdpSession.send('Accessibility.enable');
  try {
    const axNodes = await collectFrameAxNodes(
      page,
      cdpSession,
      iframeSelector,
      await findFrameIdByCss(cdpSession, iframeSelector),
    );
    return await trimFrameTree(page, axNodes, {
      iframeSelector,
      refPrefix: 'f1',
      path: [],
    });
  } finally {
    await cdpSession.send('Accessibility.disable').catch(() => undefined);
  }
}

/**
 * Collect a trimmed accessibility tree snapshot with deterministic refs.
 *
 * A snapshot of the whole page also holds the content of its visible
 * iframes (see `snapshotChildFrames`), after the page's own nodes, with
 * refs `f1e1`, `f1e2`, ... With `frameSelector`, the snapshot holds only
 * the content of that iframe.
 *
 * @param page The Playwright page to snapshot
 * @param rootSelector Optional CSS selector to scope the snapshot to a specific element
 * @param frameSelector Optional Playwright selector of an iframe element: snapshot only its content
 * @returns Object containing trimmed accessibility nodes and a reference map (e1, e2, etc.)
 */
export async function collectTrimmedA11ySnapshot(
  page: Page,
  rootSelector?: string,
  frameSelector?: string,
): Promise<{
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
}> {
  return withCdpSession(page, async (cdpSession) => {
    if (frameSelector !== undefined) {
      if (rootSelector !== undefined) {
        throw new Error('rootSelector cannot be combined with frame');
      }
      const frameTree = await snapshotFrame(page, cdpSession, frameSelector);
      await enrichNodesWithDOMContext(page, frameTree.nodes, frameTree.refMap);
      return {
        nodes: collapseIdenticalRuns(frameTree.nodes),
        refMap: frameTree.refMap,
      };
    }

    const { roots: parsedRoots, rootBackendNodeId } = await collectRawAxTree(
      page,
      cdpSession,
      rootSelector,
    );

    if (parsedRoots.length === 0) {
      return { nodes: [], refMap: new Map() };
    }

    const scope =
      rootSelector !== undefined && rootBackendNodeId !== undefined
        ? {
            selector: buildScopeSelector(rootSelector),
            backendNodeId: rootBackendNodeId,
          }
        : undefined;

    const { nodes, refMap } = await trimAxTreeToA11yNodes(
      page,
      parsedRoots,
      scope,
    );

    if (rootSelector === undefined) {
      const frames = await snapshotChildFrames(page, cdpSession, parsedRoots);
      nodes.push(...frames.nodes);
      frames.refMap.forEach((selector, ref) => refMap.set(ref, selector));
    }

    await enrichNodesWithDOMContext(page, nodes, refMap);

    return {
      nodes: collapseIdenticalRuns(nodes),
      refMap,
    };
  });
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
    (node) =>
      node.role === 'generic' ||
      !node.name ||
      node.name.length <= GENERIC_NAME_MAX_LENGTH,
  );

  if (candidates.length === 0) {
    return;
  }

  const enrichBatch = candidates.slice(0, ENRICHMENT_BATCH_LIMIT);

  const results = await Promise.allSettled(
    enrichBatch.map(async (node): Promise<EnrichmentResult> => {
      const selector = refMap.get(node.ref);
      if (!selector || selector === UNREACHABLE_REF_SELECTOR) {
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
 * Checks whether two optional string arrays (an a11y node `path`) contain
 * identical elements in order. Two absent arrays are equal; an absent array
 * never equals a present one, even an empty one.
 *
 * @param left - First array to compare.
 * @param right - Second array to compare.
 * @returns True if both arrays are absent or equal.
 */
function arraysEqual(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
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
 * Normalizes whitespace the way Playwright does before it compares names and
 * text (`normalizeWhiteSpace`): drops zero-width spaces and soft hyphens,
 * trims, and collapses whitespace runs (newlines included) to one space.
 * Two names with the same normalized form match the same elements, so they
 * must produce the same selector for duplicates to be detected.
 *
 * @param value The name or text.
 * @returns The normalized string.
 */
function normalizeSelectorWhitespace(value: string): string {
  return value
    .replace(/[\u200b\u00ad]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * Quotes a string for a Playwright selector.
 *
 * Playwright reads quoted strings in attribute selectors
 * (`parseAttributeSelector`) and in `text=` selectors (`cssUnquote`) the
 * same way: a backslash escapes the next character, so only `\` and `"`
 * need escaping. `>>` inside the quotes does not split the selector. The
 * value is whitespace-normalized first (see `normalizeSelectorWhitespace`).
 *
 * @param value The string to quote.
 * @returns The quoted string.
 */
function quoteSelectorString(value: string): string {
  const escaped = normalizeSelectorWhitespace(value)
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"');
  return `"${escaped}"`;
}

/**
 * Build an accessibility selector string from role and name.
 *
 * Playwright's `role=` engine matches a quoted name exactly and
 * case-sensitively (the full accessible name after whitespace
 * normalization, no substring), so "Send" does not match "Send max". Only
 * `getByRole` / `internal:role` without `exact` match substrings or ignore
 * case. The `s` flag repeats the case-sensitive default to make it
 * explicit. An empty name matches only elements with an empty accessible
 * name. The selector still matches every element with that role and name,
 * so `buildRefSelectors` only uses it for nodes it could not stamp.
 *
 * @param role The ARIA role for the selector
 * @param name The accessible name to match
 * @returns Formatted selector string (e.g., `role=button[name="Click me" s]`)
 */
function buildA11ySelector(role: IncludedRole, name: string): string {
  return `role=${role}[name=${quoteSelectorString(name)} s]`;
}

/**
 * Build a text selector that matches elements whose own text is exactly
 * `text` (case-sensitive, after whitespace normalization).
 *
 * @param text The text to match.
 * @returns Formatted selector string (e.g., `text="Rename account"`).
 */
function buildTextSelector(text: string): string {
  return `text=${quoteSelectorString(text)}`;
}

/**
 * Build the Playwright selector for the root of a scoped snapshot: the
 * first element that matches the CSS selector, as `DOM.querySelector` does.
 *
 * @param rootSelector The CSS selector of the snapshot root.
 * @returns Formatted selector string (e.g., `css=.modal >> nth=0`).
 */
function buildScopeSelector(rootSelector: string): string {
  return `css=${rootSelector.trim()} >> nth=0`;
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
 * Resolve a target to the Playwright selector that locates it.
 *
 * @param targetType The type of target identifier (a11yRef, testId, or CSS selector)
 * @param targetValue The target value to resolve
 * @param refMap Map of a11y refs to selectors (used when targetType is 'a11yRef')
 * @returns The selector for the target
 */
function targetSelector(
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): string {
  switch (targetType) {
    case 'a11yRef': {
      const selector = refMap.get(targetValue);
      if (!selector) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
        );
      }
      if (selector === UNREACHABLE_REF_SELECTOR) {
        throw new Error(
          `Ref ${targetValue} is inside a closed shadow root: it cannot be targeted`,
        );
      }
      return selector;
    }
    case 'testId':
      return `[data-testid="${targetValue}"]`;
    case 'selector':
      return targetValue;
    default: {
      const exhaustiveCheck: never = targetType;
      throw new Error(`Unknown target type: ${exhaustiveCheck as string}`);
    }
  }
}

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
  return scope.locator(targetSelector(targetType, targetValue, refMap));
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

const CHANGED_REF_TEXT_TIMEOUT_MS = 1_000;

/**
 * Fails at once when the element of a stamped ref is no longer on the page
 * (re-mounted or removed since the snapshot), or when it now shows other
 * content (React reused the node: "Next" became "Confirm"). Only elements
 * the snapshot saw hold the token, so waiting for it would wait out the
 * whole timeout, and acting on reused content could submit the wrong step.
 * Other targets are not checked.
 *
 * @param page The Playwright page.
 * @param targetType The type of target identifier.
 * @param targetValue The target value.
 * @param refMap Map of a11y refs to selectors.
 */
async function assertStampedRefOnPage(
  page: Page,
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): Promise<void> {
  const selector =
    targetType === 'a11yRef' ? refMap.get(targetValue) : undefined;
  if (selector === undefined || !isRefStampSelector(selector)) {
    return;
  }
  const [stampSelector, fingerprint] = selector.split(FINGERPRINT_SEPARATOR);
  const stamped = page.locator(stampSelector);
  if ((await stamped.count()) === 0) {
    throw new Error(
      `Ref ${targetValue} not found: its element left the page after the snapshot; take a new snapshot`,
    );
  }
  if (
    fingerprint !== undefined &&
    (await page.locator(selector).count()) === 0
  ) {
    const now = (
      (await stamped
        .first()
        .textContent({ timeout: CHANGED_REF_TEXT_TIMEOUT_MS })
        .catch(() => null)) ?? ''
    )
      .replace(/\s+/gu, ' ')
      .trim();
    throw new Error(
      `Ref ${targetValue} not found: its element changed since the snapshot (was "${describeTextFingerprint(
        fingerprint,
      )}", now "${now.length > 60 ? `${now.slice(0, 60)}…` : now}"); take a new snapshot`,
    );
  }
}

/**
 * Delay between the two checks that a `within` ref is outside the parent.
 */
const WITHIN_RECHECK_DELAY_MS = 100;

export type WaitForTargetOptions = {
  /**
   * Fail with "matched 0 elements" when the target matches no element after
   * this wait, instead of waiting for the whole timeout for it to appear.
   */
  missingTargetWaitMs?: number;
};

/**
 * Throws when a locator still matches no element after a short wait.
 *
 * @param locator The target locator
 * @param waitMs How long to wait for a first match
 * @param description The target, for the error message
 */
async function assertTargetMatches(
  locator: Locator,
  waitMs: number,
  description: string,
): Promise<void> {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: waitMs });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') {
      throw error;
    }
    if ((await locator.count()) === 0) {
      throw new Error(`${description} matched 0 elements after ${waitMs}ms`);
    }
  }
}

/**
 * Describes a target by its selector, for "matched 0 elements" errors.
 *
 * @param targetType The type of target identifier
 * @param targetValue The target value
 * @param refMap Map of a11y refs to selectors
 * @param within The parent scope the target was searched in, if any
 * @returns For example `Selector [data-testid="x"] (testId:x) inside testId:y`
 */
function describeTargetSelector(
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
  within?: WithinScope,
): string {
  const selector = targetSelector(targetType, targetValue, refMap);
  const target =
    targetType === 'selector' ? '' : ` (${targetType}:${targetValue})`;
  const scope = within ? ` inside ${within.type}:${within.value}` : '';
  return `Selector ${selector}${target}${scope}`;
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
 * @param options Optional wait behavior
 * @returns Playwright Locator for the visible element
 */
export async function waitForTarget(
  page: Page,
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
  timeoutMs: number,
  within?: WithinScope,
  options?: WaitForTargetOptions,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const failIfMissing = async (
    locator: Locator,
    scope?: WithinScope,
  ): Promise<void> => {
    if (options?.missingTargetWaitMs === undefined) {
      return;
    }
    // A Playwright timeout of 0 means no timeout.
    const waitMs = Math.min(options.missingTargetWaitMs, deadline - Date.now());
    if (waitMs <= 0) {
      return;
    }
    await assertTargetMatches(
      locator,
      waitMs,
      describeTargetSelector(targetType, targetValue, refMap, scope),
    );
  };
  if (within) {
    await assertStampedRefOnPage(page, within.type, within.value, refMap);
  }
  await assertStampedRefOnPage(page, targetType, targetValue, refMap);
  let scope: Page | Locator = page;
  if (within) {
    const parentLocator = resolveTargetScoped(
      page,
      within.type,
      within.value,
      refMap,
    );
    const parentRemaining = deadline - Date.now();
    if (parentRemaining <= 0) {
      throw new Error(`Timeout ${timeoutMs}ms exceeded waiting for element`);
    }
    await parentLocator.first().waitFor({
      state: 'visible',
      timeout: parentRemaining,
    });
    // Use .first() to guarantee the child search is scoped to exactly one
    // parent element.  Without this, Playwright chains the child locator
    // across ALL matching parents, producing phantom multi-matches
    // (e.g. 63 "end-accessory" buttons across 63 account cells).
    scope = parentLocator.first();
  }
  let locator: Locator;
  if (within && targetType === 'a11yRef') {
    // A ref selector resolves to one element page-wide (stamp selectors are
    // unique in the document; scope prefixes count from the document, not
    // from the parent). Resolve it page-wide and keep it only if it is
    // inside the parent: `within` only checks containment.
    const refLocator = resolveTargetScoped(
      page,
      targetType,
      targetValue,
      refMap,
    );
    const contained = refLocator.and(scope.locator('*'));
    // `within` must never pick among the matches of an ambiguous ref (a
    // duplicate without a unique selector): with several page-wide matches,
    // `.and(parent)` could narrow them to one wrong element.
    const assertUnambiguous = async (): Promise<number> => {
      const count = await refLocator.count();
      if (count > 1) {
        throw new Error(
          `Ref ${targetValue} is ambiguous (${count} matches); take a new snapshot or target it by testId or selector`,
        );
      }
      return count;
    };
    // Fail fast when the ref is on the page but outside the parent, instead
    // of waiting for the whole timeout. The two counts are separate round
    // trips and the page can change in between (an element moving into the
    // parent), so only fail when a second check, after a short delay, sees
    // the same.
    const isOutside = async (): Promise<boolean> =>
      (await assertUnambiguous()) === 1 && (await contained.count()) === 0;
    if (await isOutside()) {
      const delay = Math.min(
        WITHIN_RECHECK_DELAY_MS,
        Math.max(0, deadline - Date.now()),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (await isOutside()) {
        throw new Error(`Ref ${targetValue} is not inside the within element`);
      }
    }
    await failIfMissing(refLocator);
    const attachRemaining = deadline - Date.now();
    if (attachRemaining <= 0) {
      throw new Error(`Timeout ${timeoutMs}ms exceeded waiting for element`);
    }
    // Not on the page yet: wait until it is (`first()`: no strict-mode
    // error while it is ambiguous), then check again that it is one
    // element. Containment is enforced by waiting on `contained` below.
    await refLocator
      .first()
      .waitFor({ state: 'attached', timeout: attachRemaining });
    await assertUnambiguous();
    locator = contained;
  } else {
    locator = resolveTargetScoped(scope, targetType, targetValue, refMap);
    await failIfMissing(locator, within);
  }
  const childRemaining = deadline - Date.now();
  if (childRemaining <= 0) {
    throw new Error(`Timeout ${timeoutMs}ms exceeded waiting for element`);
  }
  await locator.waitFor({
    state: 'visible',
    timeout: childRemaining,
  });
  return locator;
}
