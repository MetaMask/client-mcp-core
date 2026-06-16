import type { Locator } from '@playwright/test';

import {
  classifyClickError,
  classifyGetTextError,
  classifyTypeError,
  classifyWaitError,
  isPageClosedError,
} from './error-classification.js';
import type {
  ClickInput,
  ClickResult,
  GetTextInput,
  GetTextResult,
  TypeInput,
  TypeResult,
  WaitForInput,
  WaitForResult,
  WithinTarget,
} from './types';
import { ErrorCodes } from './types';
import { DEFAULT_INTERACTION_TIMEOUT_MS } from './utils/constants.js';
import { waitForTarget } from './utils/discovery.js';
import type { TargetType, WithinScope } from './utils/discovery.js';
import { validateTargetSelection } from './utils/targets.js';
import {
  isInvalidTargetSelection,
  isValidTargetSelection,
} from './utils/type-guards.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import { classifyIOSError } from '../platform/ios/error-classification.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Checks whether the given error is a Playwright timeout error.
 *
 * @param error - The error to inspect.
 * @returns True if the error represents an action timeout.
 */
function isActionTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

type ValidatedTarget = {
  targetType: TargetType;
  targetValue: string;
};

/**
 * Validates session and target selection for interaction tools.
 * Returns an error response if validation fails, or the resolved target.
 *
 * @param input - The tool input with target selection fields.
 * @param context - The tool execution context.
 * @returns Either an error response or the validated target.
 */
function validateInteraction<TResult>(
  input: ClickInput | TypeInput | WaitForInput | GetTextInput,
  context: ToolContext,
): { error: ToolResponse<TResult> } | { target: ValidatedTarget } {
  const missingSession = requireActiveSession<TResult>(context);
  if (missingSession) {
    return { error: missingSession };
  }

  const validation = validateTargetSelection(input);

  if (isInvalidTargetSelection(validation)) {
    return {
      error: createToolError(ErrorCodes.MM_INVALID_INPUT, validation.error),
    };
  }

  if (!isValidTargetSelection(validation)) {
    return {
      error: createToolError(
        ErrorCodes.MM_INVALID_INPUT,
        'Invalid target selection',
      ),
    };
  }

  return {
    target: {
      targetType: validation.type,
      targetValue: validation.value,
    },
  };
}

type InteractionErrorInfo = {
  code: string;
  message: string;
};

type RunInteractionWithTimeoutOptions<TResult> = {
  context: ToolContext;
  timeoutMs: number;
  within?: WithinTarget;
  targetType: TargetType;
  targetValue: string;
  timeoutErrorCode: string;
  classifyError: (error: unknown) => InteractionErrorInfo;
  action: (locator: Locator, timeout: number) => Promise<TResult>;
  createSuccessResult: (result: TResult) => ToolResponse<TResult>;
  formatTimeoutMessage: (
    phase: 'deadline' | 'action',
    elapsedMs: number,
  ) => string;
  handleActionError?: (
    error: unknown,
    locator: Locator,
  ) => ToolResponse<TResult> | undefined;
};

/**
 * Runs an element interaction within a deadline-based timeout.
 *
 * @param options - The interaction configuration object.
 * @param options.context - The tool execution context with session and page.
 * @param options.timeoutMs - Maximum time in milliseconds for the interaction.
 * @param options.within - Optional parent scope to restrict element search.
 * @param options.targetType - The type of target identifier (a11yRef, testId, selector).
 * @param options.targetValue - The target value used for element lookup.
 * @param options.timeoutErrorCode - The error code to use when the interaction times out.
 * @param options.classifyError - Classifies a caught error into a code and message.
 * @param options.action - The interaction to perform on the resolved locator.
 * @param options.createSuccessResult - Creates the tool response from a successful result.
 * @param options.formatTimeoutMessage - Formats the timeout error message for a given phase.
 * @param options.handleActionError - Optional handler for action errors before fallback.
 * @returns The tool response for the interaction outcome.
 */
