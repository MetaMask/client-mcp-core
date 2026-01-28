import type {
  ScreenshotInput,
  ScreenshotToolResult,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { getSessionManager } from "../session-manager.js";
import { runTool } from "./run-tool.js";
import { classifyScreenshotError } from "./error-classification.js";

export async function handleScreenshot(
  input: ScreenshotInput,
  options?: HandlerOptions,
): Promise<McpResponse<ScreenshotToolResult>> {
  return runTool<ScreenshotInput, ScreenshotToolResult>({
    toolName: "mm_screenshot",
    input,
    options,
    observationPolicy: "none",

    execute: async () => {
      const sessionManager = getSessionManager();
      const result = await sessionManager.screenshot({
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

    sanitizeInputForRecording: () => ({
      name: input.name,
      fullPage: input.fullPage,
      selector: input.selector,
    }),
  });
}
