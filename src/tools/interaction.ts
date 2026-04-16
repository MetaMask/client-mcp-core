import {
  classifyClickError,
  classifyTypeError,
  classifyWaitError,
  isPageClosedError,
} from './error-classification.js';
import type {
  ClickInput,
  ClickResult,
  TypeInput,
  TypeResult,
  WaitForInput,
  WaitForResult,
  WithinTarget,
} from './types';
import { ErrorCodes } from './types';
import { DEFAULT_INTERACTION_TIMEOUT_MS } from './utils/constants.js';
import { waitForTarget } from './utils/discovery.js';
import type { WithinScope } from './utils/discovery.js';
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
import type { ToolContext, ToolResponse } from '../types/http.js';

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
  const missingSession = requireActiveSession<ClickResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const validation = validateTargetSelection(input);

  if (isInvalidTargetSelection(validation)) {
    return createToolError(ErrorCodes.MM_INVALID_INPUT, validation.error);
  }

  if (!isValidTargetSelection(validation)) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
    );
  }

  const { type: targetType, value: targetValue } = validation;

  try {
    const locator = await waitForTarget(
      context.page,
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );

    try {
      await locator.click();
      return createToolSuccess({
        clicked: true,
        target: `${targetType}:${targetValue}`,
      });
    } catch (clickError) {
      if (isPageClosedError(clickError)) {
        return createToolSuccess({
          clicked: true,
          target: `${targetType}:${targetValue}`,
          pageClosedAfterClick: true,
        });
      }

      throw clickError;
    }
  } catch (error) {
    const errorInfo = classifyClickError(error);
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
  const missingSession = requireActiveSession<TypeResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const validation = validateTargetSelection(input);

  if (isInvalidTargetSelection(validation)) {
    return createToolError(ErrorCodes.MM_INVALID_INPUT, validation.error);
  }

  if (!isValidTargetSelection(validation)) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
    );
  }

  const { type: targetType, value: targetValue } = validation;

  try {
    const locator = await waitForTarget(
      context.page,
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
    );

    await locator.fill(input.text);

    return createToolSuccess({
      typed: true,
      target: `${targetType}:${targetValue}`,
      textLength: input.text.length,
    });
  } catch (error) {
    const errorInfo = classifyTypeError(error);
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
  const missingSession = requireActiveSession<WaitForResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const validation = validateTargetSelection(input);

  if (isInvalidTargetSelection(validation)) {
    return createToolError(ErrorCodes.MM_INVALID_INPUT, validation.error);
  }

  if (!isValidTargetSelection(validation)) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'Invalid target selection',
    );
  }

  const { type: targetType, value: targetValue } = validation;

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