async function runInteractionWithTimeout<TResult>({
  context,
  timeoutMs,
  within,
  targetType,
  targetValue,
  timeoutErrorCode,
  classifyError,
  action,
  createSuccessResult,
  formatTimeoutMessage,
  handleActionError,
}: RunInteractionWithTimeoutOptions<TResult>): Promise<ToolResponse<TResult>> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  const withinScope = resolveWithinScope(within);
  let locator: Locator | undefined;

  try {
    locator = await waitForTarget(
      context.page,
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      withinScope,
    );
  } catch (error) {
    const errorInfo = classifyError(error);
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      return createToolError(timeoutErrorCode, errorInfo.message);
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }

  const remaining = deadline - Date.now();

  if (remaining <= 0) {
    const elapsedMs = Date.now() - startTime;
    return createToolError(
      timeoutErrorCode,
      formatTimeoutMessage('deadline', elapsedMs),
    );
  }

  try {
    const result = await action(locator, remaining);
    return createSuccessResult(result);
  } catch (actionError) {
    const handledError = handleActionError?.(actionError, locator);
    if (handledError) {
      return handledError;
    }

    // Page-closed errors can surface with name='TimeoutError' due to
    // Playwright race conditions.  Classify them before the timeout
    // check so they are never misreported as action timeouts.
    if (isPageClosedError(actionError)) {
      const errorInfo = classifyError(actionError);
      return createToolError(errorInfo.code, errorInfo.message);
    }

    if (isActionTimeoutError(actionError)) {
      const elapsedMs = Date.now() - startTime;
      return createToolError(
        timeoutErrorCode,
        formatTimeoutMessage('action', elapsedMs),
      );
    }

    const errorInfo = classifyError(actionError);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Converts a WithinTarget input to the WithinScope format expected by waitForTarget.
 *
 * @param within - The optional within target from tool input.
 * @returns The resolved scope, or undefined if no within target is provided.
 */
function resolveWithinScope(
  within: WithinTarget | undefined,
): WithinScope | undefined {
  if (!within) {
    return undefined;
  }
  if (within.a11yRef) {
    return { type: 'a11yRef', value: within.a11yRef };
  }
  if (within.testId) {
    return { type: 'testId', value: within.testId };
  }
  if (within.selector) {
    return { type: 'selector', value: within.selector };
  }
  return undefined;
}

/**
 * Clicks an element identified by ref, test ID, or selector.
 *
 * @param input - The click target and timeout options.
 * @param context - The tool execution context.
 * @returns The click operation result.
 */
export async function clickTool(
  input: ClickInput,
  context: ToolContext,
): Promise<ToolResponse<ClickResult>> {
  const validated = validateInteraction<ClickResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;

  const driver = context.platformDriver;
  if (driver?.getPlatform() === 'ios') {
    try {
      const result = await driver.click(
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );
      return createToolSuccess(result);
    } catch (error) {
      const errorInfo = classifyIOSError(error);
      return createToolError(errorInfo.code, errorInfo.message);
    }
  }

  return runInteractionWithTimeout({
    context,
    timeoutMs,
    within: input.within,
    targetType,
    targetValue,
    timeoutErrorCode: ErrorCodes.MM_CLICK_TIMEOUT,
    classifyError: classifyClickError,
    action: async (locator, timeout) => {
      await locator.click({ timeout });
      return {
        clicked: true,
        target: `${targetType}:${targetValue}`,
      };
    },
    createSuccessResult: createToolSuccess,
    formatTimeoutMessage: (phase, elapsedMs) =>
      phase === 'deadline'
        ? `Click timed out after ${elapsedMs}ms. Note: the click action may have completed in the background after this timeout. Run describe-screen to verify current page state before retrying.`
        : `Click action timed out after ${elapsedMs}ms. Note: the click action may have completed in the background after this timeout. Run describe-screen to verify current page state before retrying.`,
    handleActionError: (error) => {
      if (!isPageClosedError(error)) {
        return undefined;
      }

      return createToolSuccess({
        clicked: true,
        target: `${targetType}:${targetValue}`,
        pageClosedAfterClick: true,
      });
    },
  });
}

/**
 * Types text into an element identified by ref, test ID, or selector.
 *
 * @param input - The type target, text content, and timeout options.
 * @param context - The tool execution context.
 * @returns The type operation result.
 */
export async function typeTool(
  input: TypeInput,
  context: ToolContext,
): Promise<ToolResponse<TypeResult>> {
  const validated = validateInteraction<TypeResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;

  const driver = context.platformDriver;
  if (driver?.getPlatform() === 'ios') {
    try {
      const result = await driver.type(
        targetType,
        targetValue,
        input.text,
        context.refMap,
        timeoutMs,
      );
      return createToolSuccess(result);
    } catch (error) {
      const errorInfo = classifyIOSError(error);
      return createToolError(errorInfo.code, errorInfo.message);
    }
  }

  return runInteractionWithTimeout({
    context,
    timeoutMs,
    within: input.within,
    targetType,
    targetValue,
    timeoutErrorCode: ErrorCodes.MM_TYPE_TIMEOUT,
    classifyError: classifyTypeError,
    action: async (locator, timeout) => {
      await locator.fill(input.text, { timeout });
      return {
        typed: true,
        target: `${targetType}:${targetValue}`,
        textLength: input.text.length,
      };
    },
    createSuccessResult: createToolSuccess,
    formatTimeoutMessage: (phase, elapsedMs) =>
      phase === 'deadline'
        ? `Type timed out after ${elapsedMs}ms.`
        : `Type action timed out after ${elapsedMs}ms.`,
  });
}

/**
 * Waits for an element to appear on the page within a timeout.
 *
 * @param input - The wait target and timeout options.
 * @param context - The tool execution context.
 * @returns The wait result indicating whether the element was found.
 */
export async function waitForTool(
  input: WaitForInput,
  context: ToolContext,
): Promise<ToolResponse<WaitForResult>> {
  const validated = validateInteraction<WaitForResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;

  const driver = context.platformDriver;
  if (driver?.getPlatform() === 'ios') {
    try {
      await driver.waitForElement(
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );
      return createToolSuccess({
        found: true,
        target: `${targetType}:${targetValue}`,
      });
    } catch (error) {
      const errorInfo = classifyIOSError(error);
      return createToolError(errorInfo.code, errorInfo.message);
    }
  }

  try {
    await waitForTarget(
      context.page,
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );

    return createToolSuccess({
      found: true,
      target: `${targetType}:${targetValue}`,
    });
  } catch (error) {
    const errorInfo = classifyWaitError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Reads the text content of an element identified by ref, test ID, or selector.
 *
 * @param input - The target element and timeout options.
 * @param context - The tool execution context.
 * @returns The text content of the matched element.
 */
export async function getTextTool(
  input: GetTextInput,
  context: ToolContext,
): Promise<ToolResponse<GetTextResult>> {
  const validated = validateInteraction<GetTextResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;
  return runInteractionWithTimeout({
    context,
    timeoutMs,
    within: input.within,
    targetType,
    targetValue,
    timeoutErrorCode: ErrorCodes.MM_GETTEXT_TIMEOUT,
    classifyError: classifyGetTextError,
    action: async (locator, timeout) => {
      const text = (await locator.textContent({ timeout })) ?? '';
      return {
        text,
        target: `${targetType}:${targetValue}`,
        length: text.length,
      };
    },
    createSuccessResult: createToolSuccess,
    formatTimeoutMessage: (phase, elapsedMs) =>
      phase === 'deadline'
        ? `GetText timed out after ${elapsedMs}ms.`
        : `GetText action timed out after ${elapsedMs}ms.`,
  });
}
