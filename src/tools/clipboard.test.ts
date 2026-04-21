/**
 * Unit tests for clipboard tool handler.
 *
 * Tests CDP-based clipboard operations (read/write) with proper mocking.
 */

import { describe, it, expect, vi } from 'vitest';

import { clipboardTool } from './clipboard.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(
  options: {
    hasActive?: boolean;
    cdpSession?: {
      send: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
    };
  } = {},
): ToolContext {
  const { hasActive = true, cdpSession } = options;

  const mockCdpSession = cdpSession ?? {
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const mockPage = {
    context: vi.fn().mockReturnValue({
      newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
    }),
  };

  return {
    sessionManager: createMockSessionManager({ hasActive }),
    page: mockPage,
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('clipboardTool', () => {
  describe('write action', () => {
    it('writes text to clipboard via CDP', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool(
        { action: 'write', text: 'test content' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.action).toBe('write');
        expect(result.result.success).toBe(true);
        expect(result.result.text).toBe('test content');
      }
      expect(cdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'navigator.clipboard.writeText("test content")',
        awaitPromise: true,
        userGesture: true,
      });
      expect(cdpSession.detach).toHaveBeenCalled();
    });

    it('detaches CDP session even if write fails', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue(new Error('Write failed')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool(
        { action: 'write', text: 'test' },
        context,
      );

      expect(result.ok).toBe(false);
      expect(cdpSession.detach).toHaveBeenCalled();
    });
  });

  describe('read action', () => {
    it('reads text from clipboard via CDP', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({
          result: { value: 'clipboard content' },
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.action).toBe('read');
        expect(result.result.success).toBe(true);
        expect(result.result.text).toBe('clipboard content');
      }
      expect(cdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'navigator.clipboard.readText()',
        awaitPromise: true,
        userGesture: true,
      });
    });

    it('uses description when value is missing', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({
          result: { description: 'fallback content' },
        }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.text).toBe('fallback content');
      }
    });

    it('returns empty string when result is missing', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ result: {} }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.text).toBe('');
      }
    });
  });

  describe('error classification', () => {
    it('classifies permission denied errors', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue(new Error('permissions denied')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_PERMISSION_DENIED');
        expect(result.error.message).toContain('Clipboard permission denied');
      }
    });

    it('classifies LavaMoat blocked errors', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue(new Error('LavaMoat policy violation')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool(
        { action: 'write', text: 'test' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_LAVAMOAT_BLOCKED');
        expect(result.error.message).toContain(
          'Clipboard blocked by LavaMoat policy',
        );
      }
    });

    it('classifies generic clipboard errors', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue(new Error('Unknown error')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLIPBOARD_FAILED');
        expect(result.error.message).toContain('Clipboard operation failed');
      }
    });
  });

  describe('session validation', () => {
    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await clipboardTool({ action: 'read' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });
});
