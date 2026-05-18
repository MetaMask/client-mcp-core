import type { CdpInput, CdpResult } from './types';
import { ErrorCodes } from './types/errors.js';
import { withCdpSession } from './utils/cdp.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * CDP methods that would destroy session state and break all other tools.
 * Kept intentionally small — this is an escape hatch, not a sandbox.
 */
const CDP_BLOCKED_METHODS = new Set([
  'Browser.close',
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Browser.crashGpuProcess',
]);

/**
 * Sends a raw CDP command against the active page.
 *
 * Escape hatch for cases where structured tools are insufficient.
 * State-changing methods (e.g. Page.navigate) bypass session tracking —
 * run describe_screen afterward to re-sync.
 *
 * @param input - The CDP command input (method, params, timeout).
 * @param context - The tool execution context with session and page access.
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

  if (CDP_BLOCKED_METHODS.has(input.method)) {
    return createToolError(
      ErrorCodes.MM_CDP_BLOCKED,
      `CDP method "${input.method}" is blocked because it would destroy the browser session. ` +
        `Blocked methods: ${[...CDP_BLOCKED_METHODS].join(', ')}`,
    );
  }

  try {
    return await withCdpSession(context.page, async (cdpSession) => {
      const { timeoutMs } = input;

      // Playwright types send() for known CDP methods only; widen for arbitrary passthrough.
      const send = cdpSession.send.bind(cdpSession) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          send(input.method, input.params ?? {}),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `CDP call "${input.method}" timed out after ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);

        return createToolSuccess<CdpResult>({
          method: input.method,
          result,
        });
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return createToolError(
      ErrorCodes.MM_CDP_FAILED,
      `CDP "${input.method}" failed: ${message}`,
    );
  }
}
