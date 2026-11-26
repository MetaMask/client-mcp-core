import type { BrowserContext, Page } from '@playwright/test';

import {
  CdpDomainInUseError,
  disposeCdpManager,
  getCdpManager,
} from './cdp-manager.js';
import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  ClickOptions,
  TypeActionResult,
  GetTextActionResult,
  HoverActionResult,
  InspectActionResult,
  PlatformScreenshotOptions,
  PlatformType,
  ScrollToElementOutcome,
  WithinScope,
} from './types.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';
import type { ISessionManager } from '../server/session-manager.js';
import { isPageClosedError } from '../tools/error-classification.js';
import type {
  TestIdItem,
  A11yNodeTrimmed,
  FrameSnapshotTarget,
} from '../tools/types/discovery.js';
import { ErrorCodes } from '../tools/types/errors.js';
import type { CdpInput } from '../tools/types/tool-inputs.js';
import type { CdpOutcome } from '../tools/types/tool-outputs.js';
import {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  MISSING_TARGET_WAIT_MS,
} from '../tools/utils/constants.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForTarget,
} from '../tools/utils/discovery.js';
import { findLabelForHiddenControl } from '../tools/utils/hidden-control.js';
import { inspectLocator } from '../tools/utils/inspect.js';

/**
 * Browser CDP methods that would destroy the page/session and break every
 * other tool. Kept intentionally small — `cdp` is an escape hatch, not a
 * sandbox.
 */
const CDP_BLOCKED_METHODS = new Set([
  'Browser.close',
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Browser.crashGpuProcess',
]);

/**
 * Platform driver implementation for Playwright-based browser automation.
 * Wraps existing Playwright interaction and discovery functions behind
 * the IPlatformDriver interface for cross-platform tool delegation.
 */
export class PlaywrightPlatformDriver implements IPlatformDriver {
  readonly #getPage: () => Page;

  readonly #sessionManager: ISessionManager;

  #cdpContext: BrowserContext | undefined;

  /**
   * @param getPage - Getter for the current active Playwright page.
   * @param sessionManager - The session manager for screenshot and state delegation.
   */
  constructor(getPage: () => Page, sessionManager: ISessionManager) {
    this.#getPage = getPage;
    this.#sessionManager = sessionManager;
  }

  /**
   * Detaches the persistent CDP sessions owned by this driver. Idempotent;
   * does not close the browser.
   */
  async dispose(): Promise<void> {
    const context = this.#cdpContext;
    this.#cdpContext = undefined;
    if (context) {
      await disposeCdpManager(context);
    }
  }

  /**
   * Click an element, handling page-closed errors as successful navigation clicks.
   *
   * @param targetType - The type of target identifier (a11yRef, testId, selector).
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds for the interaction.
   * @param within - Optional parent scope for chained locator resolution.
   * @param signal - When aborted during the target wait, throws instead of
   * clicking.
   * @param options - `failFastWhenMissing` fails after a short wait when the
   * target matches no element; `dismissKeyboard` is ignored.
   * @returns The click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
    signal?: AbortSignal,
    options?: ClickOptions,
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
      options?.failFastWhenMissing
        ? { missingTargetWaitMs: MISSING_TARGET_WAIT_MS }
        : undefined,
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timeout ${timeoutMs}ms exceeded: visibility wait consumed entire budget for ${targetType}:${targetValue}`,
      );
    }

    // The request may have timed out while we waited for the target.
    signal?.throwIfAborted();
    const label = await findLabelForHiddenControl(locator, remaining);
    const labelResult = label ? { clickedLabel: true } : {};
    signal?.throwIfAborted();
    try {
      await (label ?? locator).click({ timeout: remaining });
    } catch (error) {
      if (isPageClosedError(error)) {
        return {
          clicked: true,
          target: `${targetType}:${targetValue}`,
          pageClosedAfterClick: true,
          ...labelResult,
        };
      }
      throw error;
    }

    return {
      clicked: true,
      target: `${targetType}:${targetValue}`,
      ...labelResult,
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
   * @param signal - When aborted during the target wait, throws instead of
   * typing.
   * @returns The type result with success status and text length.
   */
  async type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
    signal?: AbortSignal,
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

