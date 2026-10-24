import { ErrorCodes } from './types';
import type { A11yNodeTrimmed } from './types/discovery.js';
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

/**
 * Returns an error response when the request was aborted (it timed out).
 * Tools call it between steps so a timed-out request stops early.
 *
 * @param context - The tool execution context.
 * @returns An error response when aborted, or undefined.
 */
export function abortedResponse<TResult>(
  context: ToolContext,
): ToolResponse<TResult> | undefined {
  if (context.signal?.aborted) {
    return createToolError(
      ErrorCodes.MM_REQUEST_ABORTED,
      'The request timed out and was cancelled.',
    );
  }
  return undefined;
}

/**
 * Sets the refMap through the request's guarded setter when the daemon
 * provides one, else directly on the session manager.
 *
 * @param context - The tool execution context.
 * @param map - The new ref map.
 * @param nodes - The nodes the map was built from.
 * @returns The map and nodes to return to the agent. The daemon may renumber
 * refs so elements the agent already holds keep their refs; without the
 * daemon the input is returned unchanged.
 */
export function setToolRefMap(
  context: ToolContext,
  map: Map<string, string>,
  nodes: A11yNodeTrimmed[],
): { refMap: Map<string, string>; nodes: A11yNodeTrimmed[] } {
  if (context.setRefMap) {
    const written = context.setRefMap(map, nodes);
    return { refMap: written.refMap, nodes: written.nodes ?? nodes };
  }
  context.sessionManager.setRefMap(map);
  return { refMap: map, nodes };
}
