import { DEFAULT_INTERACTION_TIMEOUT_MS } from '../constants.js';
import { getSessionManager } from '../session-manager.js';
import {
  classifyClickError,
  classifyTypeError,
  classifyWaitError,
} from './error-classification.js';
import { runTool } from './run-tool.js';
import type {
  ClickInput,
  ClickResult,
  TypeInput,
  TypeResult,
  WaitForInput,
  WaitForResult,
  McpResponse,
  HandlerOptions,
} from '../types';
import { ErrorCodes } from '../types';
import {
  createErrorResponse,
  validateTargetSelection,
  isValidTargetSelection,
  isInvalidTargetSelection,
} from '../utils';

/**
 * Handles clicking on an element specified by testId, selector, or accessibility reference.
 *
 * @param input The click input containing target selection and timeout options
 * @param options Optional handler configuration
 * @returns Promise resolving to click result with target information
 */
export async function handleClick(
  input: ClickInput,
  options?: HandlerOptions,
): Promise<McpResponse<ClickResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  const validation = validateTargetSelection(input);
  if (isInvalidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      validation.error,
      { input },
      sessionId,
      startTime,
    );
  }

  if (!isValidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<ClickInput, ClickResult>({
    toolName: 'mm_click',
    input,
    options,

    /**
     * Executes the click action on the target element.
     *
     * @param context The tool execution context containing page and reference map
     * @returns Promise resolving to click result with success status and target info
     */
    execute: async (context) => {
      return context.driver!.click(
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );
    },

    /**
     * Returns the target element information for recording.
     *
     * @returns Object containing the target type and value
     */
    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyClickError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with timeout information
     */
    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}

/**
 * Handles typing text into an element specified by testId, selector, or accessibility reference.
 *
 * @param input The type input containing target selection, text, and timeout options
 * @param options Optional handler configuration
 * @returns Promise resolving to type result with target and text length information
 */
export async function handleType(
  input: TypeInput,
  options?: HandlerOptions,
): Promise<McpResponse<TypeResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  const validation = validateTargetSelection(input);
  if (isInvalidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      validation.error,
      { input },
      sessionId,
      startTime,
    );
  }

  if (!isValidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<TypeInput, TypeResult>({
    toolName: 'mm_type',
    input,
    options,

    /**
     * Executes the type action on the target element.
     *
     * @param context The tool execution context containing page and reference map
     * @returns Promise resolving to type result with success status and text length
     */
    execute: async (context) => {
      return context.driver!.type(
        targetType,
        targetValue,
        input.text,
        context.refMap,
        timeoutMs,
      );
    },

    /**
     * Returns the target element information for recording.
     *
     * @returns Object containing the target type and value
     */
    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyTypeError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with timeout and text information
     */
    sanitizeInputForRecording: () => ({
      timeoutMs,
      text: input.text,
      testId: input.testId,
      selector: input.selector,
      a11yRef: input.a11yRef,
    }),
  });
}

/**
 * Handles waiting for an element to become visible.
 *
 * @param input The wait input containing target selection and timeout options
 * @param options Optional handler configuration
 * @returns Promise resolving to wait result with target information
 */
export async function handleWaitFor(
  input: WaitForInput,
  options?: HandlerOptions,
): Promise<McpResponse<WaitForResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  const validation = validateTargetSelection(input);
  if (isInvalidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      validation.error,
      { input },
      sessionId,
      startTime,
    );
  }

  if (!isValidTargetSelection(validation)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<WaitForInput, WaitForResult>({
    toolName: 'mm_wait_for',
    input,
    options,

    /**
     * Executes the wait action for the target element.
     *
     * @param context The tool execution context containing page and reference map
     * @returns Promise resolving to wait result with success status and target info
     */
    execute: async (context) => {
      await context.driver!.waitForElement(
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );

      return {
        found: true,
        target: `${targetType}:${targetValue}`,
      };
    },

    /**
     * Returns the target element information for recording.
     *
     * @returns Object containing the target type and value
     */
    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyWaitError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with timeout information
     */
    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}
