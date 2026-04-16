import type { RunStepsInput, RunStepsResult, StepResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolFunction, ToolResponse } from '../types/http.js';
import { extractErrorMessage } from '../utils';
import type { ToolName } from '../validation/schemas.js';
import { toolSchemas } from '../validation/schemas.js';

/**
 * Executes a batch of tool steps sequentially.
 *
 * @param input - The batch step definitions and options.
 * @param context - The tool execution context.
 * @returns The aggregated step results and summary.
 */
export async function runStepsTool(
  input: RunStepsInput,
  context: ToolContext,
): Promise<ToolResponse<RunStepsResult>> {
  if (!context.sessionManager.hasActiveSession()) {
    return createToolError(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      'No active session. Call launch first.',
    );
  }

  if (!context.toolRegistry) {
    return createToolError(
      ErrorCodes.MM_INTERNAL_ERROR,
      'Tool registry not available.',
    );
  }

  const { steps: stepInputs, stopOnError = false } = input;
  const stepResults: StepResult[] = [];
  let succeeded = 0;
  let failed = 0;
  const batchStartTime = Date.now();

  for (const stepInput of stepInputs) {
    const stepStartTime = Date.now();
    const { tool, args = {} } = stepInput;
    const handler = context.toolRegistry.get(tool) as
      | ToolFunction<Record<string, unknown>, unknown>
      | undefined;

    if (!handler) {
      stepResults.push({
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
      });
      failed += 1;

      if (stopOnError) {
        break;
      }

      continue;
    }

    const schema =
      tool in toolSchemas ? toolSchemas[tool as ToolName] : undefined;
    let validatedArgs: Record<string, unknown> = args;
    if (schema) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        stepResults.push({
          tool,
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues
              .map((i) =>
                i.path.length > 0
                  ? `${i.path.join('.')}: ${i.message}`
                  : i.message,
              )
              .join('; '),
          },
          meta: {
            durationMs: Date.now() - stepStartTime,
            timestamp: new Date().toISOString(),
          },
        });
        failed += 1;

        if (stopOnError) {
          break;
        }

        continue;
      }
      validatedArgs = parsed.data as Record<string, unknown>;
    }

    try {
      const response = await handler(validatedArgs, context);

      stepResults.push({
        tool,
        ok: response.ok,
        result: response.ok ? response.result : undefined,
        error: response.ok ? undefined : response.error,
        meta: {
          durationMs: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
        },
      });

      if (response.ok) {
        succeeded += 1;
      } else {
        failed += 1;
        if (stopOnError) {
          break;
        }
      }
    } catch (error) {
      stepResults.push({
        tool,
        ok: false,
        error: {
          code: ErrorCodes.MM_INTERNAL_ERROR,
          message: `Unexpected error: ${extractErrorMessage(error)}`,
        },
        meta: {
          durationMs: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
        },
      });
      failed += 1;

      if (stopOnError) {
        break;
      }
    }
  }

  return createToolSuccess({
    steps: stepResults,
    summary: {
      ok: failed === 0,
      total: stepResults.length,
      succeeded,
      failed,
      durationMs: Date.now() - batchStartTime,
    },
  });
}
