import type { Page } from '@playwright/test';

import type { IPlatformDriver } from '../../platform/types.js';
import { PlaywrightPlatformDriver } from '../../platform/playwright-driver.js';

import type { ExtensionState } from '../../capabilities/types.js';
import { knowledgeStore } from '../knowledge-store.js';
import { getSessionManager } from '../session-manager.js';
import { collectObservation } from './helpers.js';
import type {
  McpResponse,
  HandlerOptions,
  StepRecordObservation,
  ErrorCode,
} from '../types';
import { ErrorCodes } from '../types';
import {
  createSuccessResponse,
  createErrorResponse,
  extractErrorMessage,
  debugWarn,
} from '../utils';

/**
 * Creates an empty observation object for step recording.
 *
 * @returns Empty observation with default state, testIds, and a11y nodes
 */
function createEmptyObservation(): StepRecordObservation {
  return {
    state: {} as ExtensionState,
    testIds: [],
    a11y: { nodes: [] },
  };
}

export type ObservationPolicy = 'none' | 'default' | 'custom' | 'failures';

export type ToolExecutionContext = {
  sessionId: string | undefined;
  page: Page | undefined;
  driver?: IPlatformDriver;
  refMap: Map<string, string>;
  startTime: number;
};

let _platformDriver: IPlatformDriver | undefined;

export function setPlatformDriver(driver: IPlatformDriver): void {
  _platformDriver = driver;
}

export function getPlatformDriver(): IPlatformDriver | undefined {
  return _platformDriver;
}

export function clearPlatformDriver(): void {
  _platformDriver = undefined;
}

export type ToolExecuteResult<TResult> = {
  result: TResult;
  observation?: StepRecordObservation;
};

export type ToolExecutionConfig<TInput, TResult> = {
  toolName: string;
  input: TInput;
  options?: HandlerOptions;
  requiresSession?: boolean;
  observationPolicy?: ObservationPolicy;
  execute: (
    context: ToolExecutionContext,
  ) => Promise<TResult | ToolExecuteResult<TResult>>;
  classifyError?: (error: unknown) => {
    code: string;
    message: string;
  };
  getTarget?: (input: TInput) =>
    | {
        testId?: string;
        selector?: string;
        a11yRef?: string;
      }
    | undefined;
  sanitizeInputForRecording?: (input: TInput) => Record<string, unknown>;
};

/**
 * Type guard to check if result is a ToolExecuteResult with observation.
 *
 * @param result The result to check
 * @returns True if result is a ToolExecuteResult with observation property
 */
function isToolExecuteResult<TResult>(
  result: TResult | ToolExecuteResult<TResult>,
): result is ToolExecuteResult<TResult> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'result' in result &&
    Object.prototype.hasOwnProperty.call(result, 'result')
  );
}

/**
 * Executes a tool with error handling, observation collection, and knowledge store recording.
 *
 * @param config The tool execution configuration with input, execute function, and error handling
 * @returns Promise resolving to MCP response with tool result or error information
 */
export async function runTool<TInput, TResult>(
  config: ToolExecutionConfig<TInput, TResult>,
): Promise<McpResponse<TResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const requiresSession = config.requiresSession ?? true;

  const effectivePolicy =
    config.options?.observationPolicy ?? config.observationPolicy ?? 'default';

  let driver: IPlatformDriver | undefined;

  try {
    if (requiresSession && !sessionManager.hasActiveSession()) {
      return createErrorResponse(
        ErrorCodes.MM_NO_ACTIVE_SESSION,
        'No active session. Call launch first.',
        { input: config.input },
        undefined,
        startTime,
      );
    }

    const page = requiresSession ? sessionManager.getPage() : undefined;
    driver = requiresSession
      ? (_platformDriver ??
        new PlaywrightPlatformDriver(
          () => sessionManager.getPage(),
          sessionManager,
        ))
      : undefined;

    const context: ToolExecutionContext = {
      sessionId,
      page,
      driver,
      refMap: requiresSession ? sessionManager.getRefMap() : new Map(),
      startTime,
    };

    if (context.driver && !context.driver.isToolSupported(config.toolName)) {
      return createErrorResponse(
        ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
        `Tool ${config.toolName} is not supported on ${context.driver.getPlatform()} platform`,
        { toolName: config.toolName, platform: context.driver.getPlatform() },
        sessionId,
        startTime,
      );
    }

    const executeResult = await config.execute(context);

    let result: TResult;
    let customObservation: StepRecordObservation | undefined;

    if (isToolExecuteResult<TResult>(executeResult)) {
      result = executeResult.result;
      customObservation = executeResult.observation;
    } else {
      result = executeResult;
    }

    let observation: StepRecordObservation | undefined;

    if (effectivePolicy === 'custom' && customObservation) {
      observation = customObservation;
    } else if (effectivePolicy === 'default' && requiresSession) {
      observation = await collectObservation(context.driver, 'full');
    } else if (
      (effectivePolicy === 'none' || effectivePolicy === 'failures') &&
      requiresSession
    ) {
      observation = await collectObservation(context.driver, 'minimal');
    }

    if (sessionId) {
      const recordInput = config.sanitizeInputForRecording
        ? config.sanitizeInputForRecording(config.input)
        : (config.input as Record<string, unknown>);

      await knowledgeStore.recordStep({
        sessionId,
        toolName: config.toolName,
        input: recordInput,
        target: config.getTarget?.(config.input),
        outcome: { ok: true },
        observation: observation ?? createEmptyObservation(),
        durationMs: Date.now() - startTime,
        context: sessionManager.getEnvironmentMode(),
        automationPlatform: context.driver?.getPlatform(),
      });
    }

    return createSuccessResponse<TResult>(result, sessionId, startTime);
  } catch (error) {
    const errorInfo = config.classifyError?.(error) ?? {
      code: `MM_${config.toolName.toUpperCase().replace(/^MM_/u, '')}_FAILED`,
      message: extractErrorMessage(error),
    };

    let failureObservation: StepRecordObservation = createEmptyObservation();

    if (requiresSession && sessionManager.hasActiveSession()) {
      if (effectivePolicy === 'failures' || effectivePolicy === 'default') {
        try {
          failureObservation = await collectObservation(driver, 'full');
        } catch (collectError) {
          debugWarn('run-tool.collectObservation', collectError);
          failureObservation = await collectObservation(undefined, 'minimal');
        }
      } else if (effectivePolicy === 'none') {
        try {
          failureObservation = await collectObservation(undefined, 'minimal');
        } catch (collectError) {
          debugWarn('run-tool.collectObservation', collectError);
        }
      }
    }

    if (sessionId) {
      const recordInput = config.sanitizeInputForRecording
        ? config.sanitizeInputForRecording(config.input)
        : (config.input as Record<string, unknown>);

      await knowledgeStore.recordStep({
        sessionId,
        toolName: config.toolName,
        input: recordInput,
        target: config.getTarget?.(config.input),
        outcome: {
          ok: false,
          error: { code: errorInfo.code, message: errorInfo.message },
        },
        observation: failureObservation,
        durationMs: Date.now() - startTime,
        context: sessionManager.getEnvironmentMode(),
        automationPlatform: driver?.getPlatform(),
      });
    }

    return createErrorResponse(
      errorInfo.code as ErrorCode,
      errorInfo.message,
      { input: config.input },
      sessionId,
      startTime,
    );
  }
}
