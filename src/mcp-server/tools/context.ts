import type { McpResponse, HandlerOptions } from "../types/index.js";
import { runTool } from "./run-tool.js";
import { getSessionManager } from "../session-manager.js";
import { classifyContextError } from "./error-classification.js";

export type SetContextInput = { context: "e2e" | "prod" };
export type SetContextResult = {
  previousContext: "e2e" | "prod";
  newContext: "e2e" | "prod";
  availableCapabilities: string[];
};

export async function handleSetContext(
  input: SetContextInput,
  options?: HandlerOptions,
): Promise<McpResponse<SetContextResult>> {
  return runTool<SetContextInput, SetContextResult>({
    toolName: "mm_set_context",
    input,
    options,
    requiresSession: false,
    observationPolicy: "none",

    execute: async () => {
      const sessionManager = getSessionManager();

      if (!sessionManager.setContext) {
        throw new Error(
          "Context switching not supported by this session manager",
        );
      }

      const previousContext = sessionManager.getEnvironmentMode();
      sessionManager.setContext(input.context);
      const info = sessionManager.getContextInfo?.();

      return {
        previousContext,
        newContext: input.context,
        availableCapabilities: info?.capabilities.available ?? [],
      };
    },

    classifyError: classifyContextError,
  });
}

export type GetContextResult = {
  currentContext: "e2e" | "prod";
  hasActiveSession: boolean;
  sessionId: string | null;
  capabilities: { available: string[] };
  canSwitchContext: boolean;
};

export async function handleGetContext(
  input: Record<string, never>,
  options?: HandlerOptions,
): Promise<McpResponse<GetContextResult>> {
  return runTool<Record<string, never>, GetContextResult>({
    toolName: "mm_get_context",
    input,
    options,
    requiresSession: false,
    observationPolicy: "none",

    execute: async () => {
      const sessionManager = getSessionManager();

      if (sessionManager.getContextInfo) {
        return sessionManager.getContextInfo();
      }

      return {
        currentContext: sessionManager.getEnvironmentMode(),
        hasActiveSession: sessionManager.hasActiveSession(),
        sessionId: sessionManager.getSessionId() ?? null,
        capabilities: { available: [] },
        canSwitchContext: !sessionManager.hasActiveSession(),
      };
    },
  });
}
