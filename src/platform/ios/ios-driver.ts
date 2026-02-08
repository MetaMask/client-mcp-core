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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  PlatformScreenshotOptions,
  PlatformType,
} from '../types.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../../mcp-server/types/discovery.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../../capabilities/types.js';
import type { XCUITestClient } from './xcuitest-client.js';
import type { SnapshotNode } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_ANIMATION_DELAY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_SCREENSHOT_DIR = '/tmp/ios-screenshots';

const UNSUPPORTED_TOOLS = new Set([
  'mm_clipboard',
  'mm_switch_to_tab',
  'mm_close_tab',
  'mm_wait_for_notification',
]);

/**
 * IOSPlatformDriver wraps XCUITestClient behind the IPlatformDriver interface
 * for iOS simulator automation.
 *
 * Element resolution works via accessibility identifiers (testIds),
 * a11y refs (mapped from snapshot normalization), and best-effort label/type matching.
 */
export class IOSPlatformDriver implements IPlatformDriver {
  private readonly animationDelayMs: number;

  private readonly screenshotDir: string;

  constructor(
    private readonly client: XCUITestClient,
    private readonly deviceUdid: string,
    options?: {
      animationDelayMs?: number;
      screenshotDir?: string;
    },
  ) {
    this.animationDelayMs =
      options?.animationDelayMs ?? DEFAULT_ANIMATION_DELAY_MS;
    this.screenshotDir = options?.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;
  }

  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<ClickActionResult> {
    const snapshot = await this.client.snapshot();
    const element = this.findElement(snapshot, targetType, targetValue, refMap);

    if (!element) {
      throw new Error(
        `Element not found: ${targetType}:${targetValue} (timeout ${timeoutMs}ms)`,
      );
    }

    if (!element.rect) {
      throw new Error(
        `Element has no rect for tap: ${targetType}:${targetValue}`,
      );
    }

    const { x, y } = this.calculateCenter(element.rect);
    await this.client.tap(x, y);
    await this.sleep(this.animationDelayMs);

    return {
      clicked: true,
      target: `${targetType}:${targetValue}`,
    };
  }

  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<TypeActionResult> {
    await this.click(targetType, targetValue, refMap, timeoutMs);
    await this.client.type(text);

    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const snapshot = await this.client.snapshot();
      const element = this.findElement(
        snapshot,
        targetType,
        targetValue,
        refMap,
      );

      if (element) {
        return;
      }

      await this.sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timeout waiting for element: ${targetType}:${targetValue} (${timeoutMs}ms)`,
    );
  }

  async getAccessibilityTree(
    _rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const snapshot = await this.client.snapshot();
    const nodes: A11yNodeTrimmed[] = [];
    const refMap = new Map<string, string>();
    let refCounter = 0;

    const walk = (snapshotNodes: SnapshotNode[], path: string[]): void => {
      for (const node of snapshotNodes) {
        refCounter++;
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

  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const snapshot = await this.client.snapshot();
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

  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const filename = `${options.name}.png`;
    const filepath = join(this.screenshotDir, filename);

    await execFileAsync('xcrun', [
      'simctl',
      'io',
      this.deviceUdid,
      'screenshot',
      filepath,
    ]);

    const buffer = await readFile(filepath);
    const base64 = buffer.toString('base64');

    return {
      path: filepath,
      base64,
      width: 0,
      height: 0,
    };
  }

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

  isToolSupported(toolName: string): boolean {
    return !UNSUPPORTED_TOOLS.has(toolName);
  }

  getCurrentUrl(): string {
    return '';
  }

  getPlatform(): PlatformType {
    return 'ios';
  }

  private findElement(
    nodes: SnapshotNode[],
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
  ): SnapshotNode | undefined {
    switch (targetType) {
      case 'testId':
        return this.findByTestId(nodes, targetValue);
      case 'a11yRef':
        return this.findByA11yRef(nodes, targetValue, refMap);
      case 'selector':
        return this.findBySelector(nodes, targetValue);
      default:
        return undefined;
    }
  }

  private findByTestId(
    nodes: SnapshotNode[],
    testId: string,
  ): SnapshotNode | undefined {
    for (const node of nodes) {
      if (node.identifier === testId) {
        return node;
      }
      if (node.children) {
        const found = this.findByTestId(node.children, testId);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  private findByA11yRef(
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

    const flat = this.flattenNodes(nodes);

    if (type === 'identifier') {
      return flat.find((n) => n.identifier === value);
    }
    if (type === 'label') {
      return flat.find((n) => n.label === value);
    }

    return undefined;
  }

  private findBySelector(
    nodes: SnapshotNode[],
    selector: string,
  ): SnapshotNode | undefined {
    const flat = this.flattenNodes(nodes);

    return (
      flat.find((n) => n.label === selector) ??
      flat.find((n) => n.type === selector)
    );
  }

  private flattenNodes(nodes: SnapshotNode[]): SnapshotNode[] {
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

  private calculateCenter(rect: {
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

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
