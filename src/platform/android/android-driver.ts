/**
 * Android Platform Driver
 *
 * Stub implementation of IPlatformDriver for Android.
 * All methods throw "Android support not yet implemented" except getPlatform() and isToolSupported().
 */

import type {
  ScreenshotResult,
  ExtensionState,
} from '../../capabilities/types.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
} from '../../tools/types/discovery.js';
import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  PlatformScreenshotOptions,
  PlatformType,
} from '../types.js';

const NOT_IMPLEMENTED = 'Android support not yet implemented';

/**
 * AndroidPlatformDriver is a stub implementation of IPlatformDriver.
 * It implements all required methods but throws "not implemented" errors
 * for all operations except getPlatform() and isToolSupported().
 */
export class AndroidPlatformDriver implements IPlatformDriver {
  /**
   * Get the platform type this driver is running on.
   *
   * @returns The platform type (android)
   */
  getPlatform(): PlatformType {
    return 'android';
  }

  /**
   * Check if a specific tool is supported by this driver.
   *
   * Android does not support any tools yet.
   *
   * @param _toolName - Name of the tool to check
   * @returns false (no tools supported)
   */
  isToolSupported(_toolName: string): boolean {
    return false;
  }

  /**
   * Click an element on the page.
   *
   * @param _targetType - Target type (ignored in stub).
   * @param _targetValue - Target value (ignored in stub).
   * @param _refMap - Reference map (ignored in stub).
   * @param _timeoutMs - Timeout in ms (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async click(
    _targetType: TargetType,
    _targetValue: string,
    _refMap: Map<string, string>,
    _timeoutMs: number,
  ): Promise<ClickActionResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Type text into an input element.
   *
   * @param _targetType - Target type (ignored in stub).
   * @param _targetValue - Target value (ignored in stub).
   * @param _text - Text to type (ignored in stub).
   * @param _refMap - Reference map (ignored in stub).
   * @param _timeoutMs - Timeout in ms (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async type(
    _targetType: TargetType,
    _targetValue: string,
    _text: string,
    _refMap: Map<string, string>,
    _timeoutMs: number,
  ): Promise<TypeActionResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Wait for an element to become visible.
   *
   * @param _targetType - Target type (ignored in stub).
   * @param _targetValue - Target value (ignored in stub).
   * @param _refMap - Reference map (ignored in stub).
   * @param _timeoutMs - Timeout in ms (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async waitForElement(
    _targetType: TargetType,
    _targetValue: string,
    _refMap: Map<string, string>,
    _timeoutMs: number,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Get the accessibility tree for the current page.
   *
   * @param _rootSelector - Root selector (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async getAccessibilityTree(
    _rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Get all visible test IDs on the current page.
   *
   * @param _limit - Maximum number of IDs (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async getTestIds(_limit?: number): Promise<TestIdItem[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Capture a screenshot of the current page.
   *
   * @param _options - Screenshot options (ignored in stub).
   * @throws Error - Android support not yet implemented
   */
  async screenshot(
    _options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Get the current extension state.
   *
   * @throws Error - Android support not yet implemented
   */
  async getAppState(): Promise<ExtensionState> {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * Get the current URL of the active page.
   *
   * @throws Error - Android support not yet implemented
   */
  getCurrentUrl(): string {
    throw new Error(NOT_IMPLEMENTED);
  }
}
