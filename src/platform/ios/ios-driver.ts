/**
 * iOS Platform Driver
 *
 * Implements IPlatformDriver using XCUITestClient for iOS simulator automation.
 * Handles snapshot normalization, element resolution, coordinate-based tapping,
 * and polling for element visibility.
 *
 * This module contains NO Playwright imports.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);

const DEFAULT_ANIMATION_DELAY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_SCREENSHOT_DIR = '/tmp/ios-screenshots';

const UNSUPPORTED_TOOLS = new Set([
  'mm_clipboard',
  'mm_switch_to_tab',
  'mm_close_tab',
  'mm_wait_for_notification',
  'mm_navigate',
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

  readonly #client: XCUITestClient;

  readonly #deviceUdid: string;

  /**
   * @param client - XCUITest client instance used for simulator commands.
   * @param deviceUdid - UDID of the target simulator device.
   * @param options - Optional animation delay and screenshot directory overrides.
   * @param options.animationDelayMs - Delay after taps to allow animations.
   * @param options.screenshotDir - Directory to save screenshots.
   */
  constructor(
    client: XCUITestClient,
    deviceUdid: string,
    options?: {
      animationDelayMs?: number;
      screenshotDir?: string;
    },
  ) {
    this.#client = client;
    this.#deviceUdid = deviceUdid;
    this.#animationDelayMs =
      options?.animationDelayMs ?? DEFAULT_ANIMATION_DELAY_MS;
    this.#screenshotDir = options?.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;
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
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const snapshot = await this.#client.snapshot();
      const element = this.#findElement(
        snapshot,
        targetType,
        targetValue,
        refMap,
      );

      if (element) {
        if (!element.rect) {
          throw new Error(
            `Element has no rect for tap: ${targetType}:${targetValue}`,
          );
        }

        const { x, y } = this.#calculateCenter(element.rect);
        await this.#client.tap(x, y);
        await this.#sleep(this.#animationDelayMs);

        return {
          clicked: true,
          target: `${targetType}:${targetValue}`,
        };
      }

      await this.#sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Element not found: ${targetType}:${targetValue} (timeout ${timeoutMs}ms)`,
    );
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
    await this.click(targetType, targetValue, refMap, timeoutMs);
    await this.#client.type(text);

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
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const snapshot = await this.#client.snapshot();
      const element = this.#findElement(
        snapshot,
        targetType,
        targetValue,
        refMap,
      );

      if (element) {
        return;
      }

      await this.#sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timeout waiting for element: ${targetType}:${targetValue} (${timeoutMs}ms)`,
    );
  }

  /**
   * @param rootSelector - Optional selector to scope the snapshot subtree.
   * @returns Promise resolving to accessibility tree and ref map.
   */
  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const snapshot = await this.#client.snapshot(
      rootSelector ? { scope: rootSelector } : undefined,
    );
    const nodes: A11yNodeTrimmed[] = [];
    const refMap = new Map<string, string>();
    let refCounter = 0;

    const walk = (snapshotNodes: SnapshotNode[], path: string[]): void => {
      for (const node of snapshotNodes) {
        refCounter += 1;
        const ref = `e${refCounter}`;

        const role = node.type ?? 'element';
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
        }

        if (node.children && node.children.length > 0) {
          walk(node.children, [...path, role]);
        }
      }
    };

    walk(snapshot, []);

    return { nodes, refMap };
  }

  /**
   * @param limit - Maximum number of test IDs to return (default: 150).
   * @returns Promise resolving to array of test ID items.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const snapshot = await this.#client.snapshot();
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
   * @param options - Screenshot options (name, fullPage, selector).
   * @returns Promise resolving to screenshot result with path and dimensions.
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const filename = `${options.name}.png`;
    const filepath = join(this.#screenshotDir, filename);

    await mkdir(this.#screenshotDir, { recursive: true });

    await execFileAsync('xcrun', [
      'simctl',
      'io',
      this.#deviceUdid,
      'screenshot',
      filepath,
    ]);

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
    return !UNSUPPORTED_TOOLS.has(toolName);
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

    const [type, ...valueParts] = resolution.split(':');
    const value = valueParts.join(':');

    const flat = this.#flattenNodes(nodes);

    if (type === 'identifier') {
      return flat.find((node) => node.identifier === value);
    }
    if (type === 'label') {
      return flat.find((node) => node.label === value);
    }

    return undefined;
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
    errorMessage.includes('snapshot')
  ) {
    return { code: 'MM_IOS_SNAPSHOT_FAILED', message: errorMessage };
  }
  if (errorMessage.includes('Runner') && errorMessage.includes('not ready')) {
    return { code: 'MM_IOS_RUNNER_NOT_READY', message: errorMessage };
  }
  return { code: 'MM_INTERNAL_ERROR', message: errorMessage };
}
