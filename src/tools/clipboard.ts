import type { ClipboardInput, ClipboardResult } from './types';
import { withCdpSession } from './utils/cdp.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Reads from or writes to the system clipboard via CDP.
 *
 * @param input - The clipboard action and optional text payload.
 * @param context - The tool execution context.
 * @returns The clipboard operation result with the text content.
 */
export async function clipboardTool(
  input: ClipboardInput,
  context: ToolContext,
): Promise<ToolResponse<ClipboardResult>> {
  const missingSession = requireActiveSession<ClipboardResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    return await withCdpSession(context.page, async (cdpSession) => {
      if (input.action === 'write') {
        await cdpSession.send('Runtime.evaluate', {
          expression: `navigator.clipboard.writeText(${JSON.stringify(input.text)})`,
          awaitPromise: true,
          userGesture: true,
        });

        return createToolSuccess<ClipboardResult>({
          action: 'write',
          success: true,
          text: input.text,
        });
      }

      const result = await cdpSession.send('Runtime.evaluate', {
        expression: 'navigator.clipboard.readText()',
        awaitPromise: true,
        userGesture: true,
      });

      const clipboardText =
        result.result?.value ?? result.result?.description ?? '';

      return createToolSuccess<ClipboardResult>({
        action: 'read',
        success: true,
        text: clipboardText as string,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('permissions') || message.includes('denied')) {
      return createToolError(
        'MM_CLIPBOARD_PERMISSION_DENIED',
        `Clipboard permission denied: ${message}`,
      );
    }

    if (message.includes('LavaMoat') || message.includes('policy')) {
      return createToolError(
        'MM_CLIPBOARD_LAVAMOAT_BLOCKED',
        `Clipboard blocked by LavaMoat policy: ${message}`,
      );
    }

    return createToolError(
      'MM_CLIPBOARD_FAILED',
      `Clipboard operation failed: ${message}`,
    );
  }
}
