/**
 * Unit tests for clipboard tool handler.
 *
 * Tests CDP-based clipboard operations (read/write) with proper mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleClipboard } from './clipboard.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';
import { ErrorCodes } from '../types/errors.js';

describe('handleClipboard', () => {
  const mockSessionManager = createMockSessionManager({
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

  beforeEach(() => {
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
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
      getGitInfoSync: vi
        .fn()
        .mockReturnValue({ branch: 'main', commit: 'abc123' }),
    } as any);
  });

  describe('write action', () => {
    it('writes text to clipboard via CDP', async () => {
      const mockCdpSession = {
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({
        action: 'write',
        text: 'test content',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.action).toBe('write');
        expect(result.result.success).toBe(true);
        expect(result.result.text).toBe('test content');
      }
      expect(mockCdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'navigator.clipboard.writeText("test content")',
        awaitPromise: true,
        userGesture: true,
      });
      expect(mockCdpSession.detach).toHaveBeenCalled();
    });

    it('detaches CDP session even if write fails', async () => {
      const mockCdpSession = {
        send: vi.fn().mockRejectedValue(new Error('Write failed')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'write', text: 'test' });

      expect(result.ok).toBe(false);
      expect(mockCdpSession.detach).toHaveBeenCalled();
    });
  });

  describe('read action', () => {
    it('reads text from clipboard via CDP', async () => {
      const mockCdpSession = {
        send: vi.fn().mockResolvedValue({
          result: { value: 'clipboard content' },
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.action).toBe('read');
        expect(result.result.success).toBe(true);
        expect(result.result.text).toBe('clipboard content');
      }
      expect(mockCdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'navigator.clipboard.readText()',
        awaitPromise: true,
        userGesture: true,
      });
    });

    it('uses description when value is missing', async () => {
      const mockCdpSession = {
        send: vi.fn().mockResolvedValue({
          result: { description: 'fallback content' },
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.text).toBe('fallback content');
      }
    });

    it('returns empty string when result is missing', async () => {
      const mockCdpSession = {
        send: vi.fn().mockResolvedValue({ result: {} }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.text).toBe('');
      }
    });
  });

  describe('error classification', () => {
    it('classifies permission denied errors', async () => {
      const mockCdpSession = {
        send: vi.fn().mockRejectedValue(new Error('permissions denied')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_PERMISSION_DENIED');
        expect(result.error.message).toContain('Clipboard permission denied');
      }
    });

    it('classifies LavaMoat blocked errors', async () => {
      const mockCdpSession = {
        send: vi.fn().mockRejectedValue(new Error('LavaMoat policy violation')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'write', text: 'test' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_LAVAMOAT_BLOCKED');
        expect(result.error.message).toContain(
          'Clipboard blocked by LavaMoat policy',
        );
      }
    });

    it('classifies generic clipboard errors', async () => {
      const mockCdpSession = {
        send: vi.fn().mockRejectedValue(new Error('Unknown error')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_FAILED');
        expect(result.error.message).toContain('Clipboard operation failed');
      }
    });
  });

  describe('input sanitization', () => {
    it('sanitizes write input for recording', async () => {
      const mockCdpSession = {
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      const recordStepSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: recordStepSpy,
        getLastSteps: vi.fn().mockResolvedValue([]),
        searchSteps: vi.fn().mockResolvedValue([]),
        summarizeSession: vi
          .fn()
          .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
        listSessions: vi.fn().mockResolvedValue([]),
        generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
        writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
        getGitInfoSync: vi
          .fn()
          .mockReturnValue({ branch: 'main', commit: 'abc123' }),
      } as any);

      await handleClipboard({ action: 'write', text: 'sensitive password' });

      expect(recordStepSpy).toHaveBeenCalled();
      const recordedInput = recordStepSpy.mock.calls[0][0].input;
      expect(recordedInput).toStrictEqual({
        action: 'write',
        textLength: 18,
      });
      expect(recordedInput).not.toHaveProperty('text');
    });

    it('sanitizes read input for recording', async () => {
      const mockCdpSession = {
        send: vi
          .fn()
          .mockResolvedValue({ result: { value: 'clipboard content' } }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const mockPage = {
        context: vi.fn().mockReturnValue({
          newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
        }),
      };
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      const recordStepSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: recordStepSpy,
        getLastSteps: vi.fn().mockResolvedValue([]),
        searchSteps: vi.fn().mockResolvedValue([]),
        summarizeSession: vi
          .fn()
          .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
        listSessions: vi.fn().mockResolvedValue([]),
        generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
        writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
        getGitInfoSync: vi
          .fn()
          .mockReturnValue({ branch: 'main', commit: 'abc123' }),
      } as any);

      await handleClipboard({ action: 'read' });

      expect(recordStepSpy).toHaveBeenCalled();
      const recordedInput = recordStepSpy.mock.calls[0][0].input;
      expect(recordedInput).toStrictEqual({
        action: 'read',
        textLength: 0,
      });
    });
  });

  describe('session validation', () => {
    it('returns error when no active session', async () => {
      const noSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        noSessionManager,
      );

      const result = await handleClipboard({ action: 'read' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });
});