    signal?.throwIfAborted();
    // `fill` waits for a read-only or disabled element to become editable,
    // until the timeout. `isEditable` checks once.
    if (!(await locator.isEditable({ timeout: remaining }))) {
      const reason = (await locator.isDisabled({ timeout: remaining }))
        ? 'disabled'
        : 'readonly';
      throw new Error(
        `element is not editable (${reason}): ${targetType}:${targetValue}`,
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
   * Scroll an element into view after waiting for visibility.
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param _direction - Unused on the browser (mobile swipe direction).
   * @param _maxAttempts - Unused on the browser (mobile swipe attempts).
   * @param timeoutMs - Maximum time in milliseconds.
   * @param within - Optional parent scope.
   * @returns An empty outcome (swipe details are mobile only).
   */
  async scrollToElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    _direction?: 'up' | 'down' | 'auto',
    _maxAttempts?: number,
    timeoutMs: number = DEFAULT_INTERACTION_TIMEOUT_MS,
    within?: WithinScope,
  ): Promise<ScrollToElementOutcome> {
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

    await locator.scrollIntoViewIfNeeded({ timeout: remaining });
    return {};
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
   * Read an element's attributes, disabled and read-only flags, and computed
   * styles (see `inspectLocator`).
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds.
   * @param styles - Computed style properties to read.
   * @param within - Optional parent scope.
   * @returns The inspection and target descriptor.
   */
  async inspect(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    styles: string[],
    within?: WithinScope,
  ): Promise<InspectActionResult> {
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

    const inspection = await inspectLocator(page, locator, styles, remaining);
    return { target: `${targetType}:${targetValue}`, ...inspection };
  }

  /**
   * Move the pointer over an element after waiting for visibility. Like a
   * click, Playwright scrolls it into view and waits until no other element
   * covers it.
   *
   * @param targetType - The type of target identifier.
   * @param targetValue - The target value used for element lookup.
   * @param refMap - Map of a11y refs to selectors.
   * @param timeoutMs - Maximum time in milliseconds.
   * @param within - Optional parent scope.
   * @param signal - When aborted during the target wait, throws instead of
   * hovering.
   * @returns The hover result and target descriptor.
   */
  async hover(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
    signal?: AbortSignal,
  ): Promise<HoverActionResult> {
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

    signal?.throwIfAborted();
    await locator.hover({ timeout: remaining });
    return { hovered: true, target: `${targetType}:${targetValue}` };
  }

  /**
   * Capture the trimmed accessibility tree with deterministic refs.
   *
   * @param rootSelector - Optional CSS selector to scope the snapshot.
   * @param frame - Optional iframe element and ref prefix: snapshot only
   * its content.
   * @returns The accessibility nodes and ref-to-selector map.
   */
  async getAccessibilityTree(
    rootSelector?: string,
    frame?: FrameSnapshotTarget,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const page = this.#getPage();
    return collectTrimmedA11ySnapshot(page, rootSelector, frame);
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
   * @param options - Screenshot options (name, fullPage, selector, timeoutMs).
   * @returns Screenshot result with path and dimensions.
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    if (options.selector !== undefined) {
      // A missing target must fail as a target error, not as a screenshot
      // timeout at Playwright's 30 s default (the daemon queue limit).
      await waitForTarget(
        this.#getPage(),
        'selector',
        options.selector,
        new Map(),
        options.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
        undefined,
        { missingTargetWaitMs: MISSING_TARGET_WAIT_MS },
      );
    }
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
   * Send a raw Chrome DevTools Protocol command against a browser target.
   * The browser exposes the full Chrome CDP surface (Runtime, DOM, Network,
   * Page, ...). Destructive methods are blocked.
   *
   * The default target is the active page, on a persistent session shared
   * across calls (so domains enabled by one call stay enabled for the next).
   * `target: 'sw'` sends the command to the Extension service worker.
   * `fresh: true` uses a one-shot session that is detached afterwards.
   *
   * @param input - The CDP method, params, per-command timeout, and target.
   * The `metroPort` / `appId` / `urlFilter` fields are mobile-only and
   * ignored here; the mobile targets are rejected.
   * @returns A discriminated outcome carrying the raw CDP result or an error.
   */
  async cdp(input: CdpInput): Promise<CdpOutcome> {
    if (CDP_BLOCKED_METHODS.has(input.method)) {
      return {
        ok: false,
        code: ErrorCodes.MM_CDP_BLOCKED,
        message:
          `CDP method "${input.method}" is blocked because it would destroy the browser session. ` +
          `Blocked methods: ${[...CDP_BLOCKED_METHODS].join(', ')}`,
      };
    }

    const target = input.target ?? 'page';
    if (target === 'hermes' || target === 'android-webview') {
      return {
        ok: false,
        code: ErrorCodes.MM_INVALID_INPUT,
        message:
          `CDP target "${target}" is mobile only. ` +
          'Browser targets: page, sw.',
      };
    }

    const page = this.#getPage();
    const context = page.context();
    this.#cdpContext ??= context;

    try {
      const result = await getCdpManager(context).send(
        target === 'sw' ? { kind: 'sw' } : { kind: 'page', page },
        input.method,
        input.params ?? {},
        { timeoutMs: input.timeoutMs, fresh: input.fresh === true },
      );
      return { ok: true, result };
    } catch (error) {
      if (error instanceof CdpDomainInUseError) {
        return {
          ok: false,
          code: ErrorCodes.MM_CDP_BLOCKED,
          message: error.message,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: ErrorCodes.MM_CDP_FAILED,
        message: `CDP "${input.method}" failed: ${message}`,
      };
    }
  }
}
