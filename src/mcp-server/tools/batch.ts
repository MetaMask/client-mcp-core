import type {
  McpResponse,
  HandlerOptions,
  RunStepsInput,
  RunStepsResult,
  StepResult,
  ObservationPolicyOverride,
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createSuccessResponse, createErrorResponse, extractErrorMessage } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";

function mapIncludeObservationsToPolicy(
  value: "none" | "failures" | "all" | undefined,
): ObservationPolicyOverride {
  switch (value) {
    case "none":
      return "none";
    case "failures":
      return "failures";
    case "all":
    default:
      return "default";
  }
}

export type ToolHandler = (
  input: Record<string, unknown>,
  options?: HandlerOptions,
) => Promise<McpResponse<unknown>>;

export type ToolRegistry = Record<string, ToolHandler>;

export type ToolValidator = (
  tool: string,
  args: Record<string, unknown>,
) => { success: true } | { success: false; error: { message: string } };

let _toolRegistry: ToolRegistry = {};
let _toolValidator: ToolValidator | undefined;

export function setToolRegistry(registry: ToolRegistry): void {
  _toolRegistry = registry;
}

export function getToolRegistry(): ToolRegistry {
  return _toolRegistry;
}

export function hasToolRegistry(): boolean {
  return Object.keys(_toolRegistry).length > 0;
}

export function setToolValidator(validator: ToolValidator): void {
  _toolValidator = validator;
}

export function getToolValidator(): ToolValidator | undefined {
  return _toolValidator;
}

export async function handleRunSteps(
  input: RunStepsInput,
  options?: HandlerOptions,
): Promise<McpResponse<RunStepsResult>> {
  const batchStartTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

   if (!sessionManager.hasActiveSession()) {
     return createErrorResponse(
       ErrorCodes.MM_NO_ACTIVE_SESSION,
       "No active session. Call launch first.",
       { input },
       undefined,
       batchStartTime,
     );
   }

  const { steps: stepInputs, stopOnError = false, includeObservations } = input;
  const observationPolicy = mapIncludeObservationsToPolicy(includeObservations);
  const stepResults: StepResult[] = [];
  let succeeded = 0;
  let failed = 0;

  const toolHandlers = getToolRegistry();
  const toolValidator = getToolValidator();

  for (const stepInput of stepInputs) {
    const stepStartTime = Date.now();
    const { tool, args = {} } = stepInput;

    const handler = toolHandlers[tool];
    if (!handler) {
      const result: StepResult = {
        tool,
        ok: false,
        error: {
          code: ErrorCodes.MM_UNKNOWN_TOOL,
          message: `Unknown tool: ${tool}`,
        },
        meta: {
          durationMs: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
        },
      };
      stepResults.push(result);
      failed += 1;

      if (stopOnError) {
        break;
      }
      continue;
    }

    if (toolValidator) {
      const validation = toolValidator(tool, args);
      if (!validation.success) {
        const result: StepResult = {
          tool,
          ok: false,
          error: {
            code: ErrorCodes.MM_INVALID_INPUT,
            message: `Invalid input: ${validation.error.message}`,
          },
          meta: {
            durationMs: Date.now() - stepStartTime,
            timestamp: new Date().toISOString(),
          },
        };
        stepResults.push(result);
        failed += 1;

        if (stopOnError) {
          break;
        }
        continue;
      }
    }

    try {
      const stepOptions: HandlerOptions = {
        ...options,
        observationPolicy,
      };
      const response = await handler(args, stepOptions);

      const result: StepResult = {
        tool,
        ok: response.ok,
        result: response.ok ? response.result : undefined,
        error: response.ok ? undefined : response.error,
        meta: {
          durationMs: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
        },
      };

      stepResults.push(result);

      if (response.ok) {
        succeeded += 1;
      } else {
        failed += 1;
        if (stopOnError) {
          break;
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      const result: StepResult = {
        tool,
        ok: false,
        error: {
          code: ErrorCodes.MM_INTERNAL_ERROR,
          message: `Unexpected error: ${message}`,
        },
        meta: {
          durationMs: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
        },
      };
      stepResults.push(result);
      failed += 1;

      if (stopOnError) {
        break;
      }
    }
  }

  const batchResult: RunStepsResult = {
    steps: stepResults,
    summary: {
      ok: failed === 0,
      total: stepResults.length,
      succeeded,
      failed,
      durationMs: Date.now() - batchStartTime,
    },
  };

  return createSuccessResponse(batchResult, sessionId, batchStartTime);
}
