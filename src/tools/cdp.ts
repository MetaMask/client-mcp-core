import type { CdpInput } from './types';
import { ErrorCodes } from './types/errors.js';
import type { CdpResult } from './types/tool-outputs.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Sends a raw CDP command against the active session, dispatched through the
 * platform driver. On the browser this targets the page's Chrome CDP session
 * (full Runtime/DOM/Network/Page surface); on mobile it targets the React
 * Native Hermes JS runtime via Metro (Runtime/Debugger subset only). Each
 * driver owns its own destructive-method blocklist.
 *
 * Escape hatch for cases where structured tools are insufficient. State-changing
 * methods bypass session tracking — run describe_screen afterward to re-sync.
 *
 * @param input - The CDP command input (method, params, timeout, and optional
 * mobile-only metroPort/appId overrides).
 * @param context - The tool execution context with session and driver access.
 * @returns The CDP command result or an error response.
 */
export async function cdpTool(
  input: CdpInput,
  context: ToolContext,
): Promise<ToolResponse<CdpResult>> {
  const missingSession = requireActiveSession<CdpResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver) {
    return createToolError(
      ErrorCodes.MM_CDP_FAILED,
      'No platform driver available',
    );
  }

  try {
    const outcome = await driver.cdp(input);
    if (!outcome.ok) {
      return createToolError(outcome.code, outcome.message);
    }
    return createToolSuccess<CdpResult>({
      method: input.method,
      result: outcome.result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_CDP_FAILED,
      `CDP "${input.method}" failed: ${message}`,
    );
  }
}
