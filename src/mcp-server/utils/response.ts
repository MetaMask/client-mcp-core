import type { SuccessResponse, ErrorResponse, ErrorCode } from '../types';

/**
 * Creates a standardized success response.
 *
 * @param result - The result data to include in the response.
 * @param sessionId - Optional session identifier.
 * @param startTime - Optional start time for duration calculation.
 * @returns A success response object.
 */
export function createSuccessResponse<Result>(
  result: Result,
  sessionId?: string,
  startTime?: number,
): SuccessResponse<Result> {
  return {
    meta: {
      timestamp: new Date().toISOString(),
      sessionId,
      durationMs: startTime ? Date.now() - startTime : 0,
    },
    ok: true,
    result,
  };
}

/**
 * Creates a standardized error response.
 *
 * @param code - The error code identifying the error type.
 * @param message - Human-readable error message.
 * @param details - Optional additional error details.
 * @param sessionId - Optional session identifier.
 * @param startTime - Optional start time for duration calculation.
 * @returns An error response object.
 */
export function createErrorResponse(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  sessionId?: string,
  startTime?: number,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      details,
    },
    meta: {
      timestamp: new Date().toISOString(),
      sessionId,
      durationMs: startTime ? Date.now() - startTime : 0,
    },
    ok: false,
  };
}
