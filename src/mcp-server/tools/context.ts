import { runTool } from './run-tool.js';
import { getSessionManager } from '../session-manager.js';
import { classifyContextError } from './error-classification.js';
import type { McpResponse, HandlerOptions } from '../types';

export type SetContextInput = {
  context: 'e2e' | 'prod';
};
export type SetContextResult = {
  previousContext: 'e2e' | 'prod';
  newContext: 'e2e' | 'prod';
  availableCapabilities: string[];
};

/**
 * Handle setting the workflow context (e2e or prod).
 *
 * @param input The context input containing the desired context mode
 * @param options Optional handler options for the operation
 * @returns Promise resolving to the context change result with previous and new context
 */
export async function handleSetContext(
  input: SetContextInput,
  options?: HandlerOptions,
): Promise<McpResponse<SetContextResult>> {
  return runTool<SetContextInput, SetContextResult>({
    toolName: 'mm_set_context',
    input,
    options,
    requiresSession: false,
    observationPolicy: 'none',

    /**
     * Execute the context switch operation.
     *
     * @returns The result containing previous context, new context, and available capabilities
     */
    execute: async () => {
      const sessionManager = getSessionManager();
      const previousContext = sessionManager.getEnvironmentMode();
      sessionManager.setContext(input.context);
      const info = sessionManager.getContextInfo();

      return {
        previousContext,
        newContext: input.context,
        availableCapabilities: info.capabilities.available,
      };
    },

    classifyError: classifyContextError,
  });
}

export type GetContextResult = {
  currentContext: 'e2e' | 'prod';
  hasActiveSession: boolean;
  sessionId: string | null;
  capabilities: {
    available: string[];
  };
  canSwitchContext: boolean;
};

/**
 * Handle getting the current workflow context and capabilities.
 *
 * @param input Empty input object for this operation
 * @param options Optional handler options for the operation
 * @returns Promise resolving to the current context, session state, and available capabilities
 */
export async function handleGetContext(
  input: Record<string, never>,
  options?: HandlerOptions,
): Promise<McpResponse<GetContextResult>> {
  return runTool<Record<string, never>, GetContextResult>({
    toolName: 'mm_get_context',
    input,
    options,
    requiresSession: false,
    observationPolicy: 'none',

    /**
     * Execute the get context operation.
     *
     * @returns The result containing current context, session state, and capabilities
     */
    execute: async () => {
      const sessionManager = getSessionManager();
      return sessionManager.getContextInfo();
    },
  });
}
