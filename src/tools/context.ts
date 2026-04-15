import { classifyContextError } from './error-classification.js';
import type { SetContextInput } from './types/tool-inputs.js';
import type {
  SetContextResult,
  GetContextResult,
} from './types/tool-outputs.js';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

export type { SetContextInput } from './types/tool-inputs.js';
export type {
  SetContextResult,
  GetContextResult,
} from './types/tool-outputs.js';

/**
 * Switches the session environment context between e2e and prod modes.
 *
 * @param input - The target context and optional configuration.
 * @param context - The tool execution context.
 * @returns The previous and new context with available capabilities.
 */
export async function setContextTool(
  input: SetContextInput,
  context: ToolContext,
): Promise<ToolResponse<SetContextResult>> {
  try {
    const previousContext = context.sessionManager.getEnvironmentMode();
    context.sessionManager.setContext(input.context, input.options);
    const info = context.sessionManager.getContextInfo();

    return createToolSuccess({
      previousContext,
      newContext: input.context,
      availableCapabilities: info.capabilities.available,
    });
  } catch (error) {
    const errorInfo = classifyContextError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Retrieves the current session context, capabilities, and status.
 *
 * @param _input - Unused input parameters.
 * @param context - The tool execution context.
 * @returns The current context information.
 */
export async function getContextTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<GetContextResult>> {
  return createToolSuccess(context.sessionManager.getContextInfo());
}
