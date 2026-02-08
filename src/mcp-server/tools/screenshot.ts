import { classifyScreenshotError } from './error-classification.js';
import { runTool } from './run-tool.js';
import type {
  ScreenshotInput,
  ScreenshotToolResult,
  McpResponse,
  HandlerOptions,
} from '../types';

/**
 * Handles the screenshot tool request.
 *
 * @param input - The screenshot input parameters.
 * @param options - Handler options including abort signal.
 * @returns Response with screenshot path and dimensions.
 */
export async function handleScreenshot(
  input: ScreenshotInput,
  options?: HandlerOptions,
): Promise<McpResponse<ScreenshotToolResult>> {
  return runTool<ScreenshotInput, ScreenshotToolResult>({
    toolName: 'mm_screenshot',
    input,
    options,
    observationPolicy: 'none',

    /**
     * Executes the screenshot capture.
     *
     * @returns The screenshot result.
     */
    execute: async (context) => {
      const result = await context.driver!.screenshot({
        name: input.name,
        fullPage: input.fullPage ?? true,
        selector: input.selector,
      });

      const response: ScreenshotToolResult = {
        path: result.path,
        width: result.width,
        height: result.height,
      };

      if (input.includeBase64) {
        response.base64 = result.base64;
      }

      return response;
    },

    classifyError: classifyScreenshotError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object.
     */
    sanitizeInputForRecording: () => ({
      name: input.name,
      fullPage: input.fullPage,
      selector: input.selector,
    }),
  });
}
