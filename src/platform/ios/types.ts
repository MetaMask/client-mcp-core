/**
 * Types for the XCUITest HTTP client.
 *
 * These types define the protocol for communicating with the XCUITest runner,
 * an HTTP server embedded in the iOS test runner process (agent-device).
 *
 * This module contains NO Playwright imports.
 */

/**
 * A node in the XCUITest accessibility snapshot tree.
 *
 * Represents a single element in the iOS accessibility hierarchy,
 * returned by the runner's `snapshot` command.
 */
export type SnapshotNode = {
  index: number;
  type?: string;
  label?: string;
  value?: string;
  identifier?: string; // accessibilityIdentifier (maps to testId)
  rect?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
  children?: SnapshotNode[];
};

/**
 * Configuration for the XCUITest client.
 */
export type XCUITestClientConfig = {
  port: number;
  host?: string; // default: '127.0.0.1'
  timeoutMs?: number; // default: 30000
  maxRetries?: number; // default: 3
  retryDelayMs?: number; // default: 500
};

/**
 * Command sent to the XCUITest runner.
 *
 * The command field specifies the action to perform.
 * Optional fields provide parameters for specific commands.
 */
export type RunnerCommand = {
  command: 'tap' | 'type' | 'swipe' | 'snapshot' | 'back' | 'home' | 'shutdown';
  text?: string;
  x?: number;
  y?: number;
  direction?: SwipeDirection;
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  scope?: string;
  appBundleId?: string;
};

/**
 * Snapshot data payload returned by the `snapshot` command.
 */
export type SnapshotDataPayload = {
  nodes: SnapshotNode[];
  truncated: boolean;
};

/**
 * Error payload returned by the XCUITest runner.
 */
export type RunnerErrorPayload = {
  message: string;
};

/**
 * Response from the XCUITest runner.
 */
export type RunnerResponse<TData = unknown> = {
  ok: boolean;
  data?: TData;
  error?: RunnerErrorPayload;
};

/**
 * Swipe direction for the `swipe` command.
 */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';
