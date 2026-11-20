import type { ConsoleRecord, LogsInput, LogsResult } from './types';
import { ErrorCodes } from './types/errors.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import {
  DEFAULT_EVENT_READ_LIMIT,
  parseSince,
} from '../events/read-options.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/** Longest accepted `--grep` pattern, to bound regular-expression work. */
export const MAX_GREP_PATTERN_LENGTH = 256;

/**
 * Reads console errors and uncaught exceptions of every page and the
 * Extension service worker (`mm logs`), or changes the recorded levels
 * (`mm logs configure`).
 *
 * @param input - Read options, or the `configure` action.
 * @param context - The tool execution context.
 * @returns A page of console records, or the new config.
 */
export async function logsTool(
  input: LogsInput,
  context: ToolContext,
): Promise<ToolResponse<LogsResult>> {
  const missingSession = requireActiveSession<LogsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const events = getSessionEvents(context.sessionManager.getContext());
  await events.ensureStarted();

  if (input.action === 'configure') {
    events.config = {
      ...events.config,
      consoleLevels: [...new Set(input.levels)],
    };
    return createToolSuccess({
      action: 'configure',
      config: { levels: [...events.config.consoleLevels] },
      summary: events.buffer.summary(),
    });
  }

  let grep: RegExp | undefined;
  if (input.grep !== undefined) {
    if (input.grep.length > MAX_GREP_PATTERN_LENGTH) {
      return createToolError(
        ErrorCodes.MM_INVALID_INPUT,
        `Invalid --grep pattern: longer than ${MAX_GREP_PATTERN_LENGTH} characters`,
      );
    }
    try {
      grep = new RegExp(input.grep, 'u');
    } catch {
      try {
        // Not valid in unicode mode (for example `foo\-bar`): the same
        // JavaScript regular expression without `u` is accepted.
        // eslint-disable-next-line require-unicode-regexp -- The fallback exists for patterns that `u` rejects.
        grep = new RegExp(input.grep);
      } catch (error) {
        return createToolError(
          ErrorCodes.MM_INVALID_INPUT,
          `Invalid --grep pattern: ${(error as Error).message}`,
        );
      }
    }
  }

  return createToolSuccess(
    events.buffer.read<ConsoleRecord>({
      kind: 'console',
      cursor: input.cursor,
      since: parseSince(input.since),
      limit: input.limit ?? DEFAULT_EVENT_READ_LIMIT,
      filter: grep ? (record): boolean => grep.test(record.text) : undefined,
    }),
  );
}
