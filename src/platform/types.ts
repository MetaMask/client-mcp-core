import type {
  ScreenshotResult,
  ExtensionState,
} from '../capabilities/types.js';
import type { TestIdItem, A11yNodeTrimmed } from '../tools/types/discovery.js';

export type PlatformType = 'browser' | 'ios' | 'android';

export type TargetType = 'a11yRef' | 'testId' | 'selector';

export type ClickActionResult = {
  clicked: boolean;
  target: string;
  pageClosedAfterClick?: boolean;
};

export type TypeActionResult = {
  typed: boolean;
  target: string;
  textLength: number;
};

export type GetTextActionResult = {
  text: string;
  target: string;
  length: number;
};

export type PlatformScreenshotOptions = {
  name: string;
  fullPage?: boolean;
  selector?: string;
  includeBase64?: boolean;
};

export type WithinScope = {
  type: TargetType;
  value: string;
};

export type IPlatformDriver = {
  click(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<ClickActionResult>;

  type(
    targetType: TargetType,
    targetValue: string,
    text: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<TypeActionResult>;

  waitForElement(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<void>;

  getText(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    timeoutMs: number,
    within?: WithinScope,
  ): Promise<GetTextActionResult>;

  getAccessibilityTree(
    rootSelector?: string,
  ): Promise<{ nodes: A11yNodeTrimmed[]; refMap: Map<string, string> }>;

  getTestIds(limit?: number): Promise<TestIdItem[]>;

  screenshot(options: PlatformScreenshotOptions): Promise<ScreenshotResult>;

  getAppState(): Promise<ExtensionState>;

  getCurrentUrl(): string;

  getPlatform(): PlatformType;

  // ---- Mobile-specific (optional) ----

  swipe?(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void>;

  scrollToElement?(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    direction?: 'up' | 'down',
    maxAttempts?: number,
  ): Promise<void>;

  longPress?(
    targetType: TargetType,
    targetValue: string,
    refMap: Map<string, string>,
    durationMs?: number,
  ): Promise<void>;

  tapCoordinates?(x: number, y: number): Promise<void>;

  dismissKeyboard?(): Promise<void>;

  dismissAlert?(accept: boolean): Promise<void>;

  getAlertText?(): Promise<string>;

  getWindowSize?(): Promise<{ width: number; height: number }>;

  openApp?(bundleId: string): Promise<void>;

  closeApp?(bundleId: string): Promise<void>;

  pressButton?(button: string): Promise<void>;

  getDeviceContexts?(): Promise<string[]>;

  setDeviceContext?(contextName: string): Promise<void>;

  getClipboard?(): Promise<string>;

  setClipboard?(text: string): Promise<void>;

  startScreenRecording?(outputPath?: string): Promise<void>;

  stopScreenRecording?(): Promise<string>;

  getLogs?(
    durationSeconds?: number,
    filter?: string,
  ): Promise<{
    entries: { timestamp: string; level: string; message: string }[];
    source: string;
  }>;
};
