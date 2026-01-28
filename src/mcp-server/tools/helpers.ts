import type { Page } from "@playwright/test";
import type {
  McpResponse,
  ErrorCode,
  TestIdItem,
  A11yNodeTrimmed,
  StepRecordObservation,
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createErrorResponse, extractErrorMessage, debugWarn } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";
import {
  knowledgeStore,
  createDefaultObservation,
} from "../knowledge-store.js";
import { collectTestIds, collectTrimmedA11ySnapshot } from "../discovery.js";
import { OBSERVATION_TESTID_LIMIT } from "../constants.js";
import type { ExtensionState } from "../../capabilities/types.js";

/**
 * Level of detail to collect for observation data.
 * - "full": Collect state, testIds, and a11y tree
 * - "minimal": Collect state only (no testIds or a11y)
 * - "none": Return empty observation
 */
export type ObservationLevel = "full" | "minimal" | "none";

export type RecordStepParams = {
  toolName: string;
  input: Record<string, unknown>;
  startTime: number;
  observation: StepRecordObservation;
  target?: Record<string, string>;
  screenshotPath?: string;
  screenshotDimensions?: { width: number; height: number };
};

export type ActiveSessionContext = {
  sessionId: string;
  page: Page;
  refMap: Map<string, string>;
};

export function requireActiveSession<Result>(
  startTime: number,
): McpResponse<Result> | undefined {
  const sessionManager = getSessionManager();
  if (!sessionManager.hasActiveSession()) {
    return createErrorResponse(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      "No active session. Call launch first.",
      undefined,
      undefined,
      startTime,
    ) as McpResponse<Result>;
  }
  return undefined;
}

export async function collectObservation(
  page: Page | undefined,
  level: ObservationLevel,
  presetState?: ExtensionState,
): Promise<StepRecordObservation> {
  const sessionManager = getSessionManager();

  if (level === "none") {
    return createDefaultObservation({} as ExtensionState, [], []);
  }

  const state = presetState ?? await sessionManager.getExtensionState();

  if (level === "minimal") {
    return createDefaultObservation(state, [], []);
  }

  if (!page) {
    debugWarn("collectObservation", "Page not provided for full observation");
    return createDefaultObservation(state, [], []);
  }

  try {
    const testIds: TestIdItem[] = await collectTestIds(page, OBSERVATION_TESTID_LIMIT);
    const { nodes, refMap }: { nodes: A11yNodeTrimmed[]; refMap: Map<string, string> } =
      await collectTrimmedA11ySnapshot(page);
    sessionManager.setRefMap(refMap);
    return createDefaultObservation(state, testIds, nodes);
  } catch (error) {
    debugWarn("collectObservation", error);
    return createDefaultObservation(state, [], []);
  }
}

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
        "Session ID not found",
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

export async function recordToolStep(params: RecordStepParams): Promise<void> {
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId() ?? "";

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

export async function collectObservationAndRecord(
  page: Page,
  toolName: string,
  input: Record<string, unknown>,
  startTime: number,
  options: {
    target?: Record<string, string>;
    screenshotPath?: string;
    screenshotDimensions?: { width: number; height: number };
  } = {},
): Promise<StepRecordObservation> {
  const observation = await collectObservation(page, "full");

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

export function handleToolError<Result>(
  error: unknown,
  defaultCode: ErrorCode,
  defaultMessage: string,
  input: unknown,
  sessionId: string | undefined,
  startTime: number,
): McpResponse<Result> {
  const message = extractErrorMessage(error);

  if (message.includes("Unknown a11yRef") || message.includes("not found")) {
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
