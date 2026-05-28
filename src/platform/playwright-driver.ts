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
import type { TestIdItem, A11yNodeTrimmed } from '../tools/types/discovery.js';
import {
  isPageClosedError,
} from '../tools/error-classification.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForTarget,
} from '../tools/utils/discovery.js';

export class PlaywrightPlatformDriver implements IPlatformDriver {
  readonly #getPage: () => Page;

  readonly #sessionManager: ISessionManager;

  constructor(getPage: () => Page, sessionManager: ISessionManager) {
    this.#getPage = getPage;
    this.#sessionManager = sessionManager;
  }

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

    const remaining = Math.max(deadline - Date.now(), 0);

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

    const remaining = Math.max(deadline - Date.now(), 0);
    await locator.fill(text, { timeout: remaining });

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

    const remaining = Math.max(deadline - Date.now(), 0);
    const text = (await locator.textContent({ timeout: remaining })) ?? '';

    return {
      text,
      target: `${targetType}:${targetValue}`,
      length: text.length,
    };
  }

  async getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const page = this.#getPage();
    return collectTrimmedA11ySnapshot(page, rootSelector);
  }

  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const page = this.#getPage();
    return collectTestIds(page, limit ?? 150);
  }

  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    return this.#sessionManager.screenshot({
      name: options.name,
      fullPage: options.fullPage,
      selector: options.selector,
    });
  }

  async getAppState(): Promise<ExtensionState> {
    return this.#sessionManager.getExtensionState();
  }

  isToolSupported(_toolName: string): boolean {
    return true;
  }

  getCurrentUrl(): string {
    return this.#getPage().url();
  }

  getPlatform(): PlatformType {
    return 'browser';
  }
}
