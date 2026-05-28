import { classifyScreenshotError } from './error-classification.js';
import type { ScreenshotInput, ScreenshotToolResult } from './types';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

export async function screenshotTool(
  input: ScreenshotInput,
  context: ToolContext,
): Promise<ToolResponse<ScreenshotToolResult>> {
  const missingSession = requireActiveSession<ScreenshotToolResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    const screenshotName = input.name ?? `screenshot-${Date.now()}`;
    const result = context.driver
      ? await context.driver.screenshot({
          name: screenshotName,
          fullPage: input.fullPage ?? true,
          selector: input.selector,
          includeBase64: input.includeBase64,
        })
      : await context.sessionManager.screenshot({
          name: screenshotName,
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

    return createToolSuccess(response);
  } catch (error) {
    const errorInfo = classifyScreenshotError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
