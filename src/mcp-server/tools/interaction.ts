import type {
  ClickInput,
  ClickResult,
  TypeInput,
  TypeResult,
  WaitForInput,
  WaitForResult,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import {
  createErrorResponse,
  validateTargetSelection,
  isValidTargetSelection,
  isInvalidTargetSelection,
} from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";
import { waitForTarget } from "../discovery.js";
import { runTool } from "./run-tool.js";
import { DEFAULT_INTERACTION_TIMEOUT_MS } from "../constants.js";
import {
  classifyClickError,
  classifyTypeError,
  classifyWaitError,
  isPageClosedError,
} from "./error-classification.js";

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
      "Invalid target selection",
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<ClickInput, ClickResult>({
    toolName: "mm_click",
    input,
    options,

    execute: async (context) => {
      const locator = await waitForTarget(
        context.page,
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );

      try {
        await locator.click();
        return {
          clicked: true,
          target: `${targetType}:${targetValue}`,
        };
      } catch (clickError) {
        if (isPageClosedError(clickError)) {
          return {
            clicked: true,
            target: `${targetType}:${targetValue}`,
            pageClosedAfterClick: true,
          };
        }
        throw clickError;
      }
    },

    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyClickError,

    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}

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
      "Invalid target selection",
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<TypeInput, TypeResult>({
    toolName: "mm_type",
    input,
    options,

    execute: async (context) => {
      const locator = await waitForTarget(
        context.page,
        targetType,
        targetValue,
        context.refMap,
        timeoutMs,
      );
      await locator.fill(input.text);

      return {
        typed: true,
        target: `${targetType}:${targetValue}`,
        textLength: input.text.length,
      };
    },

    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyTypeError,

    sanitizeInputForRecording: () => ({
      timeoutMs,
      text: input.text,
      testId: input.testId,
      selector: input.selector,
      a11yRef: input.a11yRef,
    }),
  });
}

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
      "Invalid target selection",
      { input },
      sessionId,
      startTime,
    );
  }

  const { type: targetType, value: targetValue } = validation;

  return runTool<WaitForInput, WaitForResult>({
    toolName: "mm_wait_for",
    input,
    options,

    execute: async (context) => {
      await waitForTarget(
        context.page,
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

    getTarget: () => ({ [targetType]: targetValue }),

    classifyError: classifyWaitError,

    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}
