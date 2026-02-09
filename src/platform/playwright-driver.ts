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
import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForTarget,
} from '../mcp-server/discovery.js';
import type { ISessionManager } from '../mcp-server/session-manager.js';
import { isPageClosedError } from '../mcp-server/tools/error-classification.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../mcp-server/types/discovery.js';

/**
 * PlaywrightPlatformDriver wraps existing Playwright-based discovery and interaction
 * functions behind the IPlatformDriver interface.
 *
 * All methods delegate to the same underlying functions used by current tool handlers,
 * ensuring zero behavior change.
 */
export class PlaywrightPlatformDriver implements IPlatformDriver {
  readonly #getPage: () => Page;

  readonly #sessionManager: ISessionManager;

  /**
   * @param getPage - Getter function for the current active Playwright Page.
   *   Uses a getter so it always retrieves the current active page.
   * @param sessionManager - The session manager for screenshot and state delegation.
   */
  constructor(getPage: () => Page, sessionManager: ISessionManager) {
    this.#getPage = getPage;
    this.#sessionManager = sessionManager;
  }

  /**
   * Click an element on the page.
   *
   * Delegates to waitForTarget() to resolve and wait for the element,
   * then calls locator.click(). Handles page-closed errors gracefully,
   * matching the behavior in interaction.ts:88-103.
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (0-60000ms)
   * @returns Promise resolving to click result with success status and target info
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<ClickActionResult> {
    const page = this.#getPage();
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
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param text - The text to type
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (0-60000ms)
   * @returns Promise resolving to type result with success status and text length
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<TypeActionResult> {
    const page = this.#getPage();
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
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (100-120000ms)
   * @returns Promise that resolves when element is found, or rejects on timeout
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<void> {
    const page = this.#getPage();
    await waitForTarget(page, targetType, targetValue, refMap, timeoutMs);
  }

  /**
   * Get the accessibility tree for the current page.
   *
   * Delegates to collectTrimmedA11ySnapshot() from discovery.ts.
   *
   * @param rootSelector - Optional CSS selector to scope the snapshot
   * @returns Promise resolving to accessibility tree and ref map
   */
  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const page = this.#getPage();
    return collectTrimmedA11ySnapshot(page, rootSelector);
  }

  /**
   * Get all visible test IDs on the current page.
   *
   * Delegates to collectTestIds() from discovery.ts.
   *
   * @param limit - Maximum number of test IDs to return (default: 150)
   * @returns Promise resolving to array of test ID items
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const page = this.#getPage();
    return collectTestIds(page, limit);
  }

  /**
   * Capture a screenshot of the current page.
   *
   * Delegates to sessionManager.screenshot().
   *
   * @param options - Screenshot options (name, fullPage, selector)
   * @returns Promise resolving to screenshot result with path and dimensions
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    return this.#sessionManager.screenshot({
      name: options.name,
      fullPage: options.fullPage,
      selector: options.selector,
    });
  }

  /**
   * Get the current extension state.
   *
   * Delegates to sessionManager.getExtensionState().
   *
   * @returns Promise resolving to extension state
   */
  async getAppState(): Promise<ExtensionState> {
    return this.#sessionManager.getExtensionState();
  }

  /**
   * Check if a specific tool is supported by this driver.
   *
   * Browser supports all tools, so always returns true.
   *
   * @param _toolName - Name of the tool to check
   * @returns true if the tool is supported
   */
  isToolSupported(_toolName: string): boolean {
    return true;
  }

  /**
   * Get the current URL of the active page.
   *
   * @returns The current URL as a string
   */
  getCurrentUrl(): string {
    return this.#getPage().url();
  }

  /**
   * Get the platform type this driver is running on.
   *
   * @returns The platform type (browser)
   */
  getPlatform(): PlatformType {
    return 'browser';
  }
}
