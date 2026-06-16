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
  goal?: string;
  flowTags?: string[];
  tags?: string[];
  seedContracts?: SmartContractName[];
  force?: boolean;
  platform?: 'browser' | 'ios' | 'android';
  simulatorDeviceId?: string;
  appBundlePath?: string;
  androidDeviceId?: string;
  /** Metro inspector proxy port for iOS Hermes CDP (default 8081). */
  metroPort?: number;
  /** Uninstall and reinstall the app bundle. Destructive to app container. */
  reinstall?: boolean;
  /** Clear app data/container. Destructive to wallet state. */
  resetAppData?: boolean;
  /** Bypass fox_code compatibility guard. Use with caution. */
  allowFoxCodeMismatch?: boolean;
};

export type CleanupInput = {
  sessionId?: string;
};

export type NavigateInput = {
  screen: 'home' | 'settings' | 'notification' | 'url';
  url?: string;
};

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

export type KnowledgeScope =
  | 'current'
  | 'all'
  | {
      sessionId: string;
    };

export type KnowledgeFilters = {
  flowTag?: string;
  tag?: string;
  screen?: string;
  sinceHours?: number;
};

export type KnowledgeLastInput = {
  n?: number;
  scope?: KnowledgeScope;
  filters?: KnowledgeFilters;
};

export type KnowledgeSearchInput = {
  query: string;
  limit?: number;
  scope?: KnowledgeScope;
  filters?: KnowledgeFilters;
};

export type KnowledgeSummarizeInput = {
  sessionId?: string;
  scope?: KnowledgeScope;
};

export type KnowledgeSessionsInput = {
  limit?: number;
  filters?: KnowledgeFilters;
};

export type RunStepsInput = {
  steps: {
    tool: string;
    args?: Record<string, unknown>;
  }[];
  stopOnError?: boolean;
  includeObservations?: 'none' | 'failures' | 'all';
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
};

export type HermesCdpInput = {
  method: string;
  params?: Record<string, unknown>;
  /** Always populated after Zod validation (schema default: 30 000). */
  timeoutMs: number;
  /**
   * Metro dev server port used for Hermes target discovery.
   *
   * Optional. Resolution chain at call time:
   *   input.metroPort ?? platformDriver.getMetroPort() ?? 8081
   *
   * Per-call input wins over the session-scoped port plumbed via
   * SessionLaunchInput.metroPort. Omit to fall through to the
   * session-level port set at launch time.
   */
  metroPort?: number;
};

export type SetContextInput = {
  context: 'e2e' | 'prod';
  options?: Record<string, unknown>;
};
