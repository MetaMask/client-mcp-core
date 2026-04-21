/**
 * Unit tests for context tool handlers.
 *
 * Tests context switching (e2e/prod) and context info retrieval.
 */

import { describe, it, expect, vi } from 'vitest';

import { setContextTool, getContextTool } from './context.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(
  options: {
    hasActive?: boolean;
    sessionId?: string;
    environmentMode?: 'e2e' | 'prod';
  } = {},
): ToolContext {
  return {
    sessionManager: createMockSessionManager(options),
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('setContextTool', () => {
  it('switches context from e2e to prod', async () => {
    const context = createMockContext({ environmentMode: 'e2e' });
    vi.mocked(context.sessionManager.getContextInfo).mockReturnValue({
      currentContext: 'prod',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture'] },
      canSwitchContext: true,
    });

    const result = await setContextTool({ context: 'prod' }, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.previousContext).toBe('e2e');
      expect(result.result.newContext).toBe('prod');
      expect(result.result.availableCapabilities).toStrictEqual([
        'build',
        'fixture',
      ]);
    }
    expect(context.sessionManager.setContext).toHaveBeenCalledWith(
      'prod',
      undefined,
    );
  });

  it('forwards context options to session manager', async () => {
    const context = createMockContext({ environmentMode: 'e2e' });
    vi.mocked(context.sessionManager.getContextInfo).mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture', 'chain'] },
      canSwitchContext: true,
    });

    const contextOptions = {
      mockServer: {
        enabled: true,
        port: 18000,
      },
    };

    const result = await setContextTool(
      {
        context: 'e2e',
        options: contextOptions,
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(context.sessionManager.setContext).toHaveBeenCalledWith(
      'e2e',
      contextOptions,
    );
  });

  it('switches context from prod to e2e', async () => {
    const context = createMockContext({ environmentMode: 'prod' });
    vi.mocked(context.sessionManager.getContextInfo).mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: ['build', 'fixture', 'chain', 'seeding'] },
      canSwitchContext: true,
    });

    const result = await setContextTool({ context: 'e2e' }, context);

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
    const context = createMockContext({ environmentMode: 'e2e' });
    vi.mocked(context.sessionManager.setContext).mockImplementation(() => {
      throw new Error(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    });

    const result = await setContextTool({ context: 'prod' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
      expect(result.error.message).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
    }
  });

  it('classifies generic context errors', async () => {
    const context = createMockContext({ environmentMode: 'e2e' });
    vi.mocked(context.sessionManager.setContext).mockImplementation(() => {
      throw new Error('Unknown error');
    });

    const result = await setContextTool({ context: 'prod' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_SET_CONTEXT_FAILED);
      expect(result.error.message).toContain('Context switch failed');
    }
  });
});

describe('getContextTool', () => {
  it('returns context info when getContextInfo is available', async () => {
    const context = createMockContext({
      hasActive: true,
      sessionId: 'test-session-123',
      environmentMode: 'e2e',
    });
    vi.mocked(context.sessionManager.getContextInfo).mockReturnValue({
      currentContext: 'e2e',
      hasActiveSession: true,
      sessionId: 'test-session-123',
      capabilities: { available: ['build', 'fixture', 'chain'] },
      canSwitchContext: false,
    });

    const result = await getContextTool({}, context);

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
