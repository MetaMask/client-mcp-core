import type {
  KnowledgeLastInput,
  KnowledgeLastResult,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSummarizeInput,
  KnowledgeSummarizeResult,
  KnowledgeSessionsInput,
  KnowledgeSessionsResult,
  KnowledgeScope,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createSuccessResponse, createErrorResponse, extractErrorMessage } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";
import { knowledgeStore } from "../knowledge-store.js";

export async function handleKnowledgeLast(
  input: KnowledgeLastInput,
  _options?: HandlerOptions,
): Promise<McpResponse<KnowledgeLastResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const n = input.n ?? 20;
  const scope: KnowledgeScope = input.scope ?? "current";

  try {
    const steps = await knowledgeStore.getLastSteps(
      n,
      scope,
      sessionId,
      input.filters,
    );

    return createSuccessResponse<KnowledgeLastResult>(
      { steps },
      sessionId,
      startTime,
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Failed to retrieve steps: ${message}`,
      { n, scope },
      sessionId,
      startTime,
    );
  }
}

export async function handleKnowledgeSearch(
  input: KnowledgeSearchInput,
  _options?: HandlerOptions,
): Promise<McpResponse<KnowledgeSearchResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const limit = input.limit ?? 20;
  const scope: KnowledgeScope = input.scope ?? "all";

  try {
    const matches = await knowledgeStore.searchSteps(
      input.query,
      limit,
      scope,
      sessionId,
      input.filters,
    );

    return createSuccessResponse<KnowledgeSearchResult>(
      {
        matches,
        query: input.query,
      },
      sessionId,
      startTime,
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Search failed: ${message}`,
      { query: input.query, limit, scope },
      sessionId,
      startTime,
    );
  }
}

export async function handleKnowledgeSummarize(
  input: KnowledgeSummarizeInput,
  _options?: HandlerOptions,
): Promise<McpResponse<KnowledgeSummarizeResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const currentSessionId = sessionManager.getSessionId();

  let targetSessionId: string | undefined;

  if (input.sessionId) {
    targetSessionId = input.sessionId;
  } else if (input.scope) {
     if (input.scope === "all") {
       return createErrorResponse(
         ErrorCodes.MM_INVALID_INPUT,
         'Cannot summarize all sessions. Use scope="current" or provide a specific sessionId.',
         { input },
         currentSessionId,
         startTime,
       );
    } else if (input.scope === "current") {
      targetSessionId = currentSessionId;
    } else if (typeof input.scope === "object" && "sessionId" in input.scope) {
      targetSessionId = input.scope.sessionId;
    }
  } else {
    targetSessionId = currentSessionId;
  }

   if (!targetSessionId) {
     return createErrorResponse(
       ErrorCodes.MM_INVALID_INPUT,
       "No sessionId provided and no active session",
       { input },
       undefined,
       startTime,
     );
   }

  try {
    const summary = await knowledgeStore.summarizeSession(targetSessionId);

    return createSuccessResponse<KnowledgeSummarizeResult>(
      summary,
      targetSessionId,
      startTime,
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Summarize failed: ${message}`,
      { sessionId: targetSessionId },
      targetSessionId,
      startTime,
    );
  }
}

export async function handleKnowledgeSessions(
  input: KnowledgeSessionsInput,
  _options?: HandlerOptions,
): Promise<McpResponse<KnowledgeSessionsResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();
  const limit = input.limit ?? 10;

  try {
    const sessions = await knowledgeStore.listSessions(limit, input.filters);

    return createSuccessResponse<KnowledgeSessionsResult>(
      { sessions },
      sessionId,
      startTime,
    );
  } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Failed to list sessions: ${message}`,
      { limit, filters: input.filters },
      sessionId,
      startTime,
    );
  }
}
