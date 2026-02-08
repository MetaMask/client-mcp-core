/**
 * Playwright Platform Driver
 *
 * Implements IPlatformDriver by wrapping existing Playwright-based functions
 * from discovery.ts and delegating to ISessionManager for screenshots and state.
 *
 * This is a pure wrapper — zero behavior change from existing tool handlers.
 */

import type { Page } from '@playwright/test';

import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  PlatformScreenshotOptions,
  PlatformType,
} from './types.js';
import type { ISessionManager } from '../mcp-server/session-manager.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForTarget,
} from '../mcp-server/discovery.js';
import { isPageClosedError } from '../mcp-server/tools/error-classification.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../mcp-server/types/discovery.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';

/**
 * PlaywrightPlatformDriver wraps existing Playwright-based discovery and interaction
 * functions behind the IPlatformDriver interface.
 *
 * All methods delegate to the same underlying functions used by current tool handlers,
 * ensuring zero behavior change.
 */
export class PlaywrightPlatformDriver implements IPlatformDriver {
  /**
   * @param getPage - Getter function for the current active Playwright Page.
   *   Uses a getter so it always retrieves the current active page.
   * @param sessionManager - The session manager for screenshot and state delegation.
   */
  constructor(
    private readonly getPage: () => Page,
    private readonly sessionManager: ISessionManager,
  ) {}

  /**
   * Click an element on the page.
   *
   * Delegates to waitForTarget() to resolve and wait for the element,
   * then calls locator.click(). Handles page-closed errors gracefully,
   * matching the behavior in interaction.ts:88-103.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<ClickActionResult> {
    const page = this.getPage();
    const locator = await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
    );

    try {
      await locator.click();
      return {
        clicked: true,
        target: `${targetType}:${targetValue}`,
      };
    } catch (clickError) {
      if (isPageClosedError(clickError)) {
        return {
          clicked: true,
          target: `${targetType}:${targetValue}`,
          pageClosedAfterClick: true,
        };
      }
      throw clickError;
    }
  }

  /**
   * Type text into an input element.
   *
   * Delegates to waitForTarget() to resolve and wait for the element,
   * then calls locator.fill(text), matching interaction.ts:174-188.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<TypeActionResult> {
    const page = this.getPage();
    const locator = await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
    );
    await locator.fill(text);

    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  /**
   * Wait for an element to become visible.
   *
   * Delegates to waitForTarget() which resolves the element and waits
   * for visibility. The returned locator is discarded.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<void> {
    const page = this.getPage();
    await waitForTarget(page, targetType, targetValue, refMap, timeoutMs);
  }

  /**
   * Get the accessibility tree for the current page.
   *
   * Delegates to collectTrimmedA11ySnapshot() from discovery.ts.
   */
  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const page = this.getPage();
    return collectTrimmedA11ySnapshot(page, rootSelector);
  }

  /**
   * Get all visible test IDs on the current page.
   *
   * Delegates to collectTestIds() from discovery.ts.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const page = this.getPage();
    return collectTestIds(page, limit);
  }

  /**
   * Capture a screenshot of the current page.
   *
   * Delegates to sessionManager.screenshot().
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    return this.sessionManager.screenshot({
      name: options.name,
      fullPage: options.fullPage,
      selector: options.selector,
    });
  }

  /**
   * Get the current extension state.
   *
   * Delegates to sessionManager.getExtensionState().
   */
  async getAppState(): Promise<ExtensionState> {
    return this.sessionManager.getExtensionState();
  }

  /**
   * Check if a specific tool is supported by this driver.
   *
   * Browser supports all tools, so always returns true.
   */
  isToolSupported(_toolName: string): boolean {
    return true;
  }

  /**
   * Get the current URL of the active page.
   */
  getCurrentUrl(): string {
    return this.getPage().url();
  }

  /**
   * Get the platform type this driver is running on.
   */
  getPlatform(): PlatformType {
    return 'browser';
  }
}
