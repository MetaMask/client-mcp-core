/**
 * iOS Platform Driver
 *
 * Implements IPlatformDriver using XCUITestClient for iOS simulator automation.
 * Handles snapshot normalization, element resolution, coordinate-based tapping,
 * and polling for element visibility.
 *
 * This module contains NO Playwright imports.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { snapshotAxIos } from './ax-snapshot.js';
import { takeScreenshot } from './simctl.js';
import type { SnapshotNode } from './types.js';
import type { XCUITestClient } from './xcuitest-client.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../../capabilities/types.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../../mcp-server/types/discovery.js';
import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  PlatformScreenshotOptions,
  PlatformType,
} from '../types.js';

const DEFAULT_ANIMATION_DELAY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_SCREENSHOT_DIR = '/tmp/ios-screenshots';
const DEFAULT_APP_BUNDLE_ID = 'io.metamask.MetaMask';
const EMPTY_SNAPSHOT_REBIND_DELAY_MS = 300;
const DEFAULT_SNAPSHOT_BACKEND = 'xctest-with-ax-fallback';

type SnapshotBackend = 'xctest' | 'ax' | 'xctest-with-ax-fallback';

/**
 * Internal error thrown when an element is not found within the polling timeout.
 * Used to distinguish poll timeouts from other errors in waitForElement/click.
 */
class ElementNotFoundError extends Error {
  /** @param message - Descriptive error message including target and timeout. */
  constructor(message: string) {
    super(message);
    this.name = 'ElementNotFoundError';
  }
}

/**
 * Explicit allow-list of tools supported on iOS.
 * New tools must be added here to be usable on iOS.
 */
export const DEFAULT_SUPPORTED_IOS_TOOLS = new Set([
  'mm_click',
  'mm_type',
  'mm_wait_for',
  'mm_screenshot',
  'mm_accessibility_snapshot',
  'mm_list_testids',
  'mm_describe_screen',
  'mm_get_state',
  'mm_build',
  'mm_seed_contract',
  'mm_seed_contracts',
  'mm_get_contract_address',
  'mm_list_contracts',
  'mm_launch',
  'mm_cleanup',
  'mm_knowledge_last',
  'mm_knowledge_search',
  'mm_knowledge_summarize',
  'mm_knowledge_sessions',
  'mm_run_steps',
  'mm_set_context',
  'mm_get_context',
]);

/**
 * IOSPlatformDriver wraps XCUITestClient behind the IPlatformDriver interface
 * for iOS simulator automation.
 *
 * Element resolution works via accessibility identifiers (testIds),
 * a11y refs (mapped from snapshot normalization), and best-effort label/type matching.
 */
export class IOSPlatformDriver implements IPlatformDriver {
  readonly #animationDelayMs: number;

  readonly #screenshotDir: string;

  #client: XCUITestClient;

  readonly #deviceUdid: string;

  readonly #supportedTools: Set<string>;

  readonly #recoverRunner?: () => Promise<XCUITestClient>;

  readonly #appBundleId: string;

  readonly #snapshotBackend: SnapshotBackend;

  #recoveryInFlight: Promise<void> | undefined;

  #lastRecoveryError: unknown;

  /**
   * @param client - XCUITest client instance used for simulator commands.
   * @param deviceUdid - UDID of the target simulator device.
   * @param options - Optional animation delay, screenshot directory, and supported tools overrides.
   * @param options.animationDelayMs - Delay after taps to allow animations.
   * @param options.screenshotDir - Directory to save screenshots.
   * @param options.supportedTools - Set of tool names supported on iOS (defaults to DEFAULT_SUPPORTED_IOS_TOOLS).
   * @param options.recoverRunner
   * @param options.appBundleId
   * @param options.snapshotBackend
   */
  constructor(
    client: XCUITestClient,
    deviceUdid: string,
    options?: {
      animationDelayMs?: number;
      screenshotDir?: string;
      supportedTools?: Set<string>;
      recoverRunner?: () => Promise<XCUITestClient>;
      appBundleId?: string;
      snapshotBackend?: SnapshotBackend;
    },
  ) {
    this.#client = client;
    this.#deviceUdid = deviceUdid;
    this.#animationDelayMs =
      options?.animationDelayMs ?? DEFAULT_ANIMATION_DELAY_MS;
    this.#screenshotDir = options?.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;
    this.#supportedTools =
      options?.supportedTools ?? DEFAULT_SUPPORTED_IOS_TOOLS;
    this.#recoverRunner = options?.recoverRunner;
    this.#appBundleId = options?.appBundleId ?? DEFAULT_APP_BUNDLE_ID;
    this.#snapshotBackend =
      options?.snapshotBackend ?? DEFAULT_SNAPSHOT_BACKEND;
  }

