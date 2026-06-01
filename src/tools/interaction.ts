import {
  classifyClickError,
  classifyGetTextError,
  classifyTypeError,
  classifyWaitError,
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
import type { TargetType } from './utils/discovery.js';
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
import type { WithinScope } from '../platform/types.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

type ValidatedTarget = {
  targetType: TargetType;
  targetValue: string;
};

type ValidatedInteraction = {
  target: ValidatedTarget;
  driver: NonNullable<ToolContext['driver']>;
};

/**
 * Validates session, driver, and target selection for interaction tools.
 * Returns an error response if validation fails, or the resolved target.
 *
 * @param input - The tool input with target selection fields.
 * @param context - The tool execution context.
 * @returns Either an error response or the validated target.
 */
function validateInteraction<TResult>(
  input: ClickInput | TypeInput | WaitForInput | GetTextInput,
  context: ToolContext,
): { error: ToolResponse<TResult> } | ValidatedInteraction {
  const missingSession = requireActiveSession<TResult>(context);
  if (missingSession) {
    return { error: missingSession };
  }

  if (!context.driver) {
    return {
      error: createToolError(
        ErrorCodes.MM_NO_ACTIVE_SESSION,
        'No platform driver available',
      ),
    };
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
    driver: context.driver,
  };
}

/**
 * Converts a WithinTarget input to the WithinScope format expected by the platform driver.
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

  try {
    const result = await validated.driver.click(
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );
    return createToolSuccess(result);
  } catch (error) {
    const errorInfo = classifyClickError(error);
    if (
      errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT ||
      errorInfo.message.includes('visibility wait consumed entire budget')
    ) {
      return createToolError(
        ErrorCodes.MM_CLICK_TIMEOUT,
        `Click timed out after ${timeoutMs}ms. Note: the click action may have completed in the background after this timeout. Run describe-screen to verify current page state before retrying.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
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

  try {
    const result = await validated.driver.type(
      targetType,
      targetValue,
      input.text,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );
    return createToolSuccess(result);
  } catch (error) {
    const errorInfo = classifyTypeError(error);
    if (
      errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT ||
      errorInfo.message.includes('visibility wait consumed entire budget')
    ) {
      return createToolError(
        ErrorCodes.MM_TYPE_TIMEOUT,
        `Type timed out after ${timeoutMs}ms.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
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

  try {
    await validated.driver.waitForElement(
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

  try {
    const result = await validated.driver.getText(
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );
    return createToolSuccess(result);
  } catch (error) {
    const errorInfo = classifyGetTextError(error);
    if (
      errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT ||
      errorInfo.message.includes('visibility wait consumed entire budget')
    ) {
      return createToolError(
        ErrorCodes.MM_GETTEXT_TIMEOUT,
        `GetText timed out after ${timeoutMs}ms.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
