import type { ConsoleLevel, EventKind } from './events.js';
import type { SmartContractName } from './seeding.js';

export type TabRole = 'extension' | 'notification' | 'dapp' | 'other';

export type BuildInput = {
  buildType?: 'build:test';
  force?: boolean;
};

export type LaunchInput = {
  autoBuild?: boolean;
  context?: 'e2e' | 'prod';
  stateMode?: 'default' | 'onboarding' | 'custom';
  fixturePreset?: string;
  fixture?: Record<string, unknown>;
  ports?: {
    anvil?: number;
    fixtureServer?: number;
  };
  slowMo?: number;
  extensionPath?: string;
  tags?: string[];
  seedContracts?: SmartContractName[];
  force?: boolean;
  /** Target platform: browser (default), ios, or android. */
  platform?: 'browser' | 'ios' | 'android';
  /** Explicit device ID for mobile platforms (iOS UDID or Android serial). */
  deviceId?: string;
  /** Mobile only: path to the app artifact to install before launching. */
  appBundlePath?: string;
  /** Mobile only: Metro bundler / inspector proxy port for watch-mode attach. */
  metroPort?: number;
  /** Mobile only: uninstall and reinstall the app before launching (destructive). */
  reinstall?: boolean;
  /** Mobile only: clear app data/container before launching (destructive). */
  resetAppData?: boolean;
  /** Mobile only: bypass the consumer app-identity compatibility guard (dangerous). */
  allowFoxCodeMismatch?: boolean;
  /**
   * Complete onboarding inside the launcher with the secret recovery phrase
   * supplied on stdin. The phrase is not accepted as a flag.
   */
  selfOnboarding?: boolean;
  /**
   * Secret recovery phrase for `selfOnboarding`. Present only on the launch
   * request body. Callers must not log or persist this field.
   */
  srp?: string;
  /**
   * Vault password for `selfOnboarding`. Present only on the launch request
   * body; the launcher falls back to its default when omitted. Callers must
   * not log or persist this field.
   */
  password?: string;
};

export type CleanupInput = {
  sessionId?: string;
};

export type NavigateInput = {
  screen: 'home' | 'settings' | 'notification' | 'url';
  url?: string;
};

export type ReloadInput = Record<string, never>;

export type WaitForNotificationInput = {
  timeoutMs?: number;
};

export type ListTestIdsInput = {
  limit?: number;
};

export type AccessibilitySnapshotInput = {
  rootSelector?: string;
};

export type DescribeScreenInput = {
  includeScreenshot?: boolean;
  screenshotName?: string;
  includeScreenshotBase64?: boolean;
  /** Browser only: describe the content of this iframe instead of the page. */
  frame?: WithinTarget;
};

export type ScreenshotInput = {
  name?: string;
  fullPage?: boolean;
  selector?: string;
  includeBase64?: boolean;
  /** Browser: how long to wait for `selector`, in ms. */
  timeoutMs?: number;
  /**
   * Browser only: capture this iframe, or the `selector` element inside it.
   */
  frame?: WithinTarget;
};

export type TargetSelection = {
  a11yRef?: string;
  testId?: string;
  selector?: string;
};

export type WithinTarget = {
  a11yRef?: string;
  testId?: string;
  selector?: string;
};

export type ClickInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
  /**
   * Mobile: when the software keyboard covers the target, dismiss it and
   * tap once more.
   */
  dismissKeyboard?: boolean;
};

export type TypeInput = TargetSelection & {
  text: string;
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
};

export type WaitForInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
};

export type GetTextInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
};

export type InspectInput = TargetSelection & {
  /** Computed style properties to read. Defaults to `DEFAULT_INSPECT_STYLES`. */
  styles?: string[];
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
};

export type HoverInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
  /** Browser only: the iframe the target (and `within`) is in. */
  frame?: WithinTarget;
};

export type UnhoverInput = Record<string, never>;

export type SetViewportInput = {
  width: number;
  height: number;
};

export type ResetViewportInput = Record<string, never>;

export type RunStepsInput = {
  steps: {
    tool: string;
    args?: Record<string, unknown>;
  }[];
  stopOnError?: boolean;
  batchTimeoutMs?: number;
};

export type SwitchToTabInput = {
  role?: TabRole;
  url?: string;
};

export type CloseTabInput = {
  role?: 'notification' | 'dapp' | 'other';
  url?: string;
};

export type ClipboardInput = {
  action: 'write' | 'read';
  text?: string;
};

export type CdpInput = {
  method: string;
  params?: Record<string, unknown>;
  /** Always populated after Zod validation (schema default: 30 000). */
  timeoutMs: number;
  /**
   * Mobile only: override the Metro inspector proxy port for the Hermes
   * runtime. Ignored on the browser platform.
   */
  metroPort?: number;
  /**
   * Mobile only: override the expected app bundle identifier when selecting
   * the Hermes debug target. Ignored on the browser platform.
   */
  appId?: string;
  /**
   * The CDP target. Browser: `'page'` (default) is the active page,
   * `'sw'` is the Extension service worker. Mobile: `'hermes'` (default) is
   * the React Native JS runtime via Metro, `'android-webview'` is a
   * debuggable in-app Android WebView via adb.
   */
  target?: 'page' | 'sw' | 'hermes' | 'android-webview';
  /**
   * Browser only: use a one-shot CDP session for this command and detach it
   * afterwards, instead of the persistent session shared across calls.
   */
  fresh?: boolean;
  /**
   * `android-webview` only: select the WebView page whose URL contains this
   * substring when multiple WebView pages are open.
   */
  urlFilter?: string;
};

export type HermesTargetsInput = {
  metroPort?: number;
  appId?: string;
  all?: boolean;
};

