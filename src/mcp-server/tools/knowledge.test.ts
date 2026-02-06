/**
 * Unit tests for knowledge tool handlers.
 *
 * Tests knowledge store query handlers including last N steps, search,
 * summarize, and session listing with various filter combinations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  handleKnowledgeLast,
  handleKnowledgeSearch,
  handleKnowledgeSummarize,
  handleKnowledgeSessions,
} from './knowledge.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';
import { ErrorCodes } from '../types/errors.js';

describe('knowledge', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockKnowledgeStore: any;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
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
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    // Mock knowledge store to prevent "not initialized" errors
    mockKnowledgeStore = {
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        stepCount: 0,
        recipe: [],
      }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    };
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue(
      mockKnowledgeStore,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleKnowledgeLast', () => {
    it('retrieves last N steps with default parameters', async () => {
      // Arrange
      const mockSteps = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'home' },
        { timestamp: '2026-02-04T10:01:00Z', tool: 'mm_type', screen: 'home' },
      ];
      mockKnowledgeStore.getLastSteps.mockResolvedValue(mockSteps);

      // Act
      const result = await handleKnowledgeLast({});

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(mockKnowledgeStore.getLastSteps).toHaveBeenCalledWith(
        20, // default n
        'current', // default scope
        'test-session-123',
        undefined, // no filters
      );
    });

    it('retrieves last N steps with custom n parameter', async () => {
      // Arrange
      const mockSteps = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'home' },
      ];
      mockKnowledgeStore.getLastSteps.mockResolvedValue(mockSteps);

      // Act
      const result = await handleKnowledgeLast({ n: 5 });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(mockKnowledgeStore.getLastSteps).toHaveBeenCalledWith(
        5,
        'current',
        'test-session-123',
        undefined,
      );
    });

    it('retrieves steps with scope "all"', async () => {
      // Arrange
      const mockSteps = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'home' },
      ];
      mockKnowledgeStore.getLastSteps.mockResolvedValue(mockSteps);

      // Act
      const result = await handleKnowledgeLast({ scope: 'all' });

      // Assert
      expect(result.ok).toBe(true);
      expect(mockKnowledgeStore.getLastSteps).toHaveBeenCalledWith(
        20,
        'all',
        'test-session-123',
        undefined,
      );
    });

    it('retrieves steps with filters', async () => {
      // Arrange
      const mockSteps = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'send' },
      ];
      mockKnowledgeStore.getLastSteps.mockResolvedValue(mockSteps);
      const filters = {
        flowTag: 'send',
        screen: 'send',
        sinceHours: 24,
      };

      // Act
      const result = await handleKnowledgeLast({ n: 10, filters });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual(mockSteps);
      }
      expect(mockKnowledgeStore.getLastSteps).toHaveBeenCalledWith(
        10,
        'current',
        'test-session-123',
        filters,
      );
    });

    it('returns empty array when no steps found', async () => {
      // Arrange
      mockKnowledgeStore.getLastSteps.mockResolvedValue([]);

      // Act
      const result = await handleKnowledgeLast({ n: 10 });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.steps).toStrictEqual([]);
      }
    });

    it('returns error when knowledge store fails', async () => {
      // Arrange
      mockKnowledgeStore.getLastSteps.mockRejectedValue(
        new Error('Database connection failed'),
      );

      // Act
      const result = await handleKnowledgeLast({ n: 10 });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Failed to retrieve steps');
        expect(result.error.message).toContain('Database connection failed');
      }
    });
  });

  describe('handleKnowledgeSearch', () => {
    it('searches steps with default parameters', async () => {
      // Arrange
      const mockMatches = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'home' },
      ];
      mockKnowledgeStore.searchSteps.mockResolvedValue(mockMatches);

      // Act
      const result = await handleKnowledgeSearch({ query: 'mm_click' });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
        expect(result.result.query).toBe('mm_click');
      }
      expect(mockKnowledgeStore.searchSteps).toHaveBeenCalledWith(
        'mm_click',
        20, // default limit
        'all', // default scope
        'test-session-123',
        undefined, // no filters
      );
    });

    it('searches steps with custom limit', async () => {
      // Arrange
      const mockMatches = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_type', screen: 'send' },
      ];
      mockKnowledgeStore.searchSteps.mockResolvedValue(mockMatches);

      // Act
      const result = await handleKnowledgeSearch({
        query: 'mm_type',
        limit: 50,
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
      }
      expect(mockKnowledgeStore.searchSteps).toHaveBeenCalledWith(
        'mm_type',
        50,
        'all',
        'test-session-123',
        undefined,
      );
    });

    it('searches steps with scope "current"', async () => {
      // Arrange
      const mockMatches = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'home' },
      ];
      mockKnowledgeStore.searchSteps.mockResolvedValue(mockMatches);

      // Act
      const result = await handleKnowledgeSearch({
        query: 'mm_click',
        scope: 'current',
      });

      // Assert
      expect(result.ok).toBe(true);
      expect(mockKnowledgeStore.searchSteps).toHaveBeenCalledWith(
        'mm_click',
        20,
        'current',
        'test-session-123',
        undefined,
      );
    });

    it('searches steps with filters', async () => {
      // Arrange
      const mockMatches = [
        { timestamp: '2026-02-04T10:00:00Z', tool: 'mm_click', screen: 'send' },
      ];
      mockKnowledgeStore.searchSteps.mockResolvedValue(mockMatches);
      const filters = {
        flowTag: 'send',
        tag: 'transaction',
        screen: 'send',
      };

      // Act
      const result = await handleKnowledgeSearch({
        query: 'confirm',
        limit: 10,
        filters,
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual(mockMatches);
      }
      expect(mockKnowledgeStore.searchSteps).toHaveBeenCalledWith(
        'confirm',
        10,
        'all',
        'test-session-123',
        filters,
      );
    });

    it('returns empty array when no matches found', async () => {
      // Arrange
      mockKnowledgeStore.searchSteps.mockResolvedValue([]);

      // Act
      const result = await handleKnowledgeSearch({ query: 'nonexistent' });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.matches).toStrictEqual([]);
        expect(result.result.query).toBe('nonexistent');
      }
    });

    it('returns error when search fails', async () => {
      // Arrange
      mockKnowledgeStore.searchSteps.mockRejectedValue(
        new Error('Search index corrupted'),
      );

      // Act
      const result = await handleKnowledgeSearch({ query: 'test' });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Search failed');
        expect(result.error.message).toContain('Search index corrupted');
      }
    });
  });

  describe('handleKnowledgeSummarize', () => {
    it('summarizes current session by default', async () => {
      // Arrange
      const mockSummary = {
        sessionId: 'test-session-123',
        stepCount: 5,
        recipe: [
          { stepNumber: 1, tool: 'mm_click', notes: 'Clicked send button' },
          { stepNumber: 2, tool: 'mm_type', notes: 'Entered amount' },
        ],
      };
      mockKnowledgeStore.summarizeSession.mockResolvedValue(mockSummary);

      // Act
      const result = await handleKnowledgeSummarize({});

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(mockKnowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'test-session-123',
      );
    });

    it('summarizes current session with scope "current"', async () => {
      // Arrange
      const mockSummary = {
        sessionId: 'test-session-123',
        stepCount: 3,
        recipe: [],
      };
      mockKnowledgeStore.summarizeSession.mockResolvedValue(mockSummary);

      // Act
      const result = await handleKnowledgeSummarize({ scope: 'current' });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(mockKnowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'test-session-123',
      );
    });

    it('summarizes specific session by sessionId', async () => {
      // Arrange
      const mockSummary = {
        sessionId: 'other-session-456',
        stepCount: 10,
        recipe: [
          { stepNumber: 1, tool: 'mm_launch', notes: 'Launched browser' },
        ],
      };
      mockKnowledgeStore.summarizeSession.mockResolvedValue(mockSummary);

      // Act
      const result = await handleKnowledgeSummarize({
        sessionId: 'other-session-456',
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(mockKnowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'other-session-456',
      );
    });

    it('summarizes session with scope object containing sessionId', async () => {
      // Arrange
      const mockSummary = {
        sessionId: 'scoped-session-789',
        stepCount: 7,
        recipe: [],
      };
      mockKnowledgeStore.summarizeSession.mockResolvedValue(mockSummary);

      // Act
      const result = await handleKnowledgeSummarize({
        scope: { sessionId: 'scoped-session-789' },
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual(mockSummary);
      }
      expect(mockKnowledgeStore.summarizeSession).toHaveBeenCalledWith(
        'scoped-session-789',
      );
    });

    it('returns error when scope is "all"', async () => {
      // Act
      const result = await handleKnowledgeSummarize({ scope: 'all' });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Cannot summarize all sessions');
      }
    });

    it('returns error when no sessionId can be determined', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(undefined);

      // Act
      const result = await handleKnowledgeSummarize({});

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('No sessionId provided');
      }
    });

    it('returns error when summarize fails', async () => {
      // Arrange
      mockKnowledgeStore.summarizeSession.mockRejectedValue(
        new Error('Session not found'),
      );

      // Act
      const result = await handleKnowledgeSummarize({
        sessionId: 'nonexistent-session',
      });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Summarize failed');
        expect(result.error.message).toContain('Session not found');
      }
    });
  });

  describe('handleKnowledgeSessions', () => {
    it('lists sessions with default limit', async () => {
      // Arrange
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
      mockKnowledgeStore.listSessions.mockResolvedValue(mockSessions);

      // Act
      const result = await handleKnowledgeSessions({});

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(mockKnowledgeStore.listSessions).toHaveBeenCalledWith(
        10, // default limit
        undefined, // no filters
      );
    });

    it('lists sessions with custom limit', async () => {
      // Arrange
      const mockSessions = [
        {
          sessionId: 'session-1',
          createdAt: '2026-02-04T10:00:00Z',
          flowTags: [],
          tags: [],
        },
      ];
      mockKnowledgeStore.listSessions.mockResolvedValue(mockSessions);

      // Act
      const result = await handleKnowledgeSessions({ limit: 25 });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(mockKnowledgeStore.listSessions).toHaveBeenCalledWith(
        25,
        undefined,
      );
    });

    it('lists sessions with filters', async () => {
      // Arrange
      const mockSessions = [
        {
          sessionId: 'session-1',
          createdAt: '2026-02-04T10:00:00Z',
          flowTags: ['send'],
          tags: [],
        },
      ];
      mockKnowledgeStore.listSessions.mockResolvedValue(mockSessions);
      const filters = {
        flowTag: 'send',
        sinceHours: 48,
      };

      // Act
      const result = await handleKnowledgeSessions({ limit: 20, filters });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual(mockSessions);
      }
      expect(mockKnowledgeStore.listSessions).toHaveBeenCalledWith(20, filters);
    });

    it('returns empty array when no sessions found', async () => {
      // Arrange
      mockKnowledgeStore.listSessions.mockResolvedValue([]);

      // Act
      const result = await handleKnowledgeSessions({ limit: 10 });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessions).toStrictEqual([]);
      }
    });

    it('returns error when listing fails', async () => {
      // Arrange
      mockKnowledgeStore.listSessions.mockRejectedValue(
        new Error('Database unavailable'),
      );

      // Act
      const result = await handleKnowledgeSessions({});

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_KNOWLEDGE_ERROR);
        expect(result.error.message).toContain('Failed to list sessions');
        expect(result.error.message).toContain('Database unavailable');
      }
    });
  });
});
