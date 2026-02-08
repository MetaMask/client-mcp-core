/**
 * Platform Driver Interface and Types
 *
 * Defines the abstract interface for platform-specific drivers (browser, iOS, etc.)
 * that handle element interaction, discovery, and screenshots.
 *
 * This module is platform-agnostic and contains NO Playwright imports.
 * Concrete implementations (e.g., PlaywrightPlatformDriver) will provide the actual logic.
 */

import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../mcp-server/types/discovery.js';
import type { ScreenshotResult, ExtensionState } from '../capabilities/types.js';

/**
 * Supported platform types.
 */
export type PlatformType = 'browser' | 'ios';

/**
 * Target types for element selection.
 * Reused from discovery patterns to maintain consistency.
 */
export type TargetType = 'a11yRef' | 'testId' | 'selector';

/**
 * Result of a click action.
 *
 * @property clicked - Whether the click was successful
 * @property target - The resolved selector/target that was clicked
 * @property pageClosedAfterClick - Optional flag indicating if the page closed after the click
 */
export type ClickActionResult = {
  clicked: boolean;
  target: string;
  pageClosedAfterClick?: boolean;
};

/**
 * Result of a type action.
 *
 * @property typed - Whether the text was successfully typed
 * @property target - The resolved selector/target where text was typed
 * @property textLength - The length of the text that was typed
 */
export type TypeActionResult = {
  typed: boolean;
  target: string;
  textLength: number;
};

/**
 * Screenshot options for platform drivers.
 * Platform-agnostic, not Playwright-specific.
 *
 * @property name - Screenshot filename (without extension)
 * @property fullPage - Optional flag to capture full page (default: true)
 * @property selector - Optional CSS selector to capture specific element
 */
export type PlatformScreenshotOptions = {
  name: string;
  fullPage?: boolean;
  selector?: string;
};

/**
 * Platform Driver Interface
 *
 * Defines the contract for platform-specific drivers that handle:
 * - Element interaction (click, type, wait)
 * - Discovery (accessibility tree, test IDs)
 * - Screenshots
 * - State management
 *
 * Implementations must support both browser and iOS platforms.
 */
export type IPlatformDriver = {
  /**
   * Click an element on the page.
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (0-60000ms)
   * @returns Promise resolving to click result with success status and target info
   */
  click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<ClickActionResult>;

  /**
   * Type text into an input element.
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param text - The text to type
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (0-60000ms)
   * @returns Promise resolving to type result with success status and text length
   */
  type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<TypeActionResult>;

  /**
   * Wait for an element to become visible.
   *
   * @param targetType - Type of target selector (a11yRef, testId, or CSS selector)
   * @param targetValue - The value of the target (ref ID, test ID, or selector string)
   * @param refMap - Map of accessibility refs to resolved selectors
   * @param timeoutMs - Maximum time to wait for element (100-120000ms)
   * @returns Promise that resolves when element is found, or rejects on timeout
   */
  waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
  ): Promise<void>;

  /**
   * Get the accessibility tree for the current page.
   *
   * Returns a trimmed accessibility tree with deterministic refs (e1, e2, ...).
   * Refs can be used with click() and type() methods.
   *
   * @param rootSelector - Optional CSS selector to scope the snapshot
   * @returns Promise resolving to accessibility tree and ref map
   */
  getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }>;

  /**
   * Get all visible test IDs on the current page.
   *
   * @param limit - Maximum number of test IDs to return (default: 150)
   * @returns Promise resolving to array of test ID items
   */
  getTestIds(limit?: number): Promise<TestIdItem[]>;

  /**
   * Capture a screenshot of the current page.
   *
   * @param options - Screenshot options (name, fullPage, selector)
   * @returns Promise resolving to screenshot result with path and dimensions
   */
  screenshot(options: PlatformScreenshotOptions): Promise<ScreenshotResult>;

  /**
   * Get the current extension state.
   *
   * Returns state including loaded status, current URL, extension ID,
   * unlock status, current screen, account address, network, chain ID, and balance.
   *
   * @returns Promise resolving to extension state
   */
  getAppState(): Promise<ExtensionState>;

  /**
   * Check if a specific tool is supported by this driver.
   *
   * @param toolName - Name of the tool to check (e.g., "screenshot", "click")
   * @returns true if the tool is supported, false otherwise
   */
  isToolSupported(toolName: string): boolean;

  /**
   * Get the current URL of the active page.
   *
   * @returns The current URL as a string
   */
  getCurrentUrl(): string;

  /**
   * Get the platform type this driver is running on.
   *
   * @returns The platform type (browser or ios)
   */
  getPlatform(): PlatformType;
};
