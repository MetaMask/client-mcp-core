import type {
  CleanupInput,
  CleanupResult,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { createSuccessResponse } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";

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
