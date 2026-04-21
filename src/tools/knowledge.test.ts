/**
 * Unit tests for knowledge tool handlers.
 *
 * Tests knowledge store query handlers including last N steps, search,
 * summarize, and session listing with various filter combinations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  knowledgeLastTool,
  knowledgeSearchTool,
  knowledgeSummarizeTool,
  knowledgeSessionsTool,
} from './knowledge.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(): ToolContext {
  return {
    sessionManager: createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      sessionMetadata: {
        schemaVersion: 1,
        sessionId: 'test-session-123',
        createdAt: new Date().toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      },
    }),
    page: {},
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        stepCount: 0,
        recipe: [],
      }),
      listSessions: vi.fn().mockResolvedValue([]),
    },
  } as unknown as ToolContext;
}

describe('knowledge', () => {
  let context: ToolContext;

  beforeEach(() => {
    context = createMockContext();
  });

  describe('knowledgeLastTool', () => {
    it('retrieves last N steps with default parameters', async () => {
      const mockSteps = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'home',
          snippet: 'Clicked send',
        },
        {
          timestamp: '2026-02-04T10:01:00Z',
          tool: 'type',
          screen: 'home',
          snippet: 'Entered amount',
        },
      ];
      vi.mocked(context.knowledgeStore.getLastSteps).mockResolvedValue(
        mockSteps,
      );

      const result = await knowledgeLastTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(context.knowledgeStore.getLastSteps).toHaveBeenCalledWith(
        20,
        'current',
        'test-session-123',
        undefined,
      );
    });

    it('retrieves last N steps with custom n parameter', async () => {
      const mockSteps = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'home',
          snippet: 'Clicked send',
        },
      ];
      vi.mocked(context.knowledgeStore.getLastSteps).mockResolvedValue(
        mockSteps,
      );

      const result = await knowledgeLastTool({ n: 5 }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(context.knowledgeStore.getLastSteps).toHaveBeenCalledWith(
        5,
        'current',
        'test-session-123',
        undefined,
      );
    });

    it('retrieves steps with scope "all"', async () => {
      const mockSteps = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'home',
          snippet: 'Clicked send',
        },
      ];
      vi.mocked(context.knowledgeStore.getLastSteps).mockResolvedValue(
        mockSteps,
      );

      const result = await knowledgeLastTool({ scope: 'all' }, context);

      expect(result.ok).toBe(true);
      expect(context.knowledgeStore.getLastSteps).toHaveBeenCalledWith(
        20,
        'all',
        'test-session-123',
        undefined,
      );
    });

    it('retrieves steps with filters', async () => {
      const mockSteps = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'send',
          snippet: 'Clicked confirm',
        },
      ];
      const filters = {
        flowTag: 'send',
        screen: 'send',
        sinceHours: 24,
      };
      vi.mocked(context.knowledgeStore.getLastSteps).mockResolvedValue(
        mockSteps,
      );

      const result = await knowledgeLastTool({ n: 10, filters }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(context.knowledgeStore.getLastSteps).toHaveBeenCalledWith(
        10,
        'current',
        'test-session-123',
        filters,
      );
    });

    it('returns empty array when no steps found', async () => {
      vi.mocked(context.knowledgeStore.getLastSteps).mockResolvedValue([]);

      const result = await knowledgeLastTool({ n: 10 }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual([]);
      }
    });

    it('returns error when knowledge store fails', async () => {
      vi.mocked(context.knowledgeStore.getLastSteps).mockRejectedValue(
        new Error('Database connection failed'),
      );

      const result = await knowledgeLastTool({ n: 10 }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Failed to retrieve steps');
        expect(result.error.message).toContain('Database connection failed');
      }
    });
  });

  describe('knowledgeSearchTool', () => {
    it('searches steps with default parameters', async () => {
      const mockMatches = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'home',
          snippet: 'Clicked send',
        },
      ];
      vi.mocked(context.knowledgeStore.searchSteps).mockResolvedValue(
        mockMatches,
      );

      const result = await knowledgeSearchTool({ query: 'click' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
        expect(result.result.query).toBe('click');
      }
      expect(context.knowledgeStore.searchSteps).toHaveBeenCalledWith(
        'click',
        20,
        'all',
        'test-session-123',
        undefined,
      );
    });

    it('searches steps with custom limit', async () => {
      const mockMatches = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'type',
          screen: 'send',
          snippet: 'Entered recipient',
        },
      ];
      vi.mocked(context.knowledgeStore.searchSteps).mockResolvedValue(
        mockMatches,
      );

      const result = await knowledgeSearchTool(
        { query: 'type', limit: 50 },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
      }
      expect(context.knowledgeStore.searchSteps).toHaveBeenCalledWith(
        'type',
        50,
        'all',
        'test-session-123',
        undefined,
      );
    });

    it('searches steps with scope "current"', async () => {
      const mockMatches = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'home',
          snippet: 'Clicked send',
        },
      ];
      vi.mocked(context.knowledgeStore.searchSteps).mockResolvedValue(
        mockMatches,
      );

      const result = await knowledgeSearchTool(
        { query: 'click', scope: 'current' },
        context,
      );

      expect(result.ok).toBe(true);
      expect(context.knowledgeStore.searchSteps).toHaveBeenCalledWith(
        'click',
        20,
        'current',
        'test-session-123',
        undefined,
      );
    });

    it('searches steps with filters', async () => {
      const mockMatches = [
        {
          timestamp: '2026-02-04T10:00:00Z',
          tool: 'click',
          screen: 'send',
          snippet: 'Confirmed transaction',
        },
      ];
      const filters = {
        flowTag: 'send',
        tag: 'transaction',
        screen: 'send',
      };
      vi.mocked(context.knowledgeStore.searchSteps).mockResolvedValue(
        mockMatches,
      );

      const result = await knowledgeSearchTool(
        { query: 'confirm', limit: 10, filters },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
      }
      expect(context.knowledgeStore.searchSteps).toHaveBeenCalledWith(
        'confirm',
        10,
        'all',
        'test-session-123',
        filters,
      );
    });

    it('returns empty array when no matches found', async () => {
      vi.mocked(context.knowledgeStore.searchSteps).mockResolvedValue([]);

      const result = await knowledgeSearchTool(
        { query: 'nonexistent' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual([]);
        expect(result.result.query).toBe('nonexistent');
      }
    });

    it('returns error when search fails', async () => {
      vi.mocked(context.knowledgeStore.searchSteps).mockRejectedValue(
        new Error('Search index corrupted'),
      );

      const result = await knowledgeSearchTool({ query: 'test' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Search failed');
        expect(result.error.message).toContain('Search index corrupted');
      }
    });
  });

  describe('knowledgeSummarizeTool', () => {
    it('summarizes current session by default', async () => {
      const mockSummary = {
        sessionId: 'test-session-123',
        stepCount: 5,
        recipe: [
          { stepNumber: 1, tool: 'click', notes: 'Clicked send button' },
          { stepNumber: 2, tool: 'type', notes: 'Entered amount' },
        ],
      };
      vi.mocked(context.knowledgeStore.summarizeSession).mockResolvedValue(
        mockSummary,
      );

      const result = await knowledgeSummarizeTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(context.knowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'test-session-123',
      );
    });

    it('summarizes current session with scope "current"', async () => {
      const mockSummary = {
        sessionId: 'test-session-123',
        stepCount: 3,
        recipe: [],
      };
      vi.mocked(context.knowledgeStore.summarizeSession).mockResolvedValue(
        mockSummary,
      );

      const result = await knowledgeSummarizeTool(
        { scope: 'current' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(context.knowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'test-session-123',
      );
    });

    it('summarizes specific session by sessionId', async () => {
      const mockSummary = {
        sessionId: 'other-session-456',
        stepCount: 10,
        recipe: [{ stepNumber: 1, tool: 'launch', notes: 'Launched browser' }],
      };
      vi.mocked(context.knowledgeStore.summarizeSession).mockResolvedValue(
        mockSummary,
      );

      const result = await knowledgeSummarizeTool(
        { sessionId: 'other-session-456' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(context.knowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'other-session-456',
      );
    });

    it('summarizes session with scope object containing sessionId', async () => {
      const mockSummary = {
        sessionId: 'scoped-session-789',
        stepCount: 7,
        recipe: [],
      };
      vi.mocked(context.knowledgeStore.summarizeSession).mockResolvedValue(
        mockSummary,
      );

      const result = await knowledgeSummarizeTool(
        { scope: { sessionId: 'scoped-session-789' } },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(context.knowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'scoped-session-789',
      );
    });

    it('returns error when scope is "all"', async () => {
      const result = await knowledgeSummarizeTool({ scope: 'all' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Cannot summarize all sessions');
      }
    });

    it('returns error when no sessionId can be determined', async () => {
      vi.mocked(context.sessionManager.getSessionId).mockReturnValue(undefined);

      const result = await knowledgeSummarizeTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('No sessionId provided');
      }
    });

    it('returns error when summarize fails', async () => {
      vi.mocked(context.knowledgeStore.summarizeSession).mockRejectedValue(
        new Error('Session not found'),
      );

      const result = await knowledgeSummarizeTool(
        { sessionId: 'nonexistent-session' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Summarize failed');
        expect(result.error.message).toContain('Session not found');
      }
    });
  });

  describe('knowledgeSessionsTool', () => {
    it('lists sessions with default limit', async () => {
      const mockSessions = [
        {
          sessionId: 'session-1',
          createdAt: '2026-02-04T10:00:00Z',
          goal: 'Test send flow',
          flowTags: ['send'],
          tags: [],
        },
        {
          sessionId: 'session-2',
          createdAt: '2026-02-04T09:00:00Z',
          flowTags: [],
          tags: ['test'],
        },
      ];
      vi.mocked(context.knowledgeStore.listSessions).mockResolvedValue(
        mockSessions,
      );

      const result = await knowledgeSessionsTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(context.knowledgeStore.listSessions).toHaveBeenCalledWith(
        10,
        undefined,
      );
    });

    it('lists sessions with custom limit', async () => {
      const mockSessions = [
        {
          sessionId: 'session-1',
          createdAt: '2026-02-04T10:00:00Z',
          flowTags: [],
          tags: [],
        },
      ];
      vi.mocked(context.knowledgeStore.listSessions).mockResolvedValue(
        mockSessions,
      );

      const result = await knowledgeSessionsTool({ limit: 25 }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(context.knowledgeStore.listSessions).toHaveBeenCalledWith(
        25,
        undefined,
      );
    });

    it('lists sessions with filters', async () => {
      const mockSessions = [
        {
          sessionId: 'session-1',
          createdAt: '2026-02-04T10:00:00Z',
          flowTags: ['send'],
          tags: [],
        },
      ];
      const filters = {
        flowTag: 'send',
        sinceHours: 48,
      };
      vi.mocked(context.knowledgeStore.listSessions).mockResolvedValue(
        mockSessions,
      );

      const result = await knowledgeSessionsTool(
        { limit: 20, filters },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(context.knowledgeStore.listSessions).toHaveBeenCalledWith(
        20,
        filters,
      );
    });

    it('returns empty array when no sessions found', async () => {
      vi.mocked(context.knowledgeStore.listSessions).mockResolvedValue([]);

      const result = await knowledgeSessionsTool({ limit: 10 }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual([]);
      }
    });

    it('returns error when listing fails', async () => {
      vi.mocked(context.knowledgeStore.listSessions).mockRejectedValue(
        new Error('Database unavailable'),
      );

      const result = await knowledgeSessionsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Failed to list sessions');
        expect(result.error.message).toContain('Database unavailable');
      }
    });
  });
});