  /**
   * @param targetType - Type of target selector (a11yRef, testId, or selector).
   * @param targetValue - The value of the target (ref ID, test ID, or selector).
   * @param refMap - Map of accessibility refs to resolved selectors.
   * @param timeoutMs - Maximum time to wait for element (0-60000ms).
   * @returns Promise resolving to click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<ClickActionResult> {
    const element = await this.#pollForElement(
      targetType,
      targetValue,
      refMap,
      timeoutMs,
    );

    // tapElement first: triggers proper keyboard/focus behavior via XCUITest element queries.
    // Coordinate tap fallback for React Native views not exposed to XCUITest queries.
    let tapped = false;
    if (element.identifier) {
      const { identifier } = element;
      try {
        await this.#withRunnerRecovery(
          async () => this.#client.tapElement(identifier),
          true,
        );
        tapped = true;
      } catch {
        /* element not queryable — fall through to coordinate tap */
      }
    }
    if (!tapped && element.label) {
      const { label } = element;
      try {
        await this.#withRunnerRecovery(
          async () => this.#client.tapElement(label),
          true,
        );
        tapped = true;
      } catch {
        /* element not queryable — fall through to coordinate tap */
      }
    }
    if (!tapped) {
      if (!element.rect) {
        throw new Error(
          `Element has no rect for tap: ${targetType}:${targetValue}`,
        );
      }
      const { x, y } = this.#calculateCenter(element.rect);
      await this.#withRunnerRecovery(async () => this.#client.tap(x, y), false);
    }
    await this.#sleep(this.#animationDelayMs);

    return {
      clicked: true,
      target: `${targetType}:${targetValue}`,
    };
  }

  /**
   * @param targetType - Type of target selector (a11yRef, testId, or selector).
   * @param targetValue - The value of the target (ref ID, test ID, or selector).
   * @param text - The text to type.
   * @param refMap - Map of accessibility refs to resolved selectors.
   * @param timeoutMs - Maximum time to wait for element (0-60000ms).
   * @returns Promise resolving to type result with success status and text length.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<TypeActionResult> {
    const element = await this.#pollForElement(
      targetType,
      targetValue,
      refMap,
      timeoutMs,
    );

    if (!element.rect) {
      throw new Error(
        `Element has no rect for fill: ${targetType}:${targetValue}`,
      );
    }

    const { x, y } = this.#calculateCenter(element.rect);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#withRunnerRecovery(() => this.#client.fill(x, y, text), false),
        new Promise<never>((_resolve, rejectTimeout) => {
          timeoutId = setTimeout(
            () =>
              rejectTimeout(
                new Error(
                  `Timeout typing into ${targetType}:${targetValue} (${timeoutMs}ms)`,
                ),
              ),
            Math.max(timeoutMs, 15_000),
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  /**
   * @param targetType - Type of target selector (a11yRef, testId, or selector).
   * @param targetValue - The value of the target (ref ID, test ID, or selector).
   * @param refMap - Map of accessibility refs to resolved selectors.
   * @param timeoutMs - Maximum time to wait for element (100-120000ms).
   * @returns Promise that resolves when element is found, or rejects on timeout.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<void> {
    try {
      await this.#pollForElement(targetType, targetValue, refMap, timeoutMs);
    } catch (error) {
      if (error instanceof ElementNotFoundError) {
        throw new Error(
          `Timeout waiting for element: ${targetType}:${targetValue} (${timeoutMs}ms)`,
        );
      }
      throw error;
    }
  }

  /**
   * @param rootSelector - Optional selector to scope the snapshot subtree.
   * @returns Promise resolving to accessibility tree and ref map.
   */
  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const snapshot = await this.#snapshotForDiscovery(
      rootSelector ? { scope: rootSelector } : undefined,
    );
    const nodes: A11yNodeTrimmed[] = [];
    const refMap = new Map<string, string>();

    this.#walkSnapshotRefs(snapshot, (node, ref, path, role) => {
      const name = node.label ?? node.value ?? '';

      const trimmed: A11yNodeTrimmed = { ref, role, name, path };
      if (node.enabled === false) {
        trimmed.disabled = true;
      }
      nodes.push(trimmed);

      if (node.identifier) {
        refMap.set(ref, `identifier:${node.identifier}`);
      } else if (node.label) {
        refMap.set(ref, `label:${node.label}`);
      } else if (node.value) {
        refMap.set(ref, `value:${node.value}`);
      }
    });

    return { nodes, refMap };
  }

  /**
   * @param limit - Maximum number of test IDs to return (default: 150).
   * @returns Promise resolving to array of test ID items.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const snapshot = await this.#snapshotForDiscovery();
    const items: TestIdItem[] = [];
    const maxItems = limit ?? 150;

    const walk = (nodes: SnapshotNode[]): void => {
      for (const node of nodes) {
        if (items.length >= maxItems) {
          return;
        }

        if (node.identifier) {
          items.push({
            testId: node.identifier,
            tag: node.type ?? 'element',
            text: node.label ?? node.value,
            visible: true,
          });
        }

        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      }
    };

    walk(snapshot);

    return items;
  }

  /**
   * @param options - Screenshot options (name, fullPage, selector, includeBase64).
   * @returns Promise resolving to screenshot result with path and dimensions.
   *          If includeBase64 is false, base64 is empty string and dimensions are 0.
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const safeName = basename(options.name).replace(/[^a-zA-Z0-9_-]/gu, '_');
    if (!safeName) {
      throw new Error('Invalid screenshot name');
    }
    const filename = `${safeName}.png`;
    const filepath = join(this.#screenshotDir, filename);

    await mkdir(this.#screenshotDir, { recursive: true });

    await takeScreenshot(this.#deviceUdid, filepath);

    // Only read file and compute base64 if explicitly requested
    if (options.includeBase64) {
      const buffer = await readFile(filepath);
      const base64 = buffer.toString('base64');

      // Parse PNG header (bytes 16-19: width, 20-23: height, big-endian uint32)
      const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 0;
      const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 0;

      return {
        path: filepath,
        base64,
        width,
        height,
      };
    }

    // When includeBase64 is false, skip file read and return empty base64 with 0 dimensions
    return {
      path: filepath,
      base64: '',
      width: 0,
      height: 0,
    };
  }

  /**
   * @returns Promise resolving to a minimal mobile extension state.
   */
  async getAppState(): Promise<ExtensionState> {
    return {
      isLoaded: true,
      currentUrl: '',
      extensionId: '',
      isUnlocked: true,
      currentScreen: 'unknown',
      accountAddress: null,
      networkName: null,
      chainId: null,
      balance: null,
    };
  }

  /**
   * @param toolName - Name of the tool to check.
   * @returns true if the tool is supported by iOS, false otherwise.
   */
  isToolSupported(toolName: string): boolean {
    return this.#supportedTools.has(toolName);
  }

  /**
   * @returns The current URL as a string (empty for iOS).
   */
  getCurrentUrl(): string {
    return '';
  }

  /**
   * @returns The platform type (ios).
   */
  getPlatform(): PlatformType {
    return 'ios';
  }

  /**
   * @param nodes - Snapshot nodes to search.
   * @param targetType - Target selector type.
   * @param targetValue - Target selector value.
   * @param refMap - Map of accessibility refs to selectors.
   * @returns The matched snapshot node, if found.
   */
  #findElement(
    nodes: SnapshotNode[],
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
  ): SnapshotNode | undefined {
    switch (targetType) {
      case 'testId':
        return this.#findByTestId(nodes, targetValue);
      case 'a11yRef':
        return this.#findByA11yRef(nodes, targetValue, refMap);
      case 'selector':
        return this.#findBySelector(nodes, targetValue);
      default:
        return undefined;
    }
  }

  /**
   * @param nodes - Snapshot nodes to search.
   * @param testId - Accessibility identifier to match.
   * @returns The matched snapshot node, if found.
   */
  #findByTestId(
    nodes: SnapshotNode[],
    testId: string,
  ): SnapshotNode | undefined {
    for (const node of nodes) {
      if (node.identifier === testId) {
        return node;
      }
      if (node.children) {
        const found = this.#findByTestId(node.children, testId);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  /**
   * @param nodes - Snapshot nodes to search.
   * @param ref - Accessibility reference from refMap.
   * @param refMap - Map of accessibility refs to selectors.
   * @returns The matched snapshot node, if found.
   */
  #findByA11yRef(
    nodes: SnapshotNode[],
    ref: string,
    refMap: Map<string, string>,
  ): SnapshotNode | undefined {
    const resolution = refMap.get(ref);
    if (!resolution) {
      return undefined;
    }

    return this.#findByStableIdentifier(nodes, resolution);
  }

  /**
   * Search for an element by its stable identifier string (e.g., "identifier:send-button").
   * This is used during polling to ensure element identity remains stable even if
   * the tree structure changes (elements added/removed).
   *
   * @param nodes - Snapshot nodes to search.
   * @param stableIdentifier - Resolved identifier string (e.g., "identifier:send-button" or "label:Settings").
   * @returns The matched snapshot node, if found.
   */
  #findByStableIdentifier(
    nodes: SnapshotNode[],
    stableIdentifier: string,
  ): SnapshotNode | undefined {
    const [type, ...valueParts] = stableIdentifier.split(':');
    const value = valueParts.join(':');

    const flat = this.#flattenNodes(nodes);

    if (type === 'identifier') {
      return flat.find((node) => node.identifier === value);
    }
    if (type === 'label') {
      return flat.find((node) => node.label === value);
    }
    if (type === 'value') {
      return flat.find((node) => node.value === value);
    }

    return undefined;
  }

  /**
   * @param targetType - Type of target selector (a11yRef, testId, or selector).
   * @param targetValue - The value of the target (ref ID, test ID, or selector).
   * @param refMap - Map of accessibility refs to resolved selectors.
   * @param timeoutMs - Maximum time to wait for element.
   * @returns The matched snapshot node.
   */
  async #pollForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<SnapshotNode> {
    const startTime = Date.now();

    // For a11yRef, resolve to stable identifier ONCE before polling loop
    // This ensures element identity is stable even if tree structure changes
    let stableIdentifier: string | undefined;
    if (targetType === 'a11yRef') {
      const resolution = refMap.get(targetValue);
      if (resolution) {
        stableIdentifier = resolution;
      }
    }

    while (Date.now() - startTime < timeoutMs) {
      let snapshot: SnapshotNode[];
      try {
        snapshot = await this.#snapshotForDiscovery();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('MM_IOS_RUNNER_RECOVERING') ||
          message.includes('MM_IOS_EMPTY_SNAPSHOT')
        ) {
          await this.#sleep(DEFAULT_POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }

      let element: SnapshotNode | undefined;
      if (targetType === 'a11yRef' && stableIdentifier) {
        // Search fresh snapshot using stable identifier directly
        element = this.#findByStableIdentifier(snapshot, stableIdentifier);
      } else {
        // For testId and selector, use normal lookup
        element = this.#findElement(snapshot, targetType, targetValue, refMap);
      }

      if (element) {
        return element;
      }

      await this.#sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    throw new ElementNotFoundError(
      `Element not found: ${targetType}:${targetValue} (timeout ${timeoutMs}ms)`,
    );
  }

  /**
   * @param nodes - Snapshot nodes to walk.
   * @param callback - Callback invoked for each node with ref metadata.
   */
  #walkSnapshotRefs(
    nodes: SnapshotNode[],
    callback: (
      node: SnapshotNode,
      ref: string,
      path: string[],
      role: string,
    ) => void,
  ): void {
    let refCounter = 0;

    const walk = (snapshotNodes: SnapshotNode[], path: string[]): void => {
      for (const node of snapshotNodes) {
        refCounter += 1;
        const ref = `e${refCounter}`;
        const role = node.type ?? 'element';
        callback(node, ref, path, role);

        if (node.children && node.children.length > 0) {
          walk(node.children, [...path, role]);
        }
      }
    };

    walk(nodes, []);
  }

  /**
   * Best-effort element lookup by selector string.
   *
   * iOS has no CSS selectors — the selector is matched against node properties
   * in priority order: `identifier` (accessibilityIdentifier / testId) first,
   * then `label` (accessibilityLabel), then `type` (element class name).
   *
   * @param nodes - Snapshot nodes to search.
   * @param selector - Selector to match against identifier, label, or type.
   * @returns The matched snapshot node, if found.
   */
  #findBySelector(
    nodes: SnapshotNode[],
    selector: string,
  ): SnapshotNode | undefined {
    const flat = this.#flattenNodes(nodes);

    return (
      flat.find((node) => node.identifier === selector) ??
      flat.find((node) => node.label === selector) ??
      flat.find((node) => node.type === selector)
    );
  }

  /**
   * @param nodes - Snapshot nodes to flatten.
   * @returns A flat list of all nodes in depth-first order.
   */
  #flattenNodes(nodes: SnapshotNode[]): SnapshotNode[] {
    const result: SnapshotNode[] = [];

    const walk = (nodeList: SnapshotNode[]): void => {
      for (const node of nodeList) {
        result.push(node);
        if (node.children) {
          walk(node.children);
        }
      }
    };

    walk(nodes);
    return result;
  }

  /**
   * @param rect - Element rectangle used for tap coordinate calculation.
   * @param rect.x - Rectangle x-coordinate.
   * @param rect.y - Rectangle y-coordinate.
   * @param rect.width - Rectangle width.
   * @param rect.height - Rectangle height.
   * @returns Center point coordinates for tapping.
   */
  #calculateCenter(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number } {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  }

  /**
   * @param ms - Milliseconds to sleep.
   * @returns Promise that resolves after delay.
   */
  async #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   *
   * @param operation
   * @param allowRecovery
   * @param fastFailOnRecovering
   */
  async #withRunnerRecovery<T>(
    operation: () => Promise<T>,
    allowRecovery: boolean,
    fastFailOnRecovering: boolean = false,
  ): Promise<T> {
    if (this.#recoveryInFlight) {
      if (fastFailOnRecovering) {
        throw this.#createRunnerRecoveringError();
      }
      await this.#recoveryInFlight;
    }

    try {
      return await operation();
    } catch (error) {
      if (!allowRecovery || !this.#recoverRunner) {
        throw error;
      }
      if (!this.#isRecoverableConnectionError(error)) {
        throw error;
      }

      if (fastFailOnRecovering) {
        this.#startRecoveryInBackground();
        throw this.#createRunnerRecoveringError();
      }

      this.#client = await this.#recoverRunner();
      this.#lastRecoveryError = undefined;
      return operation();
    }
  }

  /**
   *
   * @param options
   * @param options.interactiveOnly
   * @param options.compact
   * @param options.depth
   * @param options.scope
   */
  async #snapshotForDiscovery(options?: {
    interactiveOnly?: boolean;
    compact?: boolean;
    depth?: number;
    scope?: string;
  }): Promise<SnapshotNode[]> {
    if (this.#recoveryInFlight) {
      throw this.#createRunnerRecoveringError();
    }

    if (this.#snapshotBackend === 'ax') {
      const axOnly = await snapshotAxIos();
      if (axOnly.length > 0) {
        return axOnly;
      }
      throw new Error(
        'MM_IOS_EMPTY_SNAPSHOT: AX snapshot returned empty nodes',
      );
    }

    const initial = await this.#withRunnerRecovery(
      async () => this.#client.snapshot(options),
      true,
      true,
    );
    if (initial.length > 0) {
      return initial;
    }

    let lastAxError: unknown;

    if (this.#snapshotBackend === 'xctest-with-ax-fallback') {
      try {
        const axFallback = await snapshotAxIos();
        if (axFallback.length > 0) {
          return axFallback;
        }
      } catch (error) {
        lastAxError = error;
        console.warn('[IOSPlatformDriver] AX snapshot fallback failed', error);
      }
    }

    console.warn(
      `[IOSPlatformDriver] Empty snapshot; rebinding to ${this.#appBundleId} and retrying`,
    );
    try {
      await this.#withRunnerRecovery(
        async () => this.#client.bind(this.#appBundleId),
        true,
        true,
      );
      await this.#sleep(EMPTY_SNAPSHOT_REBIND_DELAY_MS);
      const rebound = await this.#withRunnerRecovery(
        async () => this.#client.snapshot(options),
        true,
        true,
      );
      if (rebound.length > 0) {
        return rebound;
      }

      if (this.#snapshotBackend === 'xctest-with-ax-fallback') {
        try {
          const reboundAxFallback = await snapshotAxIos();
          if (reboundAxFallback.length > 0) {
            return reboundAxFallback;
          }
        } catch (error) {
          lastAxError = error;
          console.warn(
            '[IOSPlatformDriver] AX snapshot fallback after rebind failed',
            error,
          );
        }
      }
    } catch (error) {
      console.warn('[IOSPlatformDriver] Snapshot rebind retry failed', error);
    }

    if (lastAxError instanceof Error) {
      if (lastAxError.message.includes('MM_IOS_AX_PERMISSION_REQUIRED')) {
        throw lastAxError;
      }
      if (lastAxError.message.includes('MM_IOS_AX_BINARY_MISSING')) {
        throw lastAxError;
      }
    }

    throw new Error(
      `MM_IOS_EMPTY_SNAPSHOT: discovery snapshot is empty after rebind (${this.#appBundleId})`,
    );
  }

  /**
   *
   */
  #startRecoveryInBackground(): void {
    if (!this.#recoverRunner || this.#recoveryInFlight) {
      return;
    }

    this.#recoveryInFlight = this.#recoverRunner()
      .then((client) => {
        this.#client = client;
        this.#lastRecoveryError = undefined;
      })
      .catch((error) => {
        this.#lastRecoveryError = error;
        console.warn(
          '[IOSPlatformDriver] Background runner recovery failed',
          error,
        );
      })
      .finally(() => {
        this.#recoveryInFlight = undefined;
      });
  }

  /**
   *
   */
  #createRunnerRecoveringError(): Error {
    const suffix = this.#lastRecoveryError
      ? ` Last recovery error: ${
          this.#lastRecoveryError instanceof Error
            ? this.#lastRecoveryError.message
            : String(this.#lastRecoveryError)
        }`
      : '';

    return new Error(
      `MM_IOS_RUNNER_RECOVERING: Runner recovery in progress.${suffix}`,
    );
  }

  /**
   *
   * @param error
   */
  #isRecoverableConnectionError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    return (
      message.includes('fetch failed') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('runner did not accept connection') ||
      message.includes('runner not ready')
    );
  }
}

