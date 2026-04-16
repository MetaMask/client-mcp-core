import type { TestIdItem, A11yNodeTrimmed } from './discovery.js';
import type { PriorKnowledgeV1 } from './knowledge.js';
import type { TabRole } from './tool-inputs.js';
import type { ExtensionState } from '../../capabilities/types.js';

export type BuildToolResult = {
  buildType: 'build:test';
  extensionPathResolved: string;
};

export type LaunchPrerequisite = {
  step: string;
  description: string;
};

export type LaunchResult = {
  sessionId: string;
  extensionId: string;
  state: ExtensionState;
  prerequisites?: LaunchPrerequisite[];
};

export type CleanupResult = {
  cleanedUp: boolean;
};

export type GetStateResult = {
  state: ExtensionState;
  tabs?: {
    active: TabInfo;
    tracked: TabInfo[];
  };
};

export type NavigateResult = {
  navigated: boolean;
  currentUrl: string;
};

export type WaitForNotificationResult = {
  found: boolean;
  pageUrl: string;
};

export type ListTestIdsResult = {
  items: TestIdItem[];
};

export type AccessibilitySnapshotResult = {
  nodes: A11yNodeTrimmed[];
};

export type ScreenshotInfo = {
  path: string;
  width: number;
  height: number;
  base64?: string | null;
} | null;

export type DescribeScreenResult = {
  state: ExtensionState;
  testIds: {
    items: TestIdItem[];
  };
  a11y: {
    nodes: A11yNodeTrimmed[];
  };
  screenshot: ScreenshotInfo;
  priorKnowledge?: PriorKnowledgeV1;
};

export type ScreenshotToolResult = {
  path: string;
  width: number;
  height: number;
  base64?: string;
};

export type ClickResult = {
  clicked: boolean;
  target: string;
  pageClosedAfterClick?: boolean;
};

export type TypeResult = {
  typed: boolean;
  target: string;
  textLength: number;
};

export type WaitForResult = {
  found: boolean;
  target: string;
};

export type StepResult = {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    durationMs: number;
    timestamp: string;
    skipped?: boolean;
  };
};

export type RunStepsResult = {
  steps: StepResult[];
  summary: {
    ok: boolean;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
};

export type TabInfo = {
  role: TabRole;
  url: string;
};

export type SwitchToTabResult = {
  switched: boolean;
  activeTab: TabInfo;
};

export type CloseTabResult = {
  closed: boolean;
  closedUrl: string;
};

export type ClipboardResult = {
  action: 'write' | 'read';
  success: boolean;
  text?: string;
};

export type SetContextResult = {
  previousContext: 'e2e' | 'prod';
  newContext: 'e2e' | 'prod';
  availableCapabilities: string[];
};

export type GetContextResult = {
  currentContext: 'e2e' | 'prod';
  hasActiveSession: boolean;
  sessionId: string | null;
  capabilities: {
    available: string[];
  };
  canSwitchContext: boolean;
};
