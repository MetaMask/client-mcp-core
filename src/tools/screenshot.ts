import { classifyScreenshotError } from './error-classification.js';
import type { ScreenshotInput, ScreenshotToolResult } from './types';
import { ErrorCodes } from './types';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Captures a screenshot of the current page.
 *
 * @param input - The screenshot options including name, selector, and base64 flag.
 * @param context - The tool execution context.
 * @returns The screenshot metadata and optional base64 data.
 */
export async function screenshotTool(
  input: ScreenshotInput,
  context: ToolContext,
): Promise<ToolResponse<ScreenshotToolResult>> {
  const missingSession = requireActiveSession<ScreenshotToolResult>(context);
  if (missingSession) {
    return missingSession;
  }

  if (!context.driver) {
    return createToolError(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      'No platform driver available',
    );
  }

  try {
    const screenshotName = input.name ?? `screenshot-${Date.now()}`;
    const result = await context.driver.screenshot({
      name: screenshotName,
      fullPage: input.fullPage ?? true,
      selector: input.selector,
      includeBase64: input.includeBase64,
    });

    const response: ScreenshotToolResult = {
      path: result.path,
      ...(result.width === undefined ? {} : { width: result.width }),
      ...(result.height === undefined ? {} : { height: result.height }),
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
