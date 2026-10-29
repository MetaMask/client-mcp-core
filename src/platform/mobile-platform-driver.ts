import {
  runHermesCdp,
  HermesSession,
  fetchDiscoveryTargets,
  selectHermesTarget,
  hasAmbiguousTarget,
  generateLocators,
  LEGACY_SYNTHETIC_TITLE,
} from '@metamask/device-mcp';
import type {
  DeviceBackend,
  ElementQuery,
  HermesTarget,
  UIElement,
} from '@metamask/device-mcp';

import {
  filterAppHierarchy,
  pruneLayoutOnly,
  viewportFromHierarchy,
} from './mobile-hierarchy.js';
import type { Viewport } from './mobile-hierarchy.js';
import type {
  IPlatformDriver,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  GetTextActionResult,
  PlatformScreenshotOptions,
  PlatformType,
  ScreenCapture,
  WithinScope,
} from './types.js';
import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';
import type { TestIdItem, A11yNodeTrimmed } from '../tools/types/discovery.js';
import { ErrorCodes } from '../tools/types/errors.js';
import type {
  CdpInput,
  DeviceButtonName,
  HermesTargetsInput,
} from '../tools/types/tool-inputs.js';
import type {
  CdpOutcome,
  ElementLocatorInfo,
  HermesTargetInfo,
  HermesTargetsResult,
} from '../tools/types/tool-outputs.js';
import { OBSERVATION_TESTID_LIMIT } from '../tools/utils/constants.js';

const DEFAULT_BUNDLE_ID = 'io.metamask';
const APPIUM_STATE_RUNNING_IN_FOREGROUND = '4';
const HERMES_DISCOVERY_TIMEOUT_MS = 10_000;
const HERMES_MULTIPLE_DEVICES_CODE = 'HERMES_MULTIPLE_DEVICES';
// device-mcp returns this code for its destructive-method blocklist
// (Runtime.terminateExecution, Inspector.detached); mirror it to MM_CDP_BLOCKED
// so the agent-facing contract matches the browser driver.
const HERMES_BLOCKED_METHOD_CODE = 'HERMES_BLOCKED_METHOD';
// device-mcp returns this code for the WebView destructive-method blocklist
// (Browser.close, Target.closeTarget, etc.); mirror it to MM_CDP_BLOCKED so the
// agent-facing contract matches the browser and Hermes drivers.
const WEBVIEW_BLOCKED_METHOD_CODE = 'WEBVIEW_BLOCKED_METHOD';

/** Options of `MobilePlatformDriver`. */
export type MobilePlatformDriverOptions = {
  /**
   * Remove the Expo DevLauncher "Tools" button of development builds from
   * the accessibility tree and the test IDs. Default true.
   */
  excludeDevOverlay?: boolean;
};

/**
 * Platform driver for mobile devices backed by @metamask/device-mcp.
 * Wraps DeviceBackend behind the IPlatformDriver interface so the
 * tool layer can interact with iOS/Android devices using the same
 * API it uses for Playwright browser sessions.
 */
export class MobilePlatformDriver implements IPlatformDriver {
  readonly #backend: DeviceBackend;

  readonly #bundleId: string;

  // Scoped to this driver instance rather than the process-wide
  // getHermesSession() singleton so the pinned Hermes deviceId cannot leak
  // across mobile sessions (e.g. a relaunch against a different simulator).
  readonly #hermesSession: HermesSession;

  readonly #excludeDevOverlay: boolean;

  #windowSize: Viewport | undefined;

  #disposing: Promise<void> | undefined;

  /**
   * @param backend - The device-mcp backend to delegate to.
   * @param bundleId - The app bundle ID for getAppState calls.
   * @param options - Driver options.
   * @param options.excludeDevOverlay - Remove the Expo DevLauncher "Tools"
   * button of development builds from the accessibility tree and the test
   * IDs (default true). Android System UI (status bar, navigation bar) is
   * always removed.
   */
  constructor(
    backend: DeviceBackend,
    bundleId: string = DEFAULT_BUNDLE_ID,
    options: MobilePlatformDriverOptions = {},
  ) {
    this.#backend = backend;
    this.#bundleId = bundleId;
    this.#hermesSession = new HermesSession({ platform: backend.platform });
    this.#excludeDevOverlay = options.excludeDevOverlay ?? true;
  }

