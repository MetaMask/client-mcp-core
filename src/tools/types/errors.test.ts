import { describe, expect, it } from 'vitest';

import {
  CliExitCodes,
  DaemonErrorCodes,
  defaultHintForError,
  ErrorCodes,
  exitCodeForError,
  isRetryableError,
} from './errors.js';

describe('exitCodeForError', () => {
  it.each([
    [ErrorCodes.MM_INVALID_INPUT, CliExitCodes.USAGE],
    [ErrorCodes.MM_INVALID_CONFIG, CliExitCodes.USAGE],
    [DaemonErrorCodes.VALIDATION_ERROR, CliExitCodes.USAGE],
    [DaemonErrorCodes.TOOL_NOT_FOUND, CliExitCodes.USAGE],
    [ErrorCodes.MM_NO_ACTIVE_SESSION, CliExitCodes.SESSION],
    [ErrorCodes.MM_DAEMON_NOT_RUNNING, CliExitCodes.SESSION],
    [ErrorCodes.MM_DAEMON_CONNECTION_LOST, CliExitCodes.SESSION],
    [DaemonErrorCodes.SERVER_NOT_STARTED, CliExitCodes.SESSION],
    [ErrorCodes.MM_TARGET_NOT_FOUND, CliExitCodes.TARGET],
    [ErrorCodes.MM_TARGET_NOT_VISIBLE, CliExitCodes.TARGET],
    [ErrorCodes.MM_TARGET_OBSCURED, CliExitCodes.TARGET],
    [ErrorCodes.MM_WAIT_TIMEOUT, CliExitCodes.TIMEOUT],
    [ErrorCodes.MM_CLICK_TIMEOUT, CliExitCodes.TIMEOUT],
    [ErrorCodes.MM_REQUEST_TIMEOUT, CliExitCodes.TIMEOUT],
    [ErrorCodes.MM_BATCH_TIMEOUT, CliExitCodes.TIMEOUT],
    [ErrorCodes.MM_DEVICE_NOT_AVAILABLE, CliExitCodes.PLATFORM],
    [ErrorCodes.MM_HERMES_FAILED, CliExitCodes.PLATFORM],
    [ErrorCodes.MM_DEPENDENCIES_MISSING, CliExitCodes.PLATFORM],
    [ErrorCodes.MM_INTERNAL_ERROR, CliExitCodes.INTERNAL],
    [DaemonErrorCodes.TOOL_EXECUTION_FAILED, CliExitCodes.INTERNAL],
    [DaemonErrorCodes.INTERNAL_ERROR, CliExitCodes.INTERNAL],
  ])('maps %s to exit %i', (code, exitCode) => {
    expect(exitCodeForError(code)).toBe(exitCode);
  });

  it('maps an unknown or missing code to exit 1', () => {
    expect(exitCodeForError('MM_SOMETHING_NEW')).toBe(CliExitCodes.INTERNAL);
    expect(exitCodeForError('toString')).toBe(CliExitCodes.INTERNAL);
    expect(exitCodeForError(undefined)).toBe(CliExitCodes.INTERNAL);
  });

  it('maps every ErrorCodes value to a valid exit code', () => {
    const valid = new Set<number>(Object.values(CliExitCodes));
    for (const code of Object.values(ErrorCodes)) {
      expect(valid.has(exitCodeForError(code))).toBe(true);
    }
  });

  it('never maps a code to exit 0 or the reserved exit 7', () => {
    for (const code of [
      ...Object.values(ErrorCodes),
      ...Object.values(DaemonErrorCodes),
    ]) {
      expect(exitCodeForError(code)).not.toBe(CliExitCodes.OK);
      expect(exitCodeForError(code)).not.toBe(CliExitCodes.VERSION_MISMATCH);
    }
  });
});

describe('isRetryableError', () => {
  it('marks read-only failures as retryable', () => {
    expect(isRetryableError(ErrorCodes.MM_WAIT_TIMEOUT)).toBe(true);
    expect(isRetryableError(ErrorCodes.MM_SCREENSHOT_FAILED)).toBe(true);
  });

  it('never marks an action with unknown state as retryable', () => {
    expect(isRetryableError(ErrorCodes.MM_CLICK_TIMEOUT)).toBe(false);
    expect(isRetryableError(ErrorCodes.MM_TYPE_TIMEOUT)).toBe(false);
    expect(isRetryableError(ErrorCodes.MM_REQUEST_TIMEOUT)).toBe(false);
    expect(isRetryableError(ErrorCodes.MM_DAEMON_CONNECTION_LOST)).toBe(false);
  });

  it('returns false for unknown or missing codes', () => {
    expect(isRetryableError('MM_SOMETHING_NEW')).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('defaultHintForError', () => {
  it('returns a hint for codes that have one', () => {
    expect(defaultHintForError(ErrorCodes.MM_CLICK_TIMEOUT)).toContain(
      'state is unknown',
    );
    expect(defaultHintForError(ErrorCodes.MM_NO_ACTIVE_SESSION)).toBe(
      'Run `mm launch` first.',
    );
  });

  it('returns undefined for other codes', () => {
    expect(defaultHintForError(ErrorCodes.MM_SEED_FAILED)).toBeUndefined();
    expect(defaultHintForError('constructor')).toBeUndefined();
    expect(defaultHintForError(undefined)).toBeUndefined();
  });
});
