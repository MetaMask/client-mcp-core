import type { Page } from '@playwright/test';

import type { IPlatformDriver } from '../../platform/types.js';

import type { ExtensionState } from '../../capabilities/types.js';
import { OBSERVATION_TESTID_LIMIT } from '../constants.js';
import {
  knowledgeStore,
  createDefaultObservation,
} from '../knowledge-store.js';
import { getSessionManager } from '../session-manager.js';
import type {
  McpResponse,
  ErrorCode,
  TestIdItem,
  StepRecordObservation,
} from '../types';
import { ErrorCodes } from '../types';
import { createErrorResponse, extractErrorMessage, debugWarn } from '../utils';

/**
 * Level of detail to collect for observation data.
 * - "full": Collect state, testIds, and a11y tree
 * - "minimal": Collect state only (no testIds or a11y)
 * - "none": Return empty observation
 */
export type ObservationLevel = 'full' | 'minimal' | 'none';

/**
 * Parameters for recording a tool step in the knowledge store.
 */
export type RecordStepParams = {
  /**
   * Name of the tool that was executed
   */
  toolName: string;
  /**
   * Input parameters passed to the tool
   */
  input: Record<string, unknown>;
  /**
   * Timestamp when the tool execution started
   */
  startTime: number;
  /**
   * Observation data collected after tool execution
   */
  observation: StepRecordObservation;
  /**
   * Target element information (selector, testId, etc.)
   */
  target?: Record<string, string>;
  /**
   * Path to screenshot file if captured
   */
  screenshotPath?: string;
  /**
   * Screenshot dimensions if captured
   */
  screenshotDimensions?: {
    /**
     * Screenshot width in pixels
     */
    width: number;
    /**
     * Screenshot height in pixels
     */
    height: number;
  };
};

/**
 * Context information for an active session.
 */
export type ActiveSessionContext = {
  /**
   * Unique session identifier
   */
  sessionId: string;
  /**
   * Current active page instance
   */
  page: Page;
  /**
   * Map of accessibility references to selectors
   */
  refMap: Map<string, string>;
};

/**
 * Check if an active session exists and return error if not.
 *
 * @param startTime - Timestamp when the operation started
 * @returns Error response if no active session, undefined otherwise
 */
export function requireActiveSession<Result>(
  startTime: number,
): McpResponse<Result> | undefined {
  const sessionManager = getSessionManager();
  if (!sessionManager.hasActiveSession()) {
    return createErrorResponse(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      'No active session. Call launch first.',
      undefined,
      undefined,
      startTime,
    ) as McpResponse<Result>;
  }
  return undefined;
}

/**
 * Collect observation data from the current page state.
 *
 * @param page - The page to collect observation from
 * @param level - Level of detail to collect (full, minimal, or none)
 * @param presetState - Optional pre-fetched extension state to use instead of querying
 * @returns Observation data with state, testIds, and accessibility tree
 */
export async function collectObservation(
  driver: IPlatformDriver | undefined,
  level: ObservationLevel,
  presetState?: ExtensionState,
): Promise<StepRecordObservation> {
  const sessionManager = getSessionManager();

  if (level === 'none') {
    return createDefaultObservation({} as ExtensionState, [], []);
  }

  const state =
    presetState ??
    (driver
      ? await driver.getAppState()
      : await sessionManager.getExtensionState());

  if (level === 'minimal') {
    return createDefaultObservation(state, [], []);
  }

  if (!driver) {
    debugWarn('collectObservation', 'Driver not provided for full observation');
    return createDefaultObservation(state, [], []);
  }

  try {
    const testIds: TestIdItem[] = await driver.getTestIds(
      OBSERVATION_TESTID_LIMIT,
    );
    const { nodes, refMap } = await driver.getAccessibilityTree();
    sessionManager.setRefMap(refMap);
    return createDefaultObservation(state, testIds, nodes);
  } catch (error) {
    debugWarn('collectObservation', error);
    return createDefaultObservation(state, [], []);
  }
}

/**
 * Wrapper that ensures an active session exists before executing a handler.
 *
 * @param handler - Function to execute with active session context
 * @returns Wrapped function that validates session before calling handler
 */
