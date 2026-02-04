import { getSessionManager } from '../session-manager.js';
import type {
  McpResponse,
  HandlerOptions,
  RunStepsInput,
  RunStepsResult,
  StepResult,
  ObservationPolicyOverride,
} from '../types';
import { ErrorCodes } from '../types';
import {
  createSuccessResponse,
  createErrorResponse,
  extractErrorMessage,
} from '../utils';

/**
 * Maps includeObservations string to observation policy override.
 *
 * @param value The observation policy string ('none', 'failures', 'all', or undefined)
 * @returns The mapped observation policy override
 */
function mapIncludeObservationsToPolicy(
  value: 'none' | 'failures' | 'all' | undefined,
): ObservationPolicyOverride {
  switch (value) {
    case 'none':
      return 'none';
    case 'failures':
      return 'failures';
    case 'all':
    default:
      return 'default';
  }
}

/**
 * Handler function type for executing MCP tools.
 *
 * @param input Tool arguments as key-value pairs
 * @param options Optional handler configuration
 * @returns Promise resolving to MCP response with tool result
 */
export type ToolHandler = (
  input: Record<string, unknown>,
  options?: HandlerOptions,
) => Promise<McpResponse<unknown>>;

/**
 * Registry mapping tool names to their handler functions.
 *
 * @returns Record of tool name to handler function mappings
 */
export type ToolRegistry = Record<string, ToolHandler>;

/**
 * Validator function type for validating tool arguments before execution.
 *
 * @param tool Tool name being validated
 * @param args Tool arguments to validate
 * @returns Validation result with success status and optional error details
 */
export type ToolValidator = (
  tool: string,
  args: Record<string, unknown>,
) =>
  | {
      /**
       * Validation succeeded
       */
      success: true;
    }
  | {
      /**
       * Validation failed
       */
      success: false;
      /**
       * Error details when validation fails
       */
      error: {
        /**
         * Error message describing validation failure
         */
        message: string;
      };
    };

let _toolRegistry: ToolRegistry = {};
let _toolValidator: ToolValidator | undefined;

/**
 * Sets the global tool registry for batch execution.
 *
 * @param registry Tool registry mapping names to handlers
 */
export function setToolRegistry(registry: ToolRegistry): void {
  _toolRegistry = registry;
}

/**
 * Gets the current global tool registry.
 *
 * @returns The current tool registry
 */
export function getToolRegistry(): ToolRegistry {
  return _toolRegistry;
}

/**
 * Checks if the tool registry has any registered handlers.
 *
 * @returns True if registry contains handlers, false otherwise
 */
export function hasToolRegistry(): boolean {
  return Object.keys(_toolRegistry).length > 0;
}

/**
 * Sets the global tool validator for batch execution.
 *
 * @param validator Validator function to validate tool arguments
 */
export function setToolValidator(validator: ToolValidator): void {
  _toolValidator = validator;
}

/**
 * Gets the current global tool validator.
 *
 * @returns The current tool validator or undefined if not set
 */
export function getToolValidator(): ToolValidator | undefined {
  return _toolValidator;
}

/**
 * Executes multiple tool steps in sequence with optional validation and error handling.
 *
 * @param input Steps to execute with optional stop-on-error and observation policy
 * @param options Optional handler configuration and observation policy override
 * @returns Promise resolving to MCP response with step results and summary
 */
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
      'No active session. Call launch first.',
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
