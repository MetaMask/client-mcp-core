import { ErrorCodes } from './types';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Wraps a result value in a successful tool response.
 *
 * @param result - The result payload to return.
 * @returns A successful tool response containing the result.
 */
export function createToolSuccess<TResult>(
  result: TResult,
): ToolResponse<TResult> {
  return { ok: true, result };
}

/**
 * Wraps an error code and message in a failed tool response.
 *
 * @param code - The error code identifying the failure type.
 * @param message - A human-readable error description.
 * @returns A failed tool response containing the error.
 */
export function createToolError<TResult = never>(
  code: string,
  message: string,
): ToolResponse<TResult> {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

/**
 * Returns an error response if no active session exists.
 *
 * @param context - The tool execution context.
 * @returns An error response when no session is active, or undefined.
 */
export function requireActiveSession<TResult>(
  context: ToolContext,
): ToolResponse<TResult> | undefined {
  if (!context.sessionManager.hasActiveSession()) {
    return createToolError(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      'No active session. Call launch first.',
    );
  }

  return undefined;
}
