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
};
