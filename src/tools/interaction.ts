import {
  classifyClickError,
  classifyGetTextError,
  classifyHoverError,
  classifyInspectError,
  classifyTypeError,
  classifyWaitError,
  lastPlaywrightLogStep,
} from './error-classification.js';
import type {
  ClickInput,
  ClickResult,
  GetTextInput,
  GetTextResult,
  HoverInput,
  HoverResult,
  InspectInput,
  InspectResult,
  TypeInput,
  TypeResult,
  UnhoverInput,
  UnhoverResult,
  WaitForInput,
  WaitForResult,
  WithinTarget,
} from './types';
import { ErrorCodes } from './types';
import {
  DEFAULT_INSPECT_STYLES,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from './utils/constants.js';
import type { TargetType } from './utils/discovery.js';
import { validateTargetSelection } from './utils/targets.js';
import {
  isInvalidTargetSelection,
  isValidTargetSelection,
} from './utils/type-guards.js';
import {
  abortedResponse,
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
  input:
    | ClickInput
    | TypeInput
    | WaitForInput
    | GetTextInput
    | InspectInput
    | HoverInput,
  context: ToolContext,
): { error: ToolResponse<TResult> } | ValidatedInteraction {
  const missingSession = requireActiveSession<TResult>(context);
  if (missingSession) {
    return { error: missingSession };
  }

  const aborted = abortedResponse<TResult>(context);
  if (aborted) {
    return { error: aborted };
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
export function resolveWithinScope(
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
      context.signal,
      {
        ...(input.dismissKeyboard ? { dismissKeyboard: true } : {}),
        failFastWhenMissing: input.timeoutMs === undefined,
      },
    );
    return createToolSuccess(result);
  } catch (error) {
    const aborted = abortedResponse<ClickResult>(context);
    if (aborted) {
      return aborted;
    }
    const errorInfo = classifyClickError(error);
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      const step = lastPlaywrightLogStep(error);
      const detail =
        step === undefined ? '' : ` (last Playwright step: ${step})`;
      return createToolError(
        ErrorCodes.MM_CLICK_TIMEOUT,
        `Click timed out after ${timeoutMs}ms; state unknown${detail}. Run describe-screen to check the screen before retrying.`,
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
      context.signal,
    );
    return createToolSuccess(result);
  } catch (error) {
    const aborted = abortedResponse<TypeResult>(context);
    if (aborted) {
      return aborted;
    }
    const errorInfo = classifyTypeError(error);
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      return createToolError(
        ErrorCodes.MM_TYPE_TIMEOUT,
        `Type timed out after ${timeoutMs}ms; state unknown. Run describe-screen to check the field before retrying.`,
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
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      return createToolError(
        ErrorCodes.MM_GETTEXT_TIMEOUT,
        `GetText timed out after ${timeoutMs}ms.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Reads the attributes, disabled and read-only flags, and computed styles of
 * an element identified by ref, test ID, or selector, so that elements can
 * be compared without a screenshot.
 *
 * @param input - The target element, styles to read, and timeout options.
 * @param context - The tool execution context.
 * @returns The inspection of the matched element.
 */
export async function inspectTool(
  input: InspectInput,
  context: ToolContext,
): Promise<ToolResponse<InspectResult>> {
  const validated = validateInteraction<InspectResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const { driver } = validated;
  if (!driver.inspect) {
    return createToolError(
      ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
      `Tool "inspect" is not supported on ${driver.getPlatform()} platform`,
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;

  try {
    const result = await driver.inspect(
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      input.styles ?? DEFAULT_INSPECT_STYLES,
      resolveWithinScope(input.within),
    );
    return createToolSuccess(result);
  } catch (error) {
    const errorInfo = classifyInspectError(error);
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      return createToolError(
        ErrorCodes.MM_WAIT_TIMEOUT,
        `Inspect timed out after ${timeoutMs}ms.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Moves the pointer over an element identified by ref, test ID, or selector,
 * so hover-only UI (popovers, tooltips, hover styles) shows. It stays until
 * the pointer moves: run `unhover` to close it.
 *
 * @param input - The hover target and timeout options.
 * @param context - The tool execution context.
 * @returns The hover result.
 */
export async function hoverTool(
  input: HoverInput,
  context: ToolContext,
): Promise<ToolResponse<HoverResult>> {
  const validated = validateInteraction<HoverResult>(input, context);
  if ('error' in validated) {
    return validated.error;
  }

  const { driver } = validated;
  if (!driver.hover) {
    return createToolError(
      ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
      `Tool "hover" is not supported on ${driver.getPlatform()} platform`,
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
  const { targetType, targetValue } = validated.target;

  try {
    const result = await driver.hover(
      targetType,
      targetValue,
      context.refMap,
      timeoutMs,
      resolveWithinScope(input.within),
      context.signal,
    );
    return createToolSuccess(result);
  } catch (error) {
    const aborted = abortedResponse<HoverResult>(context);
    if (aborted) {
      return aborted;
    }
    const errorInfo = classifyHoverError(error);
    if (errorInfo.code === ErrorCodes.MM_WAIT_TIMEOUT) {
      return createToolError(
        ErrorCodes.MM_WAIT_TIMEOUT,
        `Hover timed out after ${timeoutMs}ms. Run describe-screen to check the target is visible and not covered.`,
      );
    }
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Moves the pointer off the page, so the element under it gets
 * `mouseleave` and loses its hover state, and no other element gets one.
 *
 * @param _input - No options.
 * @param context - The tool execution context.
 * @returns The unhover result.
 */
export async function unhoverTool(
  _input: UnhoverInput,
  context: ToolContext,
): Promise<ToolResponse<UnhoverResult>> {
  const missingSession = requireActiveSession<UnhoverResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    // (0, 0) is often over a header, which would get a hover of its own.
    await context.page.mouse.move(-1, -1);
    return createToolSuccess({ unhovered: true });
  } catch (error) {
    const errorInfo = classifyHoverError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
