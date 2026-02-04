/**
 * Unit tests for context tool handlers.
 *
 * Tests context switching (e2e/prod) and context info retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSetContext, handleGetContext } from './context.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';
import * as sessionManagerModule from '../session-manager.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import { ErrorCodes } from '../types/errors.js';

describe('handleSetContext', () => {
  beforeEach(() => {
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
      getGitInfoSync: vi.fn().mockReturnValue({ branch: 'main', commit: 'abc123' }),
    } as any);
  });

  it('switches context from e2e to prod', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'e2e' });
    mockSessionManager.setContext = vi.fn();
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'prod',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture'] },
      canSwitchContext: true,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.previousContext).toBe('e2e');
      expect(result.result.newContext).toBe('prod');
      expect(result.result.availableCapabilities).toEqual(['build', 'fixture']);
    }
    expect(mockSessionManager.setContext).toHaveBeenCalledWith('prod');
  });

  it('switches context from prod to e2e', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'prod' });
    mockSessionManager.setContext = vi.fn();
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture', 'chain', 'seeding'] },
      canSwitchContext: true,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'e2e' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.previousContext).toBe('prod');
      expect(result.result.newContext).toBe('e2e');
      expect(result.result.availableCapabilities).toEqual(['build', 'fixture', 'chain', 'seeding']);
    }
  });

  it('returns empty capabilities when getContextInfo is not available', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'e2e' });
    mockSessionManager.setContext = vi.fn();
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.availableCapabilities).toEqual([]);
    }
  });

  it('returns error when setContext is not supported', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'e2e' });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_SET_CONTEXT_FAILED);
      expect(result.error.message).toContain('Context switching not supported');
    }
  });

  it('classifies context switch blocked errors', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'e2e' });
    mockSessionManager.setContext = vi.fn().mockImplementation(() => {
      throw new Error(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
      expect(result.error.message).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    }
  });

  it('classifies generic context errors', async () => {
    const mockSessionManager = createMockSessionManager({ environmentMode: 'e2e' });
    mockSessionManager.setContext = vi.fn().mockImplementation(() => {
      throw new Error('Unknown error');
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_SET_CONTEXT_FAILED);
      expect(result.error.message).toContain('Context switch failed');
    }
  });
});

describe('handleGetContext', () => {
  beforeEach(() => {
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
      getGitInfoSync: vi.fn().mockReturnValue({ branch: 'main', commit: 'abc123' }),
    } as any);
  });

  it('returns context info when getContextInfo is available', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      environmentMode: 'e2e',
    });
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: true,
      sessionId: 'test-session-123',
      capabilities: { available: ['build', 'fixture', 'chain'] },
      canSwitchContext: false,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleGetContext({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.currentContext).toBe('e2e');
      expect(result.result.hasActiveSession).toBe(true);
      expect(result.result.sessionId).toBe('test-session-123');
      expect(result.result.capabilities.available).toEqual(['build', 'fixture', 'chain']);
      expect(result.result.canSwitchContext).toBe(false);
    }
  });

  it('returns fallback context info when getContextInfo is not available', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: false,
      environmentMode: 'prod',
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleGetContext({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.currentContext).toBe('prod');
      expect(result.result.hasActiveSession).toBe(false);
      expect(result.result.sessionId).toBe(null);
      expect(result.result.capabilities.available).toEqual([]);
      expect(result.result.canSwitchContext).toBe(true);
    }
  });

  it('returns canSwitchContext false when session is active', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      environmentMode: 'e2e',
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleGetContext({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.canSwitchContext).toBe(false);
    }
  });

  it('returns canSwitchContext true when no session is active', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: false,
      environmentMode: 'prod',
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(mockSessionManager);

    const result = await handleGetContext({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.canSwitchContext).toBe(true);
    }
  });
});
