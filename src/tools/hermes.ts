import type { HermesTargetsInput } from './types';
import { ErrorCodes } from './types/errors.js';
import type { HermesTargetsResult } from './types/tool-outputs.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Lists and diagnoses the debuggable React Native Hermes targets Metro exposes,
 * reporting which target would be chosen or why selection is ambiguous. Mobile
 * only (iOS/Android) — the browser platform has no Hermes runtime. Useful to
 * confirm Metro is running and the app is registered, and to discover the real
 * appId via `all`.
 *
 * Raw CDP execution lives in the unified `cdp` tool; this tool only inspects
 * the Metro target list, which has no browser equivalent.
 *
 * @param input - Optional Metro port / appId overrides and an `all` flag.
 * @param context - The tool execution context with session and driver access.
 * @returns The structured targets report or an error response.
 */
export async function hermesTargetsTool(
  input: HermesTargetsInput,
  context: ToolContext,
): Promise<ToolResponse<HermesTargetsResult>> {
  const missingSession = requireActiveSession<HermesTargetsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.hermesTargets) {
    return createToolError(
      ErrorCodes.MM_HERMES_NOT_AVAILABLE,
      'Hermes targets is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    const result = await driver.hermesTargets(input);
    return createToolSuccess<HermesTargetsResult>(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_HERMES_FAILED,
      `Hermes targets discovery failed: ${message}`,
    );
  }
}
