import type { Page } from '@playwright/test';

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
import type { ISessionManager } from '../server/session-manager.js';
import { isPageClosedError } from '../tools/error-classification.js';
import type { TestIdItem, A11yNodeTrimmed } from '../tools/types/discovery.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForTarget,
} from '../tools/utils/discovery.js';

/**
 * Platform driver implementation for Playwright-based browser automation.
 * Wraps existing Playwright interaction and discovery functions behind
 * the IPlatformDriver interface for cross-platform tool delegation.
 */
export class PlaywrightPlatformDriver implements IPlatformDriver {
  readonly #getPage: () => Page;

  readonly #sessionManager: ISessionManager;

  /**
   * @param getPage - Getter for the current active Playwright page.
   * @param sessionManager - The session manager for screenshot and state delegation.
   */
  constructor(getPage: () => Page, sessionManager: ISessionManager) {
    this.#getPage = getPage;
    this.#sessionManager = sessionManager;
  }

  /**
   * Click an element, handling page-closed errors as successful navigation clicks.
   *
   * @param targetType - The type of target identifier (a11yRef, testId, selector).
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds for the interaction.
   * @param within - Optional parent scope for chained locator resolution.
   * @returns The click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<ClickActionResult> {
    const page = this.#getPage();
    const deadline = Date.now() + timeoutMs;

    const locator = await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
      within,
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timeout ${timeoutMs}ms exceeded: visibility wait consumed entire budget for ${targetType}:${targetValue}`,
      );
    }

    try {
      await locator.click({ timeout: remaining });
    } catch (error) {
      if (isPageClosedError(error)) {
        return {
          clicked: true,
          target: `${targetType}:${targetValue}`,
          pageClosedAfterClick: true,
        };
      }
      throw error;
    }

    return {
      clicked: true,
      target: `${targetType}:${targetValue}`,
    };
  }

  /**
   * Type text into an input element after waiting for visibility.
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param text - The text to type into the input.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds.
   * @param within - Optional parent scope.
   * @returns The type result with success status and text length.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<TypeActionResult> {
    const page = this.#getPage();
    const deadline = Date.now() + timeoutMs;

    const locator = await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
      within,
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timeout ${timeoutMs}ms exceeded: visibility wait consumed entire budget for ${targetType}:${targetValue}`,
      );
    }

    await locator.fill(text, { timeout: remaining });

    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  /**
   * Wait for an element to become visible on the page.
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds.
   * @param within - Optional parent scope.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<void> {
    const page = this.#getPage();
    await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
      within,
    );
  }

  /**
   * Read the text content of an element.
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds.
   * @param within - Optional parent scope.
   * @returns The text content, target descriptor, and character length.
   */
  async getText(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<GetTextActionResult> {
    const page = this.#getPage();
    const deadline = Date.now() + timeoutMs;

    const locator = await waitForTarget(
      page,
      targetType,
      targetValue,
      refMap,
      timeoutMs,
      within,
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timeout ${timeoutMs}ms exceeded: visibility wait consumed entire budget for ${targetType}:${targetValue}`,
      );
    }

    const text = (await locator.textContent({ timeout: remaining })) ?? '';

    return {
      text,
      target: `${targetType}:${targetValue}`,
      length: text.length,
    };
  }

  /**
   * Capture the trimmed accessibility tree with deterministic refs.
   *
   * @param rootSelector - Optional CSS selector to scope the snapshot.
   * @returns The accessibility nodes and ref-to-selector map.
   */
  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const page = this.#getPage();
    return collectTrimmedA11ySnapshot(page, rootSelector);
  }

  /**
   * Collect visible test IDs from the current page.
   *
   * @param limit - Maximum number of test IDs to return.
   * @returns Array of test ID items.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const page = this.#getPage();
    return collectTestIds(page, limit ?? 150);
  }

  /**
   * Capture a screenshot of the current page.
   *
   * @param options - Screenshot options (name, fullPage, selector).
   * @returns Screenshot result with path and dimensions.
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
   * @returns The extension state including URL, screen, network, balance.
   */
  async getAppState(): Promise<ExtensionState> {
    return this.#sessionManager.getExtensionState();
  }

  /**
   * Get the current page URL.
   *
   * @returns The URL of the active page.
   */
  getCurrentUrl(): string {
    return this.#getPage().url();
  }

  /**
   * Get the platform type.
   *
   * @returns 'browser' for this driver.
   */
  getPlatform(): PlatformType {
    return 'browser';
  }

  /**
   * Check whether a tool is supported by the browser driver.
   *
   * Browser remains the fully capable default platform; browser-only gating is
   * handled by the registry/server layer for non-browser drivers.
   *
   * @returns Always true for browser automation.
   */
  isToolSupported(): boolean {
    return true;
  }
}
