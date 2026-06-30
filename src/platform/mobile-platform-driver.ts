import type {
  DeviceBackend,
  DeviceButton,
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
import { OBSERVATION_TESTID_LIMIT } from '../tools/utils/constants.js';

const DEFAULT_BUNDLE_ID = 'io.metamask';
const APPIUM_STATE_RUNNING_IN_FOREGROUND = '4';

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
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @returns Click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<ClickActionResult> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    const remaining = deadline - Date.now();
    await withTimeout(this.#backend.tapElement(query), remaining, 'tapElement');
    return { clicked: true, target: `${targetType}:${targetValue}` };
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param text - Text to type into the element.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @returns Type result with success status and text length.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<TypeActionResult> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    let remaining = deadline - Date.now();
    await withTimeout(this.#backend.tapElement(query), remaining, 'tapElement');
    remaining = deadline - Date.now();
    await withTimeout(this.#backend.typeText(text), remaining, 'typeText');
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
   * @param within - Must be undefined — scoped search is not supported on mobile.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<void> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @returns The element's text content, target descriptor, and length.
   */
  async getText(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<GetTextActionResult> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    const remaining = deadline - Date.now();
    const text = await withTimeout(
      this.#backend.getElementText(query),
      remaining,
      'getElementText',
    );
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
    const max = limit ?? OBSERVATION_TESTID_LIMIT;
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
    const isRunning =
      appState.state === 'Running' ||
      appState.state === APPIUM_STATE_RUNNING_IN_FOREGROUND;
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

  // ---- Mobile-specific ----

  /**
   * @param direction - Swipe direction.
   * @param startX - Optional start X coordinate.
   * @param startY - Optional start Y coordinate.
   * @param distance - Optional swipe distance in pixels.
   */
  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    await this.#backend.swipe(direction, startX, startY, distance);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param direction - Scroll direction (default: down).
   * @param maxAttempts - Maximum scroll attempts.
   */
  async scrollToElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    direction?: 'up' | 'down',
    maxAttempts?: number,
  ): Promise<void> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.scrollToElement(query, direction, maxAttempts);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param durationMs - Press duration in milliseconds.
   */
  async longPress(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    durationMs?: number,
  ): Promise<void> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.longPress(query, durationMs);
  }

  /**
   * @param coordX - X coordinate in pixels.
   * @param coordY - Y coordinate in pixels.
   */
  async tapCoordinates(coordX: number, coordY: number): Promise<void> {
    await this.#backend.tapCoordinates(coordX, coordY);
  }

  /**
   * Hides the on-screen keyboard.
   */
  async dismissKeyboard(): Promise<void> {
    await this.#backend.dismissKeyboard();
  }

  /**
   * @param accept - True to accept, false to dismiss.
   */
  async dismissAlert(accept: boolean): Promise<void> {
    await this.#backend.dismissAlert(accept);
  }

  /**
   * @returns The text content of the current system alert.
   */
  async getAlertText(): Promise<string> {
    return this.#backend.getAlertText();
  }

  /**
   * @returns The device screen dimensions.
   */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    return this.#backend.getWindowSize();
  }

  /**
   * @param bundleId - App bundle ID to launch.
   */
  async openApp(bundleId: string): Promise<void> {
    await this.#backend.openApp(bundleId);
  }

  /**
   * @param bundleId - App bundle ID to terminate.
   */
  async closeApp(bundleId: string): Promise<void> {
    await this.#backend.closeApp(bundleId);
  }

  /**
   * @param button - Device button name (home, back, enter, lock).
   */
  async pressButton(button: string): Promise<void> {
    await this.#backend.pressButton(button as DeviceButton);
  }

  /**
   * @returns Available app contexts (NATIVE_APP, WEBVIEW_*, etc.).
   */
  async getDeviceContexts(): Promise<string[]> {
    return this.#backend.getContexts();
  }

  /**
   * @param contextName - Context to switch to (e.g. NATIVE_APP, WEBVIEW_1).
   */
  async setDeviceContext(contextName: string): Promise<void> {
    await this.#backend.setContext(contextName);
  }

  /**
   * @returns Current clipboard text.
   */
  async getClipboard(): Promise<string> {
    return this.#backend.getClipboard();
  }

  /**
   * @param text - Text to write to the device clipboard.
   */
  async setClipboard(text: string): Promise<void> {
    await this.#backend.setClipboard(text);
  }

  /**
   * @param outputPath - Optional file path for the recording.
   */
  async startScreenRecording(outputPath?: string): Promise<void> {
    await this.#backend.startScreenRecording(outputPath);
  }

  /**
   * @returns File path of the saved recording.
   */
  async stopScreenRecording(): Promise<string> {
    return this.#backend.stopScreenRecording();
  }

  /**
   * @param durationSeconds - Seconds of logs to retrieve.
   * @param filter - Text pattern to filter log entries.
   * @returns Filtered log entries.
   */
  async getLogs(
    durationSeconds?: number,
    filter?: string,
  ): Promise<{
    entries: { timestamp: string; level: string; message: string }[];
    source: string;
  }> {
    return this.#backend.getLogs(durationSeconds, filter);
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
      throw new Error(
        'CSS selectors are not supported on mobile. Use testId or a11yRef instead.',
      );
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
  const segments = stableId.split('|');
  const core = segments[0] as string;

  const colonIndex = core.indexOf(':');
  if (colonIndex < 0) {
    return { identifier: core };
  }
  const prefix = core.slice(0, colonIndex);
  const value = core.slice(colonIndex + 1);

  let query: ElementQuery;
  switch (prefix) {
    case 'identifier':
      query = { identifier: value };
      break;
    case 'label':
      query = { label: value };
      break;
    case 'value':
      query = { text: value };
      break;
    default:
      query = { identifier: core };
      break;
  }

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string;
    const segColonIndex = segment.indexOf(':');
    if (segColonIndex < 0) {
      continue;
    }
    const key = segment.slice(0, segColonIndex);
    const val = segment.slice(segColonIndex + 1);
    if (key === 'type') {
      query.type = val;
    }
  }

  return query;
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
  const stableIdCount = new Map<string, string[]>();
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

      let stableId: string | undefined;
      if (el.identifier) {
        stableId = `identifier:${el.identifier}`;
      } else if (el.label) {
        stableId = `label:${el.label}|type:${role}`;
      } else if (el.value) {
        stableId = `value:${el.value}|type:${role}`;
      }

      if (stableId) {
        refMap.set(ref, stableId);
        const refs = stableIdCount.get(stableId) ?? [];
        refs.push(ref);
        stableIdCount.set(stableId, refs);
      }

      if (el.children?.length) {
        walk(el.children, [...path, role]);
      }
    }
  }

  walk(hierarchy, []);

  for (const refs of stableIdCount.values()) {
    if (refs.length > 1) {
      for (const ref of refs) {
        const node = nodes.find((nd) => nd.ref === ref);
        if (node) {
          node.ambiguous = true;
        }
      }
    }
  }

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

/**
 * @param within - The within scope to validate.
 */
function rejectWithinScope(within: WithinScope | undefined): void {
  if (within) {
    throw new Error(
      'Scoped element search (within) is not supported on mobile. ' +
        'Target elements directly by testId or a11yRef.',
    );
  }
}

/**
 * @param promise - The operation to race against the deadline.
 * @param remainingMs - Milliseconds remaining in the timeout budget.
 * @param operationName - Label for the timeout error message.
 * @returns The result of the promise if it resolves within the budget.
 */
async function withTimeout<TResult>(
  promise: Promise<TResult>,
  remainingMs: number,
  operationName: string,
): Promise<TResult> {
  if (remainingMs <= 0) {
    throw new Error(`Timeout exceeded before ${operationName}`);
  }
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout exceeded during ${operationName}`)),
        remainingMs,
      ),
    ),
  ]);
}