export function withActiveSession<TInput, TResult>(
  handler: (
    input: TInput,
    ctx: ActiveSessionContext,
    startTime: number,
  ) => Promise<McpResponse<TResult>>,
): (input: TInput) => Promise<McpResponse<TResult>> {
  return async (input: TInput): Promise<McpResponse<TResult>> => {
    const startTime = Date.now();
    const sessionManager = getSessionManager();

    const sessionError = requireActiveSession<TResult>(startTime);
    if (sessionError) {
      return sessionError;
    }

    const sessionId = sessionManager.getSessionId();
    if (!sessionId) {
      return createErrorResponse(
        ErrorCodes.MM_NO_ACTIVE_SESSION,
        'Session ID not found',
        undefined,
        undefined,
        startTime,
      ) as McpResponse<TResult>;
    }
    const page = sessionManager.getPage();
    const refMap = sessionManager.getRefMap();

    return handler(input, { sessionId, page, refMap }, startTime);
  };
}

/**
 * Record a tool execution step in the knowledge store.
 *
 * @param params - Parameters containing tool name, input, observation, and metadata
 */
export async function recordToolStep(params: RecordStepParams): Promise<void> {
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId() ?? '';

  await knowledgeStore.recordStep({
    sessionId,
    toolName: params.toolName,
    input: params.input,
    target: params.target,
    outcome: { ok: true },
    observation: params.observation,
    durationMs: Date.now() - params.startTime,
    screenshotPath: params.screenshotPath,
    screenshotDimensions: params.screenshotDimensions,
  });
}

/**
 * Collect observation data and record the tool step in the knowledge store.
 *
 * @param page - The page to collect observation from
 * @param toolName - Name of the tool that was executed
 * @param input - Input parameters passed to the tool
 * @param startTime - Timestamp when the tool execution started
 * @param options - Optional metadata for the step record
 * @param options.target - Target element information
 * @param options.screenshotPath - Path to screenshot file if captured
 * @param options.screenshotDimensions - Screenshot dimensions
 * @param options.screenshotDimensions.width - Screenshot width in pixels
 * @param options.screenshotDimensions.height - Screenshot height in pixels
 * @returns Observation data collected after tool execution
 */
export async function collectObservationAndRecord(
  driver: IPlatformDriver,
  toolName: string,
  input: Record<string, unknown>,
  startTime: number,
  options: {
    /**
     * Target element information (selector, testId, etc.)
     */
    target?: Record<string, string>;
    /**
     * Path to screenshot file if captured
     */
    screenshotPath?: string;
    /**
     * Screenshot dimensions if captured
     */
    screenshotDimensions?: {
      /**
       * Screenshot width in pixels
       */
      width: number;
      /**
       * Screenshot height in pixels
       */
      height: number;
    };
  } = {},
): Promise<StepRecordObservation> {
  const observation = await collectObservation(driver, 'full');

  await recordToolStep({
    toolName,
    input,
    startTime,
    observation,
    target: options.target,
    screenshotPath: options.screenshotPath,
    screenshotDimensions: options.screenshotDimensions,
  });

  return observation;
}

/**
 * Handle tool execution errors and return appropriate error response.
 *
 * @param error - The error that occurred during tool execution
 * @param defaultCode - Default error code to use if no specific match found
 * @param defaultMessage - Default error message to use
 * @param input - Input parameters that were passed to the tool
 * @param sessionId - Current session ID for error context
 * @param startTime - Timestamp when the tool execution started
 * @returns Error response with appropriate code and message
 */
export function handleToolError<Result>(
  error: unknown,
  defaultCode: ErrorCode,
  defaultMessage: string,
  input: unknown,
  sessionId: string | undefined,
  startTime: number,
): McpResponse<Result> {
  const message = extractErrorMessage(error);

  if (message.includes('Unknown a11yRef') || message.includes('not found')) {
    return createErrorResponse(
      ErrorCodes.MM_TARGET_NOT_FOUND,
      message,
      { input },
      sessionId,
      startTime,
    ) as McpResponse<Result>;
  }

  return createErrorResponse(
    defaultCode,
    `${defaultMessage}: ${message}`,
    { input },
    sessionId,
    startTime,
  ) as McpResponse<Result>;
}
