/**
 * Unit tests for cleanup tool handler.
 *
 * Tests session cleanup with various session states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleCleanup } from './cleanup.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';

describe('handleCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cleans up active session successfully', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
    });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(true);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.cleanedUp).toBe(true);
      expect(result.meta.sessionId).toBe('test-session-123');
    }
    expect(mockSessionManager.cleanup).toHaveBeenCalled();
  });

  it('returns false when no session to clean up', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: false });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(false);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.cleanedUp).toBe(false);
    }
  });

  it('uses provided sessionId in input', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'current-session',
    });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(true);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({ sessionId: 'custom-session-456' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.sessionId).toBe('custom-session-456');
    }
  });

  it('falls back to current sessionId when input sessionId is undefined', async () => {
    const mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-789',
    });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(true);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.sessionId).toBe('test-session-789');
    }
  });

  it('handles cleanup when sessionId is undefined', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: false });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(false);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.cleanedUp).toBe(false);
    }
  });

  it('includes timestamp in response', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: true });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(true);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.timestamp).toBeDefined();
      expect(typeof result.meta.timestamp).toBe('string');
      expect(new Date(result.meta.timestamp).getTime()).toBeGreaterThan(0);
    }
  });

  it('includes durationMs in response', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: true });
    vi.spyOn(mockSessionManager, 'cleanup').mockResolvedValue(true);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleCleanup({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.meta.durationMs).toBe('number');
    }
  });

  it('cleans up multiple times without error', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: true });
    vi.spyOn(mockSessionManager, 'cleanup')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result1 = await handleCleanup({});
    const result2 = await handleCleanup({});

    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.result.cleanedUp).toBe(true);
    }

    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.result.cleanedUp).toBe(false);
    }

    expect(mockSessionManager.cleanup).toHaveBeenCalledTimes(2);
  });
});
