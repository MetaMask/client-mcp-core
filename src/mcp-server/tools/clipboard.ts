import { runTool } from './run-tool.js';
import type {
  ClipboardInput,
  ClipboardResult,
  McpResponse,
  HandlerOptions,
} from '../types';

/**
 * Clipboard handler using CDP (Chrome DevTools Protocol) to bypass LavaMoat restrictions.
 *
 * Why CDP instead of page.evaluate()?
 * - page.evaluate() runs JavaScript inside the page context, which is wrapped by LavaMoat
 * - LavaMoat restricts access to navigator.clipboard in the page context
 * - CDP's Runtime.evaluate runs at the browser/DevTools level, bypassing LavaMoat
 * - userGesture: true simulates a user gesture to satisfy clipboard security requirements
 *
 * @param input Clipboard action ('read' or 'write') with optional text content
 * @param options Optional handler configuration
 * @returns Promise resolving to MCP response with clipboard operation result
 */
export async function handleClipboard(
  input: ClipboardInput,
  options?: HandlerOptions,
): Promise<McpResponse<ClipboardResult>> {
  return runTool<ClipboardInput, ClipboardResult>({
    toolName: 'mm_clipboard',
    input,
    options,

    /**
     * Executes the clipboard operation using CDP.
     *
     * @param context Tool execution context with page and session info
     * @returns Promise resolving to clipboard operation result
     */
    execute: async (context) => {
      if (!context.page) {
        throw new Error('No page available for clipboard operation');
      }
      const { page } = context;
      const cdpSession = await page.context().newCDPSession(page);

      try {
        if (input.action === 'write') {
          await cdpSession.send('Runtime.evaluate', {
            expression: `navigator.clipboard.writeText(${JSON.stringify(input.text)})`,
            awaitPromise: true,
            userGesture: true,
          });

          return {
            action: 'write',
            success: true,
            text: input.text,
          };
        }

        const result = await cdpSession.send('Runtime.evaluate', {
          expression: `navigator.clipboard.readText()`,
          awaitPromise: true,
          userGesture: true,
        });

        const clipboardText =
          result.result?.value ?? result.result?.description ?? '';

        return {
          action: 'read',
          success: true,
          text: clipboardText as string,
        };
      } finally {
        // eslint-disable-next-line no-empty-function
        await cdpSession.detach().catch(() => {});
      }
    },

    /**
     * Classifies clipboard errors into specific error codes.
     *
     * @param error The error to classify
     * @returns Error classification with code and message
     */
    classifyError: (error) => {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('permissions') || message.includes('denied')) {
        return {
          code: 'MM_CLIPBOARD_PERMISSION_DENIED',
          message: `Clipboard permission denied: ${message}`,
        };
      }

      if (message.includes('LavaMoat') || message.includes('policy')) {
        return {
          code: 'MM_CLIPBOARD_LAVAMOAT_BLOCKED',
          message: `Clipboard blocked by LavaMoat policy: ${message}`,
        };
      }

      return {
        code: 'MM_CLIPBOARD_FAILED',
        message: `Clipboard operation failed: ${message}`,
      };
    },

    /**
     * Sanitizes clipboard input for recording (removes sensitive text).
     *
     * @param inp The clipboard input to sanitize
     * @returns Sanitized input with text length instead of actual text
     */
    sanitizeInputForRecording: (inp) => ({
      action: inp.action,
      // Don't record the actual text content for privacy (could be SRP, passwords, etc.)
      textLength: inp.text?.length ?? 0,
    }),
  });
}
