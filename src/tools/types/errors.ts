export const ErrorCodes = {
  MM_BUILD_FAILED: 'MM_BUILD_FAILED',
  MM_DEPENDENCIES_MISSING: 'MM_DEPENDENCIES_MISSING',

  MM_SESSION_ALREADY_RUNNING: 'MM_SESSION_ALREADY_RUNNING',
  MM_NO_ACTIVE_SESSION: 'MM_NO_ACTIVE_SESSION',
  MM_PAGE_CLOSED: 'MM_PAGE_CLOSED',
  MM_LAUNCH_FAILED: 'MM_LAUNCH_FAILED',

  MM_INVALID_CONFIG: 'MM_INVALID_CONFIG',
  MM_INVALID_INPUT: 'MM_INVALID_INPUT',
  MM_PORT_IN_USE: 'MM_PORT_IN_USE',

  MM_NAVIGATION_FAILED: 'MM_NAVIGATION_FAILED',
  MM_NOTIFICATION_TIMEOUT: 'MM_NOTIFICATION_TIMEOUT',

  MM_TARGET_NOT_FOUND: 'MM_TARGET_NOT_FOUND',
  MM_TARGET_NOT_VISIBLE: 'MM_TARGET_NOT_VISIBLE', // found, but not in the viewport (scroll_to_element, mobile tap)
  MM_TARGET_OBSCURED: 'MM_TARGET_OBSCURED', // another element (keyboard, sheet, overlay) is on top of the target; nothing was tapped
  MM_CLICK_FAILED: 'MM_CLICK_FAILED',
  MM_TYPE_FAILED: 'MM_TYPE_FAILED',
  MM_GETTEXT_FAILED: 'MM_GETTEXT_FAILED',
  MM_WAIT_TIMEOUT: 'MM_WAIT_TIMEOUT',
  MM_CLICK_TIMEOUT: 'MM_CLICK_TIMEOUT', // click action timed out (element found, click hung); state unknown
  MM_TYPE_TIMEOUT: 'MM_TYPE_TIMEOUT', // fill action timed out; state unknown
  MM_GETTEXT_TIMEOUT: 'MM_GETTEXT_TIMEOUT', // textContent action timed out

  MM_SCREENSHOT_FAILED: 'MM_SCREENSHOT_FAILED',

  MM_DISCOVERY_FAILED: 'MM_DISCOVERY_FAILED',
  MM_STATE_FAILED: 'MM_STATE_FAILED',

  MM_SEED_FAILED: 'MM_SEED_FAILED',
  MM_CONTRACT_NOT_FOUND: 'MM_CONTRACT_NOT_FOUND',

  MM_TAB_NOT_FOUND: 'MM_TAB_NOT_FOUND',

  MM_CAPABILITY_NOT_AVAILABLE: 'MM_CAPABILITY_NOT_AVAILABLE',

  MM_CONTEXT_SWITCH_BLOCKED: 'MM_CONTEXT_SWITCH_BLOCKED',
  MM_SET_CONTEXT_FAILED: 'MM_SET_CONTEXT_FAILED',

  MM_CDP_BLOCKED: 'MM_CDP_BLOCKED',
  MM_CDP_FAILED: 'MM_CDP_FAILED',

  MM_HERMES_FAILED: 'MM_HERMES_FAILED', // underlying device-mcp HERMES_* code is preserved in the message
  MM_HERMES_NOT_AVAILABLE: 'MM_HERMES_NOT_AVAILABLE', // hermes tools require a mobile (iOS/Android) driver

  MM_DEVICE_ACTION_FAILED: 'MM_DEVICE_ACTION_FAILED', // a mobile device action (swipe, tap, app control, etc.) failed
  MM_DEVICE_NOT_AVAILABLE: 'MM_DEVICE_NOT_AVAILABLE', // mobile-only tool invoked without a mobile driver capability

  MM_TOOL_NOT_SUPPORTED_ON_PLATFORM: 'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM', // tool gated off the active platform (browser-only / mobile-only)

  MM_REQUEST_ABORTED: 'MM_REQUEST_ABORTED', // the request timed out; the tool stopped at its next checkpoint

  MM_BATCH_TIMEOUT: 'MM_BATCH_TIMEOUT', // run_steps batchTimeoutMs passed; the remaining steps were skipped

  MM_CLIPBOARD_PERMISSION_DENIED: 'MM_CLIPBOARD_PERMISSION_DENIED',
  MM_CLIPBOARD_LAVAMOAT_BLOCKED: 'MM_CLIPBOARD_LAVAMOAT_BLOCKED',
  MM_CLIPBOARD_FAILED: 'MM_CLIPBOARD_FAILED',

  // Set by the `mm` CLI, not by a tool.
  MM_DAEMON_NOT_RUNNING: 'MM_DAEMON_NOT_RUNNING', // no daemon, or the daemon refused the connection
  MM_DAEMON_START_FAILED: 'MM_DAEMON_START_FAILED', // the daemon did not become ready in time
  MM_DAEMON_ALREADY_RUNNING: 'MM_DAEMON_ALREADY_RUNNING', // `mm serve` with a live daemon
  MM_DAEMON_CONNECTION_LOST: 'MM_DAEMON_CONNECTION_LOST', // the connection failed after the request was sent; the action may have run
  MM_REQUEST_TIMEOUT: 'MM_REQUEST_TIMEOUT', // the CLI stopped waiting for the daemon; the action state is unknown

  MM_UNKNOWN_TOOL: 'MM_UNKNOWN_TOOL',
  MM_INTERNAL_ERROR: 'MM_INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Codes the daemon HTTP server sets itself, before or around a tool call.
 * They keep their historical names on the wire.
 */
export const DaemonErrorCodes = {
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  SERVER_NOT_STARTED: 'SERVER_NOT_STARTED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * Exit codes of the `mm` CLI. Each error code maps to one of them through
 * {@link exitCodeForError}.
 */
export const CliExitCodes = {
  /** Success. */
  OK: 0,
  /** Any failure not in another class (internal error, tool failure). */
  INTERNAL: 1,
  /** Usage or validation: bad flag, bad JSON, schema error. Nothing ran. */
  USAGE: 2,
  /** No session, daemon not running, daemon connection lost or crashed. */
  SESSION: 3,
  /** Target not found or not actionable. */
  TARGET: 4,
  /** Timeout. For click, type and request timeouts the action state is unknown. */
  TIMEOUT: 5,
  /** Platform, device, Metro or Hermes not available. */
  PLATFORM: 6,
  /** Daemon version does not match the CLI (reserved for P1-22). */
  VERSION_MISMATCH: 7,
} as const;

export type CliExitCode = (typeof CliExitCodes)[keyof typeof CliExitCodes];

const EXIT_CODE_BY_ERROR: Readonly<Record<string, CliExitCode>> = {
  // 2: usage / validation
  [ErrorCodes.MM_INVALID_INPUT]: CliExitCodes.USAGE,
  [ErrorCodes.MM_INVALID_CONFIG]: CliExitCodes.USAGE,
  [ErrorCodes.MM_UNKNOWN_TOOL]: CliExitCodes.USAGE,
  [ErrorCodes.MM_CONTRACT_NOT_FOUND]: CliExitCodes.USAGE,
  [ErrorCodes.MM_CDP_BLOCKED]: CliExitCodes.USAGE,
  [DaemonErrorCodes.VALIDATION_ERROR]: CliExitCodes.USAGE,
  [DaemonErrorCodes.TOOL_NOT_FOUND]: CliExitCodes.USAGE,

  // 3: no session / daemon down / connection lost
  [ErrorCodes.MM_NO_ACTIVE_SESSION]: CliExitCodes.SESSION,
  [ErrorCodes.MM_PAGE_CLOSED]: CliExitCodes.SESSION,
  [ErrorCodes.MM_DAEMON_NOT_RUNNING]: CliExitCodes.SESSION,
  [ErrorCodes.MM_DAEMON_START_FAILED]: CliExitCodes.SESSION,
  [ErrorCodes.MM_DAEMON_CONNECTION_LOST]: CliExitCodes.SESSION,
  [DaemonErrorCodes.SERVER_NOT_STARTED]: CliExitCodes.SESSION,

  // 4: target not found / not actionable
  [ErrorCodes.MM_TARGET_NOT_FOUND]: CliExitCodes.TARGET,
  [ErrorCodes.MM_TARGET_NOT_VISIBLE]: CliExitCodes.TARGET,
  [ErrorCodes.MM_TARGET_OBSCURED]: CliExitCodes.TARGET,
  [ErrorCodes.MM_CLICK_FAILED]: CliExitCodes.TARGET,
  [ErrorCodes.MM_TYPE_FAILED]: CliExitCodes.TARGET,
  [ErrorCodes.MM_GETTEXT_FAILED]: CliExitCodes.TARGET,
  [ErrorCodes.MM_TAB_NOT_FOUND]: CliExitCodes.TARGET,

  // 5: timeout
  [ErrorCodes.MM_WAIT_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_CLICK_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_TYPE_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_GETTEXT_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_NOTIFICATION_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_REQUEST_ABORTED]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_REQUEST_TIMEOUT]: CliExitCodes.TIMEOUT,
  [ErrorCodes.MM_BATCH_TIMEOUT]: CliExitCodes.TIMEOUT,

  // 6: platform / device / Metro / Hermes unavailable
  [ErrorCodes.MM_DEPENDENCIES_MISSING]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_DEVICE_ACTION_FAILED]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_DEVICE_NOT_AVAILABLE]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_HERMES_FAILED]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_HERMES_NOT_AVAILABLE]: CliExitCodes.PLATFORM,
  [ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM]: CliExitCodes.PLATFORM,
};