/**
 * @param error - The thrown error to classify.
 * @returns Structured error with iOS-specific code and message.
 */
export function classifyIOSError(error: unknown): {
  code: string;
  message: string;
} {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (
    errorMessage.includes('Element not found') ||
    errorMessage.includes('Element has no rect')
  ) {
    return { code: 'MM_IOS_ELEMENT_NOT_FOUND', message: errorMessage };
  }
  if (errorMessage.includes('Timeout waiting for element')) {
    return { code: 'MM_IOS_ELEMENT_NOT_FOUND', message: errorMessage };
  }
  if (
    errorMessage.includes('Snapshot command failed') ||
    errorMessage.toLowerCase().includes('snapshot failed')
  ) {
    return { code: 'MM_IOS_SNAPSHOT_FAILED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_EMPTY_SNAPSHOT')) {
    return { code: 'MM_IOS_EMPTY_SNAPSHOT', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_PERMISSION_REQUIRED')) {
    return { code: 'MM_IOS_AX_PERMISSION_REQUIRED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_BINARY_MISSING')) {
    return { code: 'MM_IOS_AX_BINARY_MISSING', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_SNAPSHOT_FAILED')) {
    return { code: 'MM_IOS_AX_SNAPSHOT_FAILED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_RUNNER_RECOVERING')) {
    return { code: 'MM_IOS_RUNNER_RECOVERING', message: errorMessage };
  }
  if (errorMessage.includes('Runner') && errorMessage.includes('not ready')) {
    return { code: 'MM_IOS_RUNNER_NOT_READY', message: errorMessage };
  }
  return { code: 'MM_INTERNAL_ERROR', message: errorMessage };
}
