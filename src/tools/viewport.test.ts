import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import * as cdpModule from './utils/cdp.js';
import { resetViewportTool, setViewportTool } from './viewport.js';
import type { ToolContext } from '../types/http.js';

type Size = { width: number; height: number };

function createMockPage(initial: Size | null = { width: 1280, height: 800 }) {
  let viewport = initial;
  return {
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: Size) => {
      viewport = size;
    }),
  };
}

function createMockContext(
  options: { hasActive?: boolean; page?: object } = {},
): ToolContext {
  return {
    sessionManager: createMockSessionManager({
      hasActive: options.hasActive ?? true,
    }),
    page: options.page ?? createMockPage(),
  } as unknown as ToolContext;
}

describe('viewport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setViewportTool', () => {
    it('sets the viewport and reports the size before', async () => {
      const page = createMockPage();

      const result = await setViewportTool(
        { width: 390, height: 844 },
        createMockContext({ page }),
      );

      expect(result).toStrictEqual({
        ok: true,
        result: {
          width: 390,
          height: 844,
          original: { width: 1280, height: 800 },
        },
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({
        width: 390,
        height: 844,
      });
    });

    it('keeps the size before the first change', async () => {
      const page = createMockPage();
      const context = createMockContext({ page });

      await setViewportTool({ width: 390, height: 844 }, context);
      const result = await setViewportTool(
        { width: 800, height: 600 },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.original).toStrictEqual({
          width: 1280,
          height: 800,
        });
      }
    });

    it('reads the window size when the page has no fixed viewport', async () => {
      const page = createMockPage(null);
      const callSpy = vi
        .spyOn(cdpModule, 'callInIsolatedWorld')
        .mockResolvedValue({ width: 1440, height: 900 });

      const result = await setViewportTool(
        { width: 390, height: 844 },
        createMockContext({ page }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.original).toStrictEqual({
          width: 1440,
          height: 900,
        });
      }
      expect(callSpy).toHaveBeenCalledWith(page, expect.any(String));
    });

    it('returns error when no session active', async () => {
      const result = await setViewportTool(
        { width: 390, height: 844 },
        createMockContext({ hasActive: false }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('returns MM_VIEWPORT_FAILED when the resize fails', async () => {
      const page = createMockPage();
      page.setViewportSize.mockRejectedValue(new Error('Protocol error'));

      const result = await setViewportTool(
        { width: 390, height: 844 },
        createMockContext({ page }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_VIEWPORT_FAILED);
        expect(result.error.message).toBe(
          'Viewport change failed: Protocol error',
        );
      }
    });

    it('returns MM_PAGE_CLOSED when the page closes', async () => {
      const page = createMockPage();
      page.setViewportSize.mockRejectedValue(
        new Error('Target page, context or browser has been closed'),
      );

      const result = await setViewportTool(
        { width: 390, height: 844 },
        createMockContext({ page }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
      }
    });
  });

  describe('resetViewportTool', () => {
    it('restores the size before the first change', async () => {
      const page = createMockPage();
      const context = createMockContext({ page });
      await setViewportTool({ width: 390, height: 844 }, context);
      await setViewportTool({ width: 800, height: 600 }, context);

      const result = await resetViewportTool({}, context);

      expect(result).toStrictEqual({
        ok: true,
        result: { reset: true, viewport: { width: 1280, height: 800 } },
      });
      expect(page.setViewportSize).toHaveBeenLastCalledWith({
        width: 1280,
        height: 800,
      });
    });

    it('does nothing when set_viewport was not used on the page', async () => {
      const page = createMockPage();

      const result = await resetViewportTool({}, createMockContext({ page }));

      expect(result).toStrictEqual({
        ok: true,
        result: { reset: false, viewport: { width: 1280, height: 800 } },
      });
      expect(page.setViewportSize).not.toHaveBeenCalled();
    });

    it('does nothing on a second reset', async () => {
      const page = createMockPage();
      const context = createMockContext({ page });
      await setViewportTool({ width: 390, height: 844 }, context);
      await resetViewportTool({}, context);

      const result = await resetViewportTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.reset).toBe(false);
      }
      expect(page.setViewportSize).toHaveBeenCalledTimes(2);
    });

    it('returns error when no session active', async () => {
      const result = await resetViewportTool(
        {},
        createMockContext({ hasActive: false }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('returns MM_VIEWPORT_FAILED and keeps the size to restore when the resize fails', async () => {
      const page = createMockPage();
      const context = createMockContext({ page });
      await setViewportTool({ width: 390, height: 844 }, context);
      page.setViewportSize.mockRejectedValueOnce(new Error('Protocol error'));

      const failed = await resetViewportTool({}, context);
      const retried = await resetViewportTool({}, context);

      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error.code).toBe(ErrorCodes.MM_VIEWPORT_FAILED);
      }
      expect(retried).toStrictEqual({
        ok: true,
        result: { reset: true, viewport: { width: 1280, height: 800 } },
      });
    });
  });
});