  /** Release only this backend's resources; compatible with older device-mcp releases. */
  async dispose(): Promise<void> {
    const backend = this.#backend as DeviceBackend & {
      dispose?(): Promise<void>;
    };
    this.#disposing ??= Promise.resolve()
      .then(async () => backend.dispose?.())
      .catch((error: unknown) => {
        this.#disposing = undefined;
        throw error;
      });
    await this.#disposing;
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @param signal - When aborted during the target wait, throws instead of
   * tapping. device-mcp takes no signal: a wait or tap that is already
   * running inside the backend is not cancelled.
   * @returns Click result with success status and target info.
   */
  async click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
    signal?: AbortSignal,
  ): Promise<ClickActionResult> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    // The request may have timed out while we waited for the target.
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    await withTimeout(this.#backend.tapElement(query), remaining, 'tapElement');
    return { clicked: true, target: `${targetType}:${targetValue}` };
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param text - Text to type into the element.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @param signal - When aborted during the target wait or after the focus
   * tap, throws instead of tapping or typing. device-mcp takes no signal: a
   * wait, tap or typeText that is already running is not cancelled.
   * @returns Type result with success status and text length.
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
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    signal?.throwIfAborted();
    let remaining = deadline - Date.now();
    await withTimeout(this.#backend.tapElement(query), remaining, 'tapElement');
    signal?.throwIfAborted();
    remaining = deadline - Date.now();
    await withTimeout(this.#backend.typeText(text), remaining, 'typeText');
    return {
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: text.length,
    };
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   */
  async waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<void> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.waitForElement(query, timeoutMs);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param timeoutMs - Maximum wait time in milliseconds.
   * @param within - Must be undefined — scoped search is not supported on mobile.
   * @returns The element's text content, target descriptor, and length.
   */
  async getText(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<GetTextActionResult> {
    rejectWithinScope(within);
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    const deadline = Date.now() + timeoutMs;
    await this.#backend.waitForElement(query, timeoutMs);
    const remaining = deadline - Date.now();
    const text = await withTimeout(
      this.#backend.getElementText(query),
      remaining,
      'getElementText',
    );
    return {
      text,
      target: `${targetType}:${targetValue}`,
      length: text.length,
    };
  }

  /**
   * @param _rootSelector - Unused on mobile — no CSS selectors.
   * @returns Accessibility nodes and ref-to-identifier map.
   */
  async getAccessibilityTree(
    _rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }> {
    const { hierarchy } = await this.#snapshotApp();
    return normalizeSnapshot(hierarchy, this.#backend.platform);
  }

  /**
   * @param limit - Maximum number of test IDs to return.
   * @returns Array of test ID items with identifiers from the UI hierarchy.
   * Visibility reflects whether each element's frame intersects the device
   * viewport; elements with unknown geometry are assumed visible.
   */
  async getTestIds(limit?: number): Promise<TestIdItem[]> {
    const { hierarchy, viewport } = await this.#snapshotApp();
    return this.#testIdsOf(hierarchy, viewport, limit);
  }

  /**
   * Takes one device snapshot and returns its accessibility tree and test
   * IDs, so both describe the same screen.
   *
   * @returns The nodes, refMap and a test ID reader for the same snapshot.
   */
  async captureScreen(): Promise<ScreenCapture> {
    const { hierarchy, viewport } = await this.#snapshotApp();
    return {
      ...normalizeSnapshot(hierarchy, this.#backend.platform),
      getTestIds: async (limit?: number) =>
        this.#testIdsOf(hierarchy, viewport, limit),
    };
  }

  /**
   * Takes one device snapshot, reads the viewport from it, and removes the
   * elements that are not part of the app (see `filterAppHierarchy`), so the
   * tree, the refs and the test IDs all use the same filtered hierarchy.
   *
   * @returns The filtered hierarchy and the viewport of the snapshot.
   */
  async #snapshotApp(): Promise<{
    hierarchy: UIElement[];
    viewport: Viewport | undefined;
  }> {
    const snapshot = await this.#backend.snapshot();
    const { platform } = this.#backend;
    return {
      hierarchy: filterAppHierarchy(snapshot.hierarchy, {
        platform,
        excludeDevOverlay: this.#excludeDevOverlay,
      }),
      viewport: viewportFromHierarchy(snapshot.hierarchy, platform),
    };
  }

  /**
   * @param hierarchy - The filtered UIElement tree of a snapshot.
   * @param snapshotViewport - The viewport read from that snapshot, if any.
   * @param limit - Maximum number of test IDs to return.
   * @returns The test IDs, with visibility against the device viewport.
   */
  async #testIdsOf(
    hierarchy: UIElement[],
    snapshotViewport: Viewport | undefined,
    limit?: number,
  ): Promise<TestIdItem[]> {
    const items: TestIdItem[] = [];
    const max = limit ?? OBSERVATION_TESTID_LIMIT;
    const viewport = snapshotViewport ?? (await this.#cachedWindowSize());
    collectTestIds(hierarchy, items, max, viewport);
    return items;
  }

  /**
   * The device window size, read from the backend once per driver (a device
   * round trip: `idb describe` / `adb shell wm size`). Only used when a
   * snapshot has no top-level frame to read the viewport from. A failed read
   * is not cached. The cached size is never invalidated, so after a rotation
   * it keeps the old orientation; snapshots with root frames (all idb and
   * adb snapshots seen so far) do not use it.
   *
   * @returns The window size, or undefined when the backend cannot read it.
   */
  async #cachedWindowSize(): Promise<Viewport | undefined> {
    if (!this.#windowSize) {
      try {
        this.#windowSize = await this.#backend.getWindowSize();
      } catch {
        // Without a viewport we cannot judge visibility; report everything.
        return undefined;
      }
    }
    return this.#windowSize;
  }

  /**
   * @param options - Screenshot options.
   * @returns Screenshot result with the path and optional base64 data.
   */
  async screenshot(
    options: PlatformScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const includeBase64 = options.includeBase64 === true;
    const result = await this.#backend.screenshot(undefined, {
      encode: includeBase64,
    });
    return {
      path: result.path ?? `${options.name}.${result.format}`,
      base64: result.data ?? '',
    };
  }

  /**
   * Reads only what the device backend knows: whether the app is running.
   * Wallet fields (unlock, screen, account, network, balance) are omitted
   * rather than guessed, and `source: 'stub'` marks the result as partial.
   *
   * @returns The partial app state.
   */
  async getAppState(): Promise<ExtensionState> {
    const appState = await this.#backend.getAppState(this.#bundleId);
    const isRunning =
      appState.state === 'Running' ||
      appState.state === APPIUM_STATE_RUNNING_IN_FOREGROUND;
    return {
      isLoaded: isRunning,
      extensionId: this.#bundleId,
      source: 'stub',
    };
  }

  /**
   * @returns Empty string — no URL concept on mobile.
   */
  getCurrentUrl(): string {
    return '';
  }

  /**
   * @returns The device platform as a PlatformType.
   */
  getPlatform(): PlatformType {
    return this.#backend.platform;
  }

  // ---- Mobile-specific ----

  /**
   * @param direction - Swipe direction.
   * @param startX - Optional start X coordinate.
   * @param startY - Optional start Y coordinate.
   * @param distance - Optional swipe distance in pixels.
   */
  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    await this.#backend.swipe(direction, startX, startY, distance);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param direction - Scroll direction (default: down).
   * @param maxAttempts - Maximum scroll attempts.
   */
  async scrollToElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    direction?: 'up' | 'down',
    maxAttempts?: number,
  ): Promise<void> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.scrollToElement(query, direction, maxAttempts);
  }

  /**
   * @param targetType - Target identifier type.
   * @param targetValue - Target value for element lookup.
   * @param refMap - Map of a11y refs to stable identifiers.
   * @param durationMs - Press duration in milliseconds.
   */
  async longPress(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    durationMs?: number,
  ): Promise<void> {
    const query = resolveTargetToQuery(targetType, targetValue, refMap);
    await this.#backend.longPress(query, durationMs);
  }

  /**
   * @param coordX - X coordinate in pixels.
   * @param coordY - Y coordinate in pixels.
   */
  async tapCoordinates(coordX: number, coordY: number): Promise<void> {
    await this.#backend.tapCoordinates(coordX, coordY);
  }

  /**
   * Hides the on-screen keyboard.
   */
  async dismissKeyboard(): Promise<void> {
    await this.#backend.dismissKeyboard();
  }

  /**
   * @param accept - True to accept, false to dismiss.
   */
  async dismissAlert(accept: boolean): Promise<void> {
    await this.#backend.dismissAlert(accept);
  }

  /**
   * @returns The text content of the current system alert.
   */
  async getAlertText(): Promise<string> {
    return this.#backend.getAlertText();
  }

  /**
   * @returns The device screen dimensions.
   */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    return this.#backend.getWindowSize();
  }

  /**
   * @param bundleId - App bundle ID to launch.
   */
  async openApp(bundleId: string): Promise<void> {
    await this.#backend.openApp(bundleId);
  }

  /**
   * @param bundleId - App bundle ID to terminate.
   */
  async closeApp(bundleId: string): Promise<void> {
    await this.#backend.closeApp(bundleId);
  }

  /**
   * @param button - Device button name (home, back, enter, lock).
   */
  async pressButton(button: DeviceButtonName): Promise<void> {
    await this.#backend.pressButton(button);
  }

  /**
   * @returns Available app contexts (NATIVE_APP, WEBVIEW_*, etc.).
   */
  async getDeviceContexts(): Promise<string[]> {
    return this.#backend.getContexts();
  }

  /**
   * @param contextName - Context to switch to (e.g. NATIVE_APP, WEBVIEW_1).
   */
  async setDeviceContext(contextName: string): Promise<void> {
    await this.#backend.setContext(contextName);
  }

  /**
   * @returns Current clipboard text.
   */
  async getClipboard(): Promise<string> {
    return this.#backend.getClipboard();
  }

  /**
   * @param text - Text to write to the device clipboard.
   */
  async setClipboard(text: string): Promise<void> {
    await this.#backend.setClipboard(text);
  }

  /**
   * @param outputPath - Optional file path for the recording.
   */
  async startScreenRecording(outputPath?: string): Promise<void> {
    await this.#backend.startScreenRecording(outputPath);
  }

  /**
   * @returns File path of the saved recording.
   */
  async stopScreenRecording(): Promise<string> {
    return this.#backend.stopScreenRecording();
  }

  /**
   * @param durationSeconds - Seconds of logs to retrieve.
   * @param filter - Text pattern to filter log entries.
   * @returns Filtered log entries.
   */
  async getLogs(
    durationSeconds?: number,
    filter?: string,
  ): Promise<{
    entries: { timestamp: string; level: string; message: string }[];
    source: string;
  }> {
    return this.#backend.getLogs(durationSeconds, filter);
  }

  /**
   * Send a raw Chrome DevTools Protocol command to a mobile CDP target.
   *
   * Two targets are supported, selected by `input.target`:
   * - `'hermes'` (default): the app's React Native Hermes JS runtime via
   *   Metro's inspector proxy. Exposes only the JS-engine CDP subset (Runtime,
   *   Debugger, Log, HeapProfiler) — no DOM/Page/Network. Works on iOS and
   *   Android. This path is unchanged and is what local development relies on.
   * - `'android-webview'`: a debuggable in-app Android WebView via adb. Exposes
   *   the full Chrome surface (Runtime, DOM, Page, Network, Input). Android
   *   only.
   *
   * @param input - The CDP method, params, timeout, and optional target /
   * Metro / appId / urlFilter overrides.
   * @returns A discriminated outcome carrying the raw CDP result or an error.
   */
  async cdp(input: CdpInput): Promise<CdpOutcome> {
    if (input.target === 'android-webview') {
      return this.#webviewCdp(input);
    }
    return this.#hermesCdp(input);
  }

  /**
   * Drives the React Native Hermes JS runtime via Metro. Unchanged behavior.
   *
   * @param input - The CDP command input.
   * @returns A discriminated CDP outcome.
   */
  async #hermesCdp(input: CdpInput): Promise<CdpOutcome> {
    const session = this.#hermesSession;
    const resolved = session.resolve({
      metroPort: input.metroPort,
      appId: input.appId,
      platform: this.#backend.platform,
    });

    const outcome = await runHermesCdp({
      method: input.method,
      params: input.params,
      timeoutMs: input.timeoutMs,
      metroPort: resolved.metroPort,
      appId: resolved.appId,
      pinnedDeviceId: resolved.pinnedDeviceId,
      onPin: (logicalDeviceId) => {
        if (session.getPinnedHermesDeviceId() === undefined) {
          session.setPinnedHermesDeviceId(logicalDeviceId);
        }
      },
    });

    if (outcome.ok) {
      return { ok: true, result: outcome.result };
    }
    return {
      ok: false,
      code:
        outcome.code === HERMES_BLOCKED_METHOD_CODE
          ? ErrorCodes.MM_CDP_BLOCKED
          : ErrorCodes.MM_CDP_FAILED,
      message: `[${outcome.code}] ${outcome.message}`,
    };
  }

  /**
   * Drives a debuggable in-app Android WebView via the device-mcp backend.
   *
   * @param input - The CDP command input, honoring an optional urlFilter.
   * @returns A discriminated CDP outcome.
   */
  async #webviewCdp(input: CdpInput): Promise<CdpOutcome> {
    if (!this.#backend.webviewCdp) {
      return {
        ok: false,
        code: ErrorCodes.MM_CDP_FAILED,
        message:
          'WebView CDP is not available on this session. It requires an ' +
          'Android (adb) device with a debuggable in-app WebView.',
      };
    }

    const outcome = await this.#backend.webviewCdp({
      method: input.method,
      params: input.params,
      timeoutMs: input.timeoutMs,
      urlFilter: input.urlFilter,
    });

    if (outcome.ok) {
      return { ok: true, result: outcome.result };
    }
    return {
      ok: false,
      code:
        outcome.code === WEBVIEW_BLOCKED_METHOD_CODE
          ? ErrorCodes.MM_CDP_BLOCKED
          : ErrorCodes.MM_CDP_FAILED,
      message: `[${outcome.code}] ${outcome.message}`,
    };
  }

  /**
   * Lists and diagnoses the debuggable Hermes targets Metro currently exposes,
   * reporting which target would be chosen (or why selection is ambiguous).
   *
   * @param input - Optional Metro port / appId overrides and an `all` flag to
   * bypass the appId filter for discovery.
   * @returns A structured report of discovered targets and the selection result.
   */
  async hermesTargets(input: HermesTargetsInput): Promise<HermesTargetsResult> {
    const session = this.#hermesSession;
    const resolved = session.resolve({
      metroPort: input.metroPort,
      appId: input.appId,
      platform: this.#backend.platform,
    });
    const filterBypassed = Boolean(input.all);

    let targets: HermesTarget[];
    try {
      targets = await fetchDiscoveryTargets(
        resolved.metroPort,
        HERMES_DISCOVERY_TIMEOUT_MS,
      );
    } catch (error) {
      if (isMetroDownError(error)) {
        return {
          metroPort: resolved.metroPort,
          expectedAppId: resolved.appId,
          filterBypassed,
          metroDown: true,
          targetsDiscovered: 0,
          candidates: [],
        };
      }
      throw error;
    }

    const selectionCandidates = targets
      .filter((target) => Boolean(target.webSocketDebuggerUrl))
      .filter((target) => target.title !== LEGACY_SYNTHETIC_TITLE)
      .filter((target) => target.appId === resolved.appId)
      .filter(
        (target) =>
          !resolved.pinnedDeviceId ||
          target.reactNative?.logicalDeviceId === resolved.pinnedDeviceId,
      );
    const displayCandidates = input.all ? targets : selectionCandidates;

    const result: HermesTargetsResult = {
      metroPort: resolved.metroPort,
      expectedAppId: resolved.appId,
      filterBypassed,
      metroDown: false,
      targetsDiscovered: targets.length,
      candidates: displayCandidates.map(toHermesTargetInfo),
    };

    const selection = selectHermesTarget(
      targets,
      resolved.appId,
      resolved.pinnedDeviceId,
    );
    if (selection.ok) {
      result.chosen = {
        id: selection.target.id,
        logicalDeviceId: selection.target.reactNative?.logicalDeviceId,
      };
    } else if (
      selection.code === HERMES_MULTIPLE_DEVICES_CODE &&
      hasAmbiguousTarget(selectionCandidates)
    ) {
      result.ambiguous = selection.message;
    } else {
      result.noTargetReason = {
        code: selection.code,
        message: selection.message,
      };
    }

    return result;
  }

  /**
   * Generates ranked locator suggestions for every interactive element on the
   * current screen by walking the device snapshot hierarchy, without the
   * elements that are not part of the app (see `filterAppHierarchy`). Mobile
   * only.
   *
   * @returns The ranked element locators.
   */
  async generateLocators(): Promise<ElementLocatorInfo[]> {
    const { hierarchy } = await this.#snapshotApp();
    return generateLocators(hierarchy);
  }
}

