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
};

export type ScreenshotInput = {
  name?: string;
  fullPage?: boolean;
  selector?: string;
  includeBase64?: boolean;
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
};

export type WaitForInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
};

export type GetTextInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
};

export type InspectInput = TargetSelection & {
  /** Computed style properties to read. Defaults to `DEFAULT_INSPECT_STYLES`. */
  styles?: string[];
  timeoutMs?: number;
  within?: WithinTarget;
};

export type HoverInput = TargetSelection & {
  timeoutMs?: number;
  within?: WithinTarget;
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
   * Mobile only: which CDP target to drive. `'hermes'` (the default) targets
   * the React Native JS runtime via Metro; `'android-webview'` targets a
   * debuggable in-app Android WebView via adb. Ignored on the browser platform.
   */
  target?: 'hermes' | 'android-webview';
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
  response: NetworkMockResponse;
  record?: NetworkMockRecordOptions;
};

export type NetworkMockRecordedBody = {
  type: 'json' | 'text' | 'binary' | 'empty';
  size: number;
  truncated?: boolean;
  value?: unknown;
};

export type NetworkMockRequestRecord = {
  timestamp: string;
  method: string;
  url: string;
  matched: boolean;
  ruleId?: string;
  status?: number;
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

export type NetworkLogConsoleLevel =
  | 'error'
  | 'warning'
  | 'info'
  | 'log'
  | 'debug';

export type NetworkLogSource = 'page' | 'service-worker';

export type NetworkLogReadOptions = {
  /** Only records at or after this time (epoch ms, or an ISO date). */
  since?: number | string;
  /** Only records after this cursor (from `mark` or an earlier read). */
  cursor?: number;
  limit?: number;
  /** URL glob (`*`, `**`) or, without `*`, text the URL must contain. */
  url?: string;
  /** Only errors: failed, HTTP status >= 400 or JSON-RPC error requests; `error` console messages. */
  errors?: boolean;
  /** Remove the returned records from the log. */
  clear?: boolean;
};

export type NetworkLogConfig = {
  consoleLevels: NetworkLogConsoleLevel[];
  rpcErrors: boolean;
};

export type NetworkLogInput =
  | ({ action: 'requests' } & NetworkLogReadOptions)
  | ({ action: 'console' } & NetworkLogReadOptions)
  | { action: 'mark' }
  | { action: 'clear' }
  | ({ action: 'configure' } & Partial<NetworkLogConfig>);

export type NetworkLogRpcError = {
  code?: number;
  message: string;
  /** Number of errors in a batch response, when more than one. */
  count?: number;
};

export type NetworkLogRequestRecord = {
  /** Sequence number, shared with console records. */
  seq: number;
  /** Request start, epoch ms. */
  t: number;
  method: string;
  /** URL with secrets redacted. */
  url: string;
  /** Playwright resource type, for example `fetch`, `xhr` or `document`. */
  type: string;
  /** HTTP status. Absent when the request failed before a response. */
  status?: number;
  /** Duration in ms, from start to the end of the response or the failure. */
  ms: number;
  /** Failure text, for example `net::ERR_ABORTED`. */
  failure?: string;
  /** JSON-RPC method, or the methods of a batch. */
  rpcMethod?: string | string[];
  rpcBatchSize?: number;
  /** JSON-RPC error from the response body (only with `rpcErrors` on). */
  rpcError?: NetworkLogRpcError;
  source: NetworkLogSource;
  pageUrl?: string;
  /** URL of the iframe that sent the request, when not the main frame. */
  frameUrl?: string;
};

export type NetworkLogConsoleRecord = {
  seq: number;
  /** Epoch ms. */
  t: number;
  level: NetworkLogConsoleLevel;
  text: string;
  source: NetworkLogSource;
  /** Page URL, or the service worker script URL. */
  sourceUrl?: string;
  /** `url:line:column` of the console call. */
  location?: string;
  /** An uncaught page error, not a console call. */
  uncaught?: boolean;
};

export type NetworkLogSummary = {
  startedAt: string;
  cursor: number;
  requests: {
    kept: number;
    total: number;
    dropped: number;
    pending: number;
    ignored: number;
    max: number;
  };
  console: {
    kept: number;
    total: number;
    dropped: number;
    max: number;
  };
  /** JSON-RPC responses not read for errors (too large or too many at once). */
  rpcErrorsSkipped?: number;
  config: NetworkLogConfig;
};

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
