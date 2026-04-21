import type { CleanupInput, CleanupResult } from './types';
import { createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Tears down the active browser session and cleans up resources.
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
