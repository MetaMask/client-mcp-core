import type { CleanupInput, CleanupResult } from './types';
import { createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Tears down the active browser session and cleans up resources.
 *
 * Platform-specific resource cleanup (e.g. iOS XCUITest runners) is the
 * responsibility of the consumer's {@link ISessionManager.cleanup}
 * implementation. Process-level signal handlers in runner-lifecycle.ts
 * provide defense-in-depth for orphaned processes.
 *
 * @param _input - Unused input parameters.
 * @param context - The tool execution context.
 * @returns The cleanup result indicating what was cleaned up.
 */
export async function cleanupTool(
  _input: CleanupInput,
  context: ToolContext,
): Promise<ToolResponse<CleanupResult>> {
  const cleanedUp = await context.sessionManager.cleanup();

  return createToolSuccess({ cleanedUp });
}
