import { getSessionManager } from '../session-manager.js';
import type {
  CleanupInput,
  CleanupResult,
  McpResponse,
  HandlerOptions,
} from '../types';
import { createSuccessResponse } from '../utils';

/**
 * Handles the cleanup tool request to stop browser and services.
 *
 * @param input - The cleanup input parameters.
 * @param _options - Handler options (unused).
 * @returns Response indicating if cleanup was performed.
 */
export async function handleCleanup(
  input: CleanupInput,
  _options?: HandlerOptions,
): Promise<McpResponse<CleanupResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = input.sessionId ?? sessionManager.getSessionId();

  const cleanedUp = await sessionManager.cleanup();

  return createSuccessResponse<CleanupResult>(
    { cleanedUp },
    sessionId,
    startTime,
  );
}
