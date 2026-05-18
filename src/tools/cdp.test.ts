import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { cdpTool } from './cdp.js';
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

const DEFAULT_TIMEOUT_MS = 30_000;

describe('cdpTool', () => {
  describe('successful execution', () => {
    it('sends a CDP command and returns the raw result', async () => {
      const cdpResult = { result: { value: 'My Page Title' } };
      const cdpSession = {
        send: vi.fn().mockResolvedValue(cdpResult),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await cdpTool(
        {
          method: 'Runtime.evaluate',
          params: { expression: 'document.title', returnByValue: true },
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.method).toBe('Runtime.evaluate');
        expect(result.result.result).toStrictEqual(cdpResult);
      }
      expect(cdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      expect(cdpSession.detach).toHaveBeenCalled();
    });

    it('sends a CDP command with no params', async () => {
      const cdpResult = {};
      const cdpSession = {
        send: vi.fn().mockResolvedValue(cdpResult),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await cdpTool(
        { method: 'Network.enable', timeoutMs: DEFAULT_TIMEOUT_MS },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.method).toBe('Network.enable');
        expect(result.result.result).toStrictEqual(cdpResult);
      }
      expect(cdpSession.send).toHaveBeenCalledWith('Network.enable', {});
    });

    it('detaches CDP session after successful call', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      await cdpTool(
        {
          method: 'DOM.getDocument',
          params: { depth: 2 },
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        context,
      );

      expect(cdpSession.detach).toHaveBeenCalled();
    });
  });

  describe('blocked methods', () => {
    const blockedMethods = [
      'Browser.close',
      'Target.closeTarget',
      'Target.disposeBrowserContext',
      'Browser.crashGpuProcess',
    ];

    for (const method of blockedMethods) {
      it(`blocks ${method}`, async () => {
        const cdpSession = {
          send: vi.fn(),
          detach: vi.fn(),
        };
        const context = createMockContext({ cdpSession });

        const result = await cdpTool(
          { method, timeoutMs: DEFAULT_TIMEOUT_MS },
          context,
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_CDP_BLOCKED);
          expect(result.error.message).toContain(method);
          expect(result.error.message).toContain('blocked');
        }
        expect(cdpSession.send).not.toHaveBeenCalled();
      });
    }

    it('allows non-blocked methods', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await cdpTool(
        {
          method: 'Runtime.evaluate',
          params: { expression: '1+1' },
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        context,
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns MM_CDP_FAILED on CDP error', async () => {
      const cdpSession = {
        send: vi
          .fn()
          .mockRejectedValue(new Error('Protocol error: method not found')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await cdpTool(
        { method: 'Nonexistent.method', timeoutMs: DEFAULT_TIMEOUT_MS },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
        expect(result.error.message).toContain('Nonexistent.method');
        expect(result.error.message).toContain('Protocol error');
      }
    });

    it('detaches CDP session even on failure', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue(new Error('boom')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      await cdpTool(
        { method: 'Runtime.evaluate', timeoutMs: DEFAULT_TIMEOUT_MS },
        context,
      );

      expect(cdpSession.detach).toHaveBeenCalled();
    });

    it('handles non-Error throwables', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue('string error'),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const result = await cdpTool(
        { method: 'Runtime.evaluate', timeoutMs: DEFAULT_TIMEOUT_MS },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
        expect(result.error.message).toContain('string error');
      }
    });
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('times out long-running CDP calls', async () => {
      const cdpSession = {
        send: vi.fn().mockReturnValue(new Promise(() => {})),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const context = createMockContext({ cdpSession });

      const resultPromise = cdpTool(
        { method: 'Runtime.evaluate', timeoutMs: 5_000 },
        context,
      );

      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
        expect(result.error.message).toContain('timed out');
      }
    });
  });

  describe('session validation', () => {
    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await cdpTool(
        { method: 'Runtime.evaluate', timeoutMs: DEFAULT_TIMEOUT_MS },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });
});