/**
 * Projects a raw Metro Hermes target into the trimmed shape returned to agents.
 *
 * @param target - A discovered Hermes target from Metro.
 * @returns The trimmed target info for the tool response.
 */
function toHermesTargetInfo(target: HermesTarget): HermesTargetInfo {
  return {
    id: target.id,
    title: target.title,
    appId: target.appId,
    logicalDeviceId: target.reactNative?.logicalDeviceId,
    nativePageReloads: target.reactNative?.capabilities?.nativePageReloads,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
}

/**
 * Detects the discovery failure that means Metro is not running (or has no
 * registered app), which callers surface as a soft `metroDown` result rather
 * than a hard error.
 *
 * @param error - The error thrown by Metro target discovery.
 * @returns True when the failure indicates Metro is unreachable.
 */
function isMetroDownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ECONNREFUSED') || message.includes('fetch failed');
}

/**
 * Resolves a target selector to a DeviceBackend ElementQuery.
 *
 * @param targetType - The selector type (a11yRef, testId, selector).
 * @param targetValue - The selector value.
 * @param refMap - The ref-to-stable-identifier map from getAccessibilityTree.
 * @returns An ElementQuery suitable for DeviceBackend methods.
 */
function resolveTargetToQuery(
  targetType: TargetType,
  targetValue: string,
  refMap: Map<string, string>,
): ElementQuery {
  switch (targetType) {
    case 'a11yRef': {
      const resolution = refMap.get(targetValue);
      if (!resolution) {
        throw new Error(
          `Unknown a11yRef: ${targetValue}. ` +
            `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
        );
      }
      return parseStableIdentifier(resolution);
    }
    case 'testId':
      return { identifier: targetValue };
    case 'selector':
      throw new Error(
        'CSS selectors are not supported on mobile. Use testId or a11yRef instead.',
      );
    default: {
      const _exhaustive: never = targetType;
      throw new Error(`Unknown target type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Parses a stable identifier string into an ElementQuery.
 *
 * @param stableId - String in "identifier:xxx", "label:xxx", or "value:xxx" format.
 * @returns The corresponding ElementQuery.
 */
function parseStableIdentifier(stableId: string): ElementQuery {
  const segments = stableId.split('|');
  const core = segments[0];

  const colonIndex = core.indexOf(':');
  if (colonIndex < 0) {
    return { identifier: core };
  }
  const prefix = core.slice(0, colonIndex);
  const value = core.slice(colonIndex + 1);

  let query: ElementQuery;
  switch (prefix) {
    case 'identifier':
      query = { identifier: value };
      break;
    case 'label':
      query = { label: value };
      break;
    case 'value':
      query = { text: value };
      break;
    default:
      query = { identifier: core };
      break;
  }

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    const segColonIndex = segment.indexOf(':');
    if (segColonIndex < 0) {
      continue;
    }
    const key = segment.slice(0, segColonIndex);
    const val = segment.slice(segColonIndex + 1);
    if (key === 'type') {
      query.type = val;
    }
  }

  return query;
}

/**
 * Normalizes a UIElement hierarchy into a flat, pre-order list of
 * A11yNodeTrimmed nodes with sequential refs.
 *
 * Layout-only elements (no name, no testId, not actionable, see
 * `pruneLayoutOnly`) are removed first, so they get no node, and node refs
 * number only the kept nodes. Nodes have no `path`: on mobile the ancestors
 * are native view classes (`android.widget.FrameLayout`, `RNSScreenView`)
 * with no targeting value, and the ancestor list was most of the payload.
 * Targeting is by `ref` or `testId`.
 *
 * Only a node with a testId, label or value gets a refMap entry, so only
 * its ref can be targeted. Kept nodes with none of them are listed (with
 * `bounds`, for `tap-coordinates`) but their ref does not resolve:
 * unlabelled tap targets (see `isUnlabelledTapTarget`), progress indicators
 * (kept for the screen settle) and unnamed controls. Ambiguity is computed
 * over the kept nodes.
 *
 * @param hierarchy - The UIElement tree from a device snapshot (after
 * `filterAppHierarchy`).
 * @param platform - The device platform.
 * @returns Trimmed nodes and the ref-to-stable-identifier map.
 */
function normalizeSnapshot(
  hierarchy: UIElement[],
  platform: 'ios' | 'android',
): {
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
} {
  const nodes: A11yNodeTrimmed[] = [];
  const refMap = new Map<string, string>();
  const stableIdCount = new Map<string, string[]>();
  let refCounter = 0;

  /**
   * @param elements - UIElement nodes to walk.
   */
  function walk(elements: UIElement[]): void {
    for (const el of elements) {
      refCounter += 1;
      const ref = `e${refCounter}`;
      const role = el.type || 'element';
      const name = el.label ?? el.value ?? '';

      const node: A11yNodeTrimmed = { ref, role, name };
      if (!el.enabled) {
        node.disabled = true;
      }
      if (el.identifier) {
        node.testId = el.identifier;
      }
      if (el.value && el.value !== name) {
        node.textContent = el.value;
      }
      if (el.frame.width > 0 || el.frame.height > 0) {
        // Fixed key order: idb returns frame keys in varying order, and
        // screenSignature / diffs compare the serialized nodes.
        const { x, y, width, height } = el.frame;
        node.bounds = { x, y, width, height };
      }
      nodes.push(node);

      let stableId: string | undefined;
      if (el.identifier) {
        stableId = `identifier:${el.identifier}`;
      } else if (el.label) {
        stableId = `label:${el.label}|type:${role}`;
      } else if (el.value) {
        stableId = `value:${el.value}|type:${role}`;
      }

      if (stableId) {
        refMap.set(ref, stableId);
        const refs = stableIdCount.get(stableId) ?? [];
        refs.push(ref);
        stableIdCount.set(stableId, refs);
      }

      if (el.children?.length) {
        walk(el.children);
      }
    }
  }

  walk(pruneLayoutOnly(hierarchy, platform));

  for (const refs of stableIdCount.values()) {
    if (refs.length > 1) {
      for (const ref of refs) {
        const node = nodes.find((nd) => nd.ref === ref);
        if (node) {
          node.ambiguous = true;
        }
      }
    }
  }

  return { nodes, refMap };
}

/**
 * Recursively collects test IDs from a UIElement hierarchy.
 *
 * @param elements - The UIElement nodes to scan.
 * @param items - Accumulator for discovered test ID items.
 * @param max - Maximum number of items to collect.
 * @param viewport - Device viewport in logical points, when known. Elements
 * whose frames do not intersect it are reported `visible: false`; elements
 * with unknown or zero-size geometry are assumed visible.
 * @param viewport.width - Viewport width in logical points.
 * @param viewport.height - Viewport height in logical points.
 */
function collectTestIds(
  elements: UIElement[],
  items: TestIdItem[],
  max: number,
  viewport?: { width: number; height: number },
): void {
  for (const el of elements) {
    if (items.length >= max) {
      return;
    }
    if (el.identifier) {
      items.push({
        testId: el.identifier,
        tag: el.type || 'element',
        text: el.label ?? el.value,
        visible: isWithinViewport(el.frame, viewport),
      });
    }
    if (el.children?.length) {
      collectTestIds(el.children, items, max, viewport);
    }
  }
}

/**
 * Checks whether an element frame intersects the device viewport.
 *
 * @param frame - Element frame in logical points.
 * @param viewport - Device viewport in logical points, when known.
 * @param viewport.width - Viewport width in logical points.
 * @param viewport.height - Viewport height in logical points.
 * @returns False only when a positive-size frame lies entirely outside the
 * viewport; unknown geometry is conservatively treated as visible.
 */
function isWithinViewport(
  frame: UIElement['frame'],
  viewport?: { width: number; height: number },
): boolean {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  if (frame.width <= 0 || frame.height <= 0) {
    return true;
  }
  const intersectsX = frame.x < viewport.width && frame.x + frame.width > 0;
  const intersectsY = frame.y < viewport.height && frame.y + frame.height > 0;
  return intersectsX && intersectsY;
}

/**
 * @param within - The within scope to validate.
 */
function rejectWithinScope(within: WithinScope | undefined): void {
  if (within) {
    throw new Error(
      'Scoped element search (within) is not supported on mobile. ' +
        'Target elements directly by testId or a11yRef.',
    );
  }
}

/**
 * @param promise - The operation to race against the deadline.
 * @param remainingMs - Milliseconds remaining in the timeout budget.
 * @param operationName - Label for the timeout error message.
 * @returns The result of the promise if it resolves within the budget.
 */
async function withTimeout<TResult>(
  promise: Promise<TResult>,
  remainingMs: number,
  operationName: string,
): Promise<TResult> {
  if (remainingMs <= 0) {
    throw new Error(`Timeout exceeded before ${operationName}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout exceeded during ${operationName}`)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