/**
 * Returns the CLI exit code for an error code. Unknown codes (for example a
 * consumer-specific `MM_*` code) map to {@link CliExitCodes.INTERNAL}.
 *
 * @param code - The error code from a tool, the daemon or the CLI.
 * @returns The process exit code.
 */
export function exitCodeForError(code: string | undefined): CliExitCode {
  if (code !== undefined && Object.hasOwn(EXIT_CODE_BY_ERROR, code)) {
    return EXIT_CODE_BY_ERROR[code];
  }
  return CliExitCodes.INTERNAL;
}

/**
 * Codes where running the same command again, unchanged, is safe and can
 * succeed: the call only reads, or nothing ran. Click, type and request
 * timeouts are not here: the action state is unknown, and a repeat can tap
 * twice.
 */
const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  ErrorCodes.MM_WAIT_TIMEOUT,
  ErrorCodes.MM_GETTEXT_TIMEOUT,
  ErrorCodes.MM_NOTIFICATION_TIMEOUT,
  ErrorCodes.MM_SCREENSHOT_FAILED,
  ErrorCodes.MM_DISCOVERY_FAILED,
  ErrorCodes.MM_STATE_FAILED,
  ErrorCodes.MM_DAEMON_START_FAILED,
]);

/**
 * Tells whether a failed command can be run again unchanged.
 *
 * @param code - The error code.
 * @returns True when a plain retry is safe and can succeed.
 */
