import { extractErrorMessage } from '../utils';
import type {
  KnowledgeLastInput,
  KnowledgeLastResult,
  KnowledgeScope,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSessionsInput,
  KnowledgeSessionsResult,
  KnowledgeSummarizeInput,
  KnowledgeSummarizeResult,
} from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Retrieves the most recent knowledge steps from the store.
 *
 * @param input - The step retrieval options including count and scope.
 * @param context - The tool execution context.
 * @returns The retrieved knowledge steps.
 */
export async function knowledgeLastTool(
  input: KnowledgeLastInput,
  context: ToolContext,
): Promise<ToolResponse<KnowledgeLastResult>> {
  const sessionId = context.sessionManager.getSessionId();
  const nSteps = input.n ?? 20;
  const scope: KnowledgeScope = input.scope ?? 'current';

  try {
    const steps = await context.knowledgeStore.getLastSteps(
      nSteps,
      scope,
      sessionId,
      input.filters,
    );

    return createToolSuccess({ steps });
  } catch (error) {
    return createToolError(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Failed to retrieve steps: ${extractErrorMessage(error)}`,
    );
  }
}

/**
 * Searches knowledge steps by query string.
 *
 * @param input - The search query, limit, scope, and filters.
 * @param context - The tool execution context.
 * @returns The matching knowledge steps and query.
 */
export async function knowledgeSearchTool(
  input: KnowledgeSearchInput,
  context: ToolContext,
): Promise<ToolResponse<KnowledgeSearchResult>> {
  const sessionId = context.sessionManager.getSessionId();
  const limit = input.limit ?? 20;
  const scope: KnowledgeScope = input.scope ?? 'all';

  try {
    const matches = await context.knowledgeStore.searchSteps(
      input.query,
      limit,
      scope,
      sessionId,
      input.filters,
    );

    return createToolSuccess({
      matches,
      query: input.query,
    });
  } catch (error) {
    return createToolError(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Search failed: ${extractErrorMessage(error)}`,
    );
  }
}

/**
 * Generates a summary of a knowledge session.
 *
 * @param input - The session ID or scope to summarize.
 * @param context - The tool execution context.
 * @returns The session summary.
 */
export async function knowledgeSummarizeTool(
  input: KnowledgeSummarizeInput,
  context: ToolContext,
): Promise<ToolResponse<KnowledgeSummarizeResult>> {
  const currentSessionId = context.sessionManager.getSessionId();

  let targetSessionId: string | undefined;

  if (input.sessionId) {
    targetSessionId = input.sessionId;
  } else if (input.scope) {
    if (input.scope === 'all') {
      return createToolError(
        ErrorCodes.MM_INVALID_INPUT,
        'Cannot summarize all sessions. Use scope="current" or provide a specific sessionId.',
      );
    }

    if (input.scope === 'current') {
      targetSessionId = currentSessionId;
    } else if (typeof input.scope === 'object' && 'sessionId' in input.scope) {
      targetSessionId = input.scope.sessionId;
    }
  } else {
    targetSessionId = currentSessionId;
  }

  if (!targetSessionId) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'No sessionId provided and no active session',
    );
  }

  try {
    const summary =
      await context.knowledgeStore.summarizeSession(targetSessionId);
    return createToolSuccess(summary);
  } catch (error) {
    return createToolError(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Summarize failed: ${extractErrorMessage(error)}`,
    );
  }
}

/**
 * Lists available knowledge sessions with optional filters.
 *
 * @param input - The listing options including limit and filters.
 * @param context - The tool execution context.
 * @returns The list of knowledge sessions.
 */
export async function knowledgeSessionsTool(
  input: KnowledgeSessionsInput,
  context: ToolContext,
): Promise<ToolResponse<KnowledgeSessionsResult>> {
  const limit = input.limit ?? 10;

  try {
    const sessions = await context.knowledgeStore.listSessions(
      limit,
      input.filters,
    );

    return createToolSuccess({ sessions });
  } catch (error) {
    return createToolError(
      ErrorCodes.MM_KNOWLEDGE_ERROR,
      `Failed to list sessions: ${extractErrorMessage(error)}`,
    );
  }
}
