import type {
  DeviceBackend,
  ElementQuery,
  UIElement,
} from '@metamask/device-mcp';

import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  GetTextActionResult,
  PlatformScreenshotOptions,
  PlatformType,
  WithinScope,
} from './types.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';
import type { TestIdItem, A11yNodeTrimmed } from '../tools/types/discovery.js';

const DEFAULT_BUNDLE_ID = 'io.metamask';
const DEFAULT_TESTID_LIMIT = 150;

/**
 * Platform driver for mobile devices backed by @metamask/device-mcp.
 * Wraps DeviceBackend behind the IPlatformDriver interface so the
 * tool layer can interact with iOS/Android devices using the same
 * API it uses for Playwright browser sessions.
 */
export class MobilePlatformDriver implements IPlatformDriver {
  readonly #backend: DeviceBackend;

  readonly #bundleId: string;

  /**
   * @param backend - The device-mcp backend to delegate to.
   * @param bundleId - The app bundle ID for getAppState calls.
   */
  constructor(backend: DeviceBackend, bundleId: string = DEFAULT_BUNDLE_ID) {
    this.#backend = backend;
    this.#bundleId = bundleId;
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param _within - Unused on mobile — elements are always searched globally.
   * @returns Click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    _within?: WithinScope,
  ): Promise<ClickActionResult> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
    await this.#backend.tapElement(query);
    return { clicked: true, target: `${targetType}:${targetValue}` };
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param text - Text to type into the element.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param _within - Unused on mobile.
   * @returns Type result with success status and text length.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    _within?: WithinScope,
  ): Promise<TypeActionResult> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
    await this.#backend.tapElement(query);
    await this.#backend.typeText(text);
    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param _within - Unused on mobile.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    _within?: WithinScope,
  ): Promise<void> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param _within - Unused on mobile.
   * @returns The element's text content, target descriptor, and length.
   */
  async getText(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    _within?: WithinScope,
  ): Promise<GetTextActionResult> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
    const text = await this.#backend.getElementText(query);
    return {
      text,
      target: `${targetType}:${targetValue}`,
      length: text.length,
    };
  }

  /**
   * @param _rootSelector - Unused on mobile — no CSS selectors.
   * @returns Accessibility nodes and ref-to-identifier map.
   */
  async getAccessibilityTree(
    _rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const snapshot = await this.#backend.snapshot();
    return normalizeSnapshot(snapshot.hierarchy);
  }

  /**
   * @param limit - Maximum number of test IDs to return.
   * @returns Array of test ID items with identifiers from the UI hierarchy.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const snapshot = await this.#backend.snapshot();
    const items: TestIdItem[] = [];
    const max = limit ?? DEFAULT_TESTID_LIMIT;
    collectTestIds(snapshot.hierarchy, items, max);
    return items;
  }

  /**
   * @param options - Screenshot options.
   * @returns Screenshot result with path and placeholder dimensions.
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const result = await this.#backend.screenshot();
    return {
      path: result.path ?? `${options.name}.${result.format}`,
      base64: '',
      width: 0,
      height: 0,
    };
  }

  /**
   * @returns Extension state with mobile-appropriate defaults.
   */
  async getAppState(): Promise<ExtensionState> {
    const appState = await this.#backend.getAppState(this.#bundleId);
    const isRunning = appState.state === 'Running' || appState.state === '4';
    return {
      isLoaded: isRunning,
      currentUrl: '',
      extensionId: this.#bundleId,
      isUnlocked: isRunning,
      currentScreen: 'unknown',
      accountAddress: null,
      networkName: null,
      chainId: null,
      balance: null,
    };
  }

  /**
   * @returns Empty string — no URL concept on mobile.
   */
  getCurrentUrl(): string {
    return '';
  }

  /**
   * @returns The device platform as a PlatformType.
   */
  getPlatform(): PlatformType {
    return this.#backend.platform;
  }
}

/**
 * Resolves a target selector to a DeviceBackend ElementQuery.
 *
 * @param targetType - The selector type (a11yRef, testId, selector).
 * @param targetValue - The selector value.
 * @param refMap - The ref-to-stable-identifier map from getAccessibilityTree.
 * @returns An ElementQuery suitable for DeviceBackend methods.
 */
function resolveTargetToQuery(
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): ElementQuery {
  switch (targetType) {
    case 'a11yRef': {
      const resolution = refMap.get(targetValue);
      if (!resolution) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
        );
      }
      return parseStableIdentifier(resolution);
    }
    case 'testId':
      return { identifier: targetValue };
    case 'selector':
      return { identifier: targetValue };
    default: {
      const _exhaustive: never = targetType;
      throw new Error(`Unknown target type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Parses a stable identifier string into an ElementQuery.
 *
 * @param stableId - String in "identifier:xxx", "label:xxx", or "value:xxx" format.
 * @returns The corresponding ElementQuery.
 */
function parseStableIdentifier(stableId: string): ElementQuery {
  const colonIndex = stableId.indexOf(':');
  if (colonIndex < 0) {
    return { identifier: stableId };
  }
  const prefix = stableId.slice(0, colonIndex);
  const value = stableId.slice(colonIndex + 1);

  switch (prefix) {
    case 'identifier':
      return { identifier: value };
    case 'label':
      return { label: value };
    case 'value':
      return { text: value };
    default:
      return { identifier: stableId };
  }
}

/**
 * Normalizes a UIElement hierarchy into A11yNodeTrimmed nodes with sequential refs.
 *
 * @param hierarchy - The raw UIElement tree from a device snapshot.
 * @returns Trimmed nodes and the ref-to-stable-identifier map.
 */
function normalizeSnapshot(hierarchy: UIElement[]): {
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
} {
  const nodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  let refCounter = 0;

  /**
   * @param elements - UIElement nodes to walk.
   * @param path - Accumulated ancestor roles.
   */
  function walk(elements: UIElement[], path: string[]): void {
    for (const el of elements) {
      refCounter += 1;
      const ref = `e${refCounter}`;
      const role = el.type || 'element';
      const name = el.label ?? el.value ?? '';

      const node: A11yNodeTrimmed = { ref, role, name, path };
      if (!el.enabled) {
        node.disabled = true;
      }
      if (el.identifier) {
        node.testId = el.identifier;
      }
      if (el.value && el.value !== name) {
        node.textContent = el.value;
      }
      nodes.push(node);

      if (el.identifier) {
        refMap.set(ref, `identifier:${el.identifier}`);
      } else if (el.label) {
        refMap.set(ref, `label:${el.label}`);
      } else if (el.value) {
        refMap.set(ref, `value:${el.value}`);
      }

      if (el.children?.length) {
        walk(el.children, [...path, role]);
      }
    }
  }

  walk(hierarchy, []);
  return { nodes, refMap };
}

/**
 * Recursively collects test IDs from a UIElement hierarchy.
 *
 * @param elements - The UIElement nodes to scan.
 * @param items - Accumulator for discovered test ID items.
 * @param max - Maximum number of items to collect.
 */
function collectTestIds(
  elements: UIElement[],
  items: TestIdItem[],
  max: number,
): void {
  for (const el of elements) {
    if (items.length >= max) {
      return;
    }
    if (el.identifier) {
      items.push({
        testId: el.identifier,
        tag: el.type || 'element',
        text: el.label ?? el.value,
        visible: true,
      });
    }
    if (el.children?.length) {
      collectTestIds(el.children, items, max);
    }
  }
}
