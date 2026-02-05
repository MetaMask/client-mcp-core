/**
 * Unit tests for context tool handlers.
 *
 * Tests context switching (e2e/prod) and context info retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleSetContext, handleGetContext } from './context.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';
import { ErrorCodes } from '../types/errors.js';

describe('handleSetContext', () => {
  beforeEach(() => {
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    } as any);
  });

  it('switches context from e2e to prod', async () => {
    const mockSessionManager = createMockSessionManager({
      environmentMode: 'e2e',
    });
    vi.spyOn(mockSessionManager, 'setContext');
    // eslint-disable-next-line vitest/prefer-spy-on
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'prod',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture'] },
      canSwitchContext: true,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.previousContext).toBe('e2e');
      expect(result.result.newContext).toBe('prod');
      expect(result.result.availableCapabilities).toStrictEqual([
        'build',
        'fixture',
      ]);
    }
    expect(mockSessionManager.setContext).toHaveBeenCalledWith('prod');
  });

  it('switches context from prod to e2e', async () => {
    const mockSessionManager = createMockSessionManager({
      environmentMode: 'prod',
    });
    vi.spyOn(mockSessionManager, 'setContext');
    // eslint-disable-next-line vitest/prefer-spy-on
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture', 'chain', 'seeding'] },
      canSwitchContext: true,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleSetContext({ context: 'e2e' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.previousContext).toBe('prod');
      expect(result.result.newContext).toBe('e2e');
      expect(result.result.availableCapabilities).toStrictEqual([
        'build',
        'fixture',
        'chain',
        'seeding',
      ]);
    }
  });

  it('classifies context switch blocked errors', async () => {
    const mockSessionManager = createMockSessionManager({
      environmentMode: 'e2e',
    });
    vi.spyOn(mockSessionManager, 'setContext').mockImplementation(() => {
      throw new Error(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleSetContext({ context: 'prod' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
      expect(result.error.message).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    }
  });

  it('classifies generic context errors', async () => {
    const mockSessionManager = createMockSessionManager({
      environmentMode: 'e2e',
    });
    vi.spyOn(mockSessionManager, 'setContext').mockImplementation(() => {
      throw new Error('Unknown error');
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

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
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    } as any);
  });

  it('returns context info when getContextInfo is available', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      environmentMode: 'e2e',
    });
    // eslint-disable-next-line vitest/prefer-spy-on
    mockSessionManager.getContextInfo = vi.fn().mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: true,
      sessionId: 'test-session-123',
      capabilities: { available: ['build', 'fixture', 'chain'] },
      canSwitchContext: false,
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleGetContext({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.currentContext).toBe('e2e');
      expect(result.result.hasActiveSession).toBe(true);
      expect(result.result.sessionId).toBe('test-session-123');
      expect(result.result.capabilities.available).toStrictEqual([
        'build',
        'fixture',
        'chain',
      ]);
      expect(result.result.canSwitchContext).toBe(false);
    }
  });
});