export function isRetryableError(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_ERRORS.has(code);
}

const STATE_UNKNOWN_HINT =
  'The action state is unknown: run `mm describe-screen` to check the screen before you retry.';

const DEFAULT_HINTS: Readonly<Record<string, string>> = {
  [ErrorCodes.MM_NO_ACTIVE_SESSION]: 'Run `mm launch` first.',
  [ErrorCodes.MM_DAEMON_NOT_RUNNING]: 'Run `mm launch` to start.',
  [ErrorCodes.MM_DAEMON_CONNECTION_LOST]:
    'The action may have run: run `mm describe-screen` to check the screen before you retry.',
  [ErrorCodes.MM_TARGET_NOT_FOUND]:
    'Run `mm describe-screen` to get fresh refs.',
  [ErrorCodes.MM_TARGET_NOT_VISIBLE]:
    'Run `mm scroll-to-element <ref>`, then try again.',
  [ErrorCodes.MM_TARGET_OBSCURED]:
    'Nothing was tapped. Close the keyboard (`mm click ... --dismiss-keyboard`) or the overlay first.',
  [ErrorCodes.MM_CLICK_TIMEOUT]: STATE_UNKNOWN_HINT,
  [ErrorCodes.MM_TYPE_TIMEOUT]: STATE_UNKNOWN_HINT,
  [ErrorCodes.MM_REQUEST_TIMEOUT]: STATE_UNKNOWN_HINT,
  [ErrorCodes.MM_REQUEST_ABORTED]: STATE_UNKNOWN_HINT,
};

/**
 * Returns the default recovery hint for an error code, if there is one.
 *
 * @param code - The error code.
 * @returns The hint, or undefined.
 */
export function defaultHintForError(
  code: string | undefined,
): string | undefined {
  return code !== undefined && Object.hasOwn(DEFAULT_HINTS, code)
    ? DEFAULT_HINTS[code]
    : undefined;
}
