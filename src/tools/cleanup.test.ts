/**
 * Unit tests for cleanup tool handler.
 *
 * Tests session cleanup with various session states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { cleanupTool } from './cleanup.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(hasActive = false): ToolContext {
  return {
    sessionManager: createMockSessionManager({ hasActive }),
    page: {},
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('cleanupTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cleans up active session successfully', async () => {
    const context = createMockContext(true);
    vi.spyOn(context.sessionManager, 'cleanup').mockResolvedValue(true);

    const result = await cleanupTool({}, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.cleanedUp).toBe(true);
    }
    expect(context.sessionManager.cleanup).toHaveBeenCalled();
  });

  it('returns false when no session to clean up', async () => {
    const context = createMockContext(false);
    vi.spyOn(context.sessionManager, 'cleanup').mockResolvedValue(false);

    const result = await cleanupTool({}, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.cleanedUp).toBe(false);
    }
  });

  it('cleans up multiple times without error', async () => {
    const context = createMockContext(true);
    vi.spyOn(context.sessionManager, 'cleanup')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result1 = await cleanupTool({}, context);
    const result2 = await cleanupTool({}, context);

    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.result.cleanedUp).toBe(true);
    }

    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.result.cleanedUp).toBe(false);
    }

    expect(context.sessionManager.cleanup).toHaveBeenCalledTimes(2);
  });
});
