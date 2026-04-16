import type { RunStepsInput, RunStepsResult, StepResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolFunction, ToolResponse } from '../types/http.js';
import { extractErrorMessage } from '../utils';
import type { ToolName } from '../validation/schemas.js';
import { toolSchemas } from '../validation/schemas.js';

/** Tools whose args include a target selection (a11yRef/testId/selector). */
const TARGET_TOOLS = new Set(['click', 'type', 'wait_for']);

/**
 * Maps CLI-style compound tool names to their registry name + injected args.
 * The CLI handles these conversions for standalone commands, but agents using
 * run-steps bypass CLI parsing and may send compound names directly.
 */
const TOOL_ALIASES: Record<
  string,
  { tool: string; inject: Record<string, unknown> }
> = {
  navigate_home: { tool: 'navigate', inject: { screen: 'home' } },
  'navigate-home': { tool: 'navigate', inject: { screen: 'home' } },
  navigate_settings: { tool: 'navigate', inject: { screen: 'settings' } },
  'navigate-settings': { tool: 'navigate', inject: { screen: 'settings' } },
  navigate_notification: {
    tool: 'navigate',
    inject: { screen: 'notification' },
  },
  'navigate-notification': {
    tool: 'navigate',
    inject: { screen: 'notification' },
  },
};

type NormalisedStep = {
  tool: string;
  args: Record<string, unknown>;
};

/**
 * Resolves tool aliases and normalises shorthand arg keys.
 *
 * @param tool - Raw tool name (may be an alias like `navigate_home`).
 * @param args - Raw step arguments.
 * @returns Resolved tool name and normalised arguments.
 */
function normaliseStep(
  tool: string,
  args: Record<string, unknown>,
): NormalisedStep {
  const alias = TOOL_ALIASES[tool];
  const resolvedTool = alias ? alias.tool : tool;
  let normalised = alias ? { ...alias.inject, ...args } : args;

  if (TARGET_TOOLS.has(resolvedTool)) {
    if ('ref' in normalised && !('a11yRef' in normalised)) {
      const { ref, ...rest } = normalised;
      normalised = { a11yRef: ref, ...rest };
    }

    if (typeof normalised.within === 'object' && normalised.within !== null) {
      const withinObj = normalised.within as Record<string, unknown>;
      if ('ref' in withinObj && !('a11yRef' in withinObj)) {
        const { ref: withinRef, ...withinRest } = withinObj;
        normalised = {
          ...normalised,
          within: { a11yRef: withinRef, ...withinRest },
        };
      }
    }
  }

  return { tool: resolvedTool, args: normalised };
}

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

  const { steps: stepInputs, stopOnError = false, batchTimeoutMs } = input;
  const stepResults: StepResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const batchStartTime = Date.now();
  const batchDeadline = batchTimeoutMs
    ? batchStartTime + batchTimeoutMs
    : undefined;

  for (const stepInput of stepInputs) {
    if (batchDeadline && Date.now() > batchDeadline) {
      const remainingIndex = stepInputs.indexOf(stepInput);
      for (const remaining of stepInputs.slice(remainingIndex)) {
        stepResults.push({
          tool: remaining.tool,
          ok: false,
          error: {
            code: 'MM_BATCH_TIMEOUT',
            message: `Batch deadline exceeded after ${batchTimeoutMs}ms`,
          },
          meta: {
            durationMs: 0,
            timestamp: new Date().toISOString(),
            skipped: true,
          },
        });
        skipped += 1;
        failed += 1;
      }
      break;
    }
    const stepStartTime = Date.now();
    const { tool: rawTool, args: rawArgs = {} } = stepInput;
    const { tool, args } = normaliseStep(rawTool, rawArgs);
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
      skipped,
      durationMs: Date.now() - batchStartTime,
    },
  });
}