export type NetworkMockResponse = {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
};

export type NetworkMockRecordOptions = {
  body?: boolean;
  headers?: boolean;
  maxBodyBytes?: number;
};

export type NetworkMockRouteRule = {
  id: string;
  method: string;
  url: string;
  /**
   * Mocked response. Omit it to record the real request and forward it
   * unchanged; `record` is then required.
   */
  response?: NetworkMockResponse;
  record?: NetworkMockRecordOptions;
};

export type NetworkMockRecordedBody = {
  type: 'json' | 'text' | 'binary' | 'empty';
  size: number;
  truncated?: boolean;
  /**
   * True when the value was withheld because it could not be redacted safely.
   * This happens for JSON-like text that does not parse.
   */
  redacted?: boolean;
  value?: unknown;
};

/**
 * Where a mocked request can come from: a page (tab, popup, dapp), the
 * Extension service worker, the MV3 offscreen document, or an iframe of the
 * offscreen document (a snaps iframe).
 */
export type NetworkMockContext = 'page' | 'sw' | 'offscreen' | 'iframe';

/** The contexts whose interception depends on a live CDP session. */
export type NetworkMockPendingContext = 'offscreen' | 'iframe';

export type NetworkMockRequestRecord = {
  timestamp: string;
  method: string;
  url: string;
  /**
   * True when a rule matched. A rule with a response mocks the request; a
   * rule with only record forwards it unchanged.
   */
  matched: boolean;
  ruleId?: string;
  /**
   * Mocked status for a rule with a response, or the real status of a
   * forwarded page or service worker request when the response arrived
   * within the status timeout. Forwarded offscreen document and iframe
   * requests have none.
   */
  status?: number;
  /**
   * Why the mocked response of an offscreen document or iframe request
   * could not be sent. The request was then continued to the real server,
   * if its target was still there, and the record has no `status`.
   */
  mockError?: string;
  /** The context the request came from. */
  context?: NetworkMockContext;
  /** True for a service worker request (`context: 'sw'`). */
  serviceWorker?: boolean;
  headers?: Record<string, string>;
  body?: NetworkMockRecordedBody;
};

export type NetworkMockSummary = {
  ruleCount: number;
  requestCount: number;
  hits: number;
  misses: number;
  lastMatchedUrl?: string;
  lastRequestUrl?: string;
};

export type MockNetworkInput =
  | {
      action: 'add';
      rule?: NetworkMockRouteRule;
      routes?: NetworkMockRouteRule[];
    }
  | { action: 'clear' }
  | { action: 'list' }
  | {
      action: 'requests';
      limit?: number;
      url?: string;
      includeBodies?: boolean;
    };

/** Read options shared by `mm logs` and `mm network`. */
export type EventReadInput = {
  /** Only records after this cursor (from `mm events mark` or an earlier read). */
  cursor?: number;
  /** Only records at or after this time: epoch ms, or an ISO date. */
  since?: number | string;
  /** Maximum records (default 500, max 2000). */
  limit?: number;
};

export type LogsInput =
  | ({
      action?: 'read';
      /**
       * Only messages whose text matches this case-sensitive JavaScript
       * regular expression (at most 256 characters).
       */
      grep?: string;
    } & EventReadInput)
  | { action: 'configure'; levels: ConsoleLevel[] };

export type NetworkInput =
  | ({
      action?: 'read';
      /**
       * URL glob (`*`, `**`) or, without `*`, text the URL must contain. A
       * filtered read returns only settled requests, so a request that
       * matches when it ends is returned by the read that follows its end.
       */
      url?: string;
      /**
       * Only errors: HTTP status >= 400, `failure`, or `rpcError`. A
       * filtered read returns only settled requests, so a request that
       * becomes an error when it ends is returned by the read that follows
       * its end.
       */
      errors?: boolean;
      /**
       * Return only settled requests, in settle order, without needing a
       * filter: at the end of a step, read the final status of every request
       * that ended after the cursor, including ones started earlier.
       * Requests still open are not returned yet.
       */
      settled?: boolean;
    } & EventReadInput)
  | { action: 'configure'; rpcErrors: boolean };

export type EventsInput =
  | { action: 'mark' }
  | { action: 'clear'; kind?: EventKind };

export type SetContextInput = {
  context: 'e2e' | 'prod';
  options?: Record<string, unknown>;
};

export type ScrollToElementInput = TargetSelection & {
  /** Content direction: `down` reveals content below. Default `auto`. */
  direction?: 'up' | 'down' | 'auto';
  maxAttempts?: number;
  timeoutMs?: number;
  within?: WithinTarget;
};

export type DeviceSwipeInput = {
  direction: 'up' | 'down' | 'left' | 'right';
  startX?: number;
  startY?: number;
  distance?: number;
};

export type LongPressInput = TargetSelection & {
  durationMs?: number;
};

export type TapCoordinatesInput = {
  x: number;
  y: number;
};

export type DismissAlertInput = {
  accept: boolean;
};

export type OpenAppInput = {
  bundleId: string;
};

export type CloseAppInput = {
  bundleId: string;
};

/** Device buttons pressable via `press_button`. Mirrors device-mcp's `DeviceButton`. */
export type DeviceButtonName = 'home' | 'back' | 'enter' | 'lock';

export type PressButtonInput = {
  button: DeviceButtonName;
};

export type DeviceContextInput =
  | { action: 'list' }
  | { action: 'switch'; name: string };

export type DeviceClipboardInput =
  | { action: 'read' }
  | { action: 'write'; text: string };

export type ScreenRecordingInput =
  | { action: 'start'; outputPath?: string }
  | { action: 'stop' };

export type DeviceLogsInput = {
  durationSeconds?: number;
  filter?: string;
};
