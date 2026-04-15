/**
 * Unit tests for screenshot tool handler.
 *
 * Tests screenshotTool with various options including base64 encoding,
 * selector scoping, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';

import { screenshotTool } from './screenshot.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(
  options: {
    hasActive?: boolean;
  } = {},
): ToolContext {
  const { hasActive = true } = options;

  return {
    sessionManager: createMockSessionManager({ hasActive }),
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('screenshotTool', () => {
  describe('basic screenshot', () => {
    it('captures full page screenshot by default', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64: 'mock-base64',
      });

      const result = await screenshotTool({ name: 'test-screenshot' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.path).toBe('/path/to/screenshot.png');
        expect(result.result.width).toBe(1280);
        expect(result.result.height).toBe(720);
        expect(result.result.base64).toBeUndefined();
      }
      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'test-screenshot',
        fullPage: true,
        selector: undefined,
      });
    });

    it('captures viewport-only screenshot when fullPage is false', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64: 'mock-base64',
      });

      const result = await screenshotTool(
        {
          name: 'viewport-screenshot',
          fullPage: false,
        },
        context,
      );

      expect(result.ok).toBe(true);
      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'viewport-screenshot',
        fullPage: false,
        selector: undefined,
      });
    });
  });

  describe('with base64 encoding', () => {
    it('includes base64 when includeBase64 is true', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      });

      const result = await screenshotTool(
        {
          name: 'base64-screenshot',
          includeBase64: true,
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.base64).toBe(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        );
      }
    });

    it('excludes base64 when includeBase64 is false', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      });

      const result = await screenshotTool(
        {
          name: 'no-base64-screenshot',
          includeBase64: false,
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.base64).toBeUndefined();
      }
    });
  });

  describe('with selector scoping', () => {
    it('captures screenshot of specific element', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/element-screenshot.png',
        width: 400,
        height: 200,
        base64: 'mock-base64',
      });

      const result = await screenshotTool(
        {
          name: 'element-screenshot',
          selector: '[data-testid="account-menu"]',
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.width).toBe(400);
        expect(result.result.height).toBe(200);
      }
      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'element-screenshot',
        fullPage: true,
        selector: '[data-testid="account-menu"]',
      });
    });

    it('combines selector with fullPage false', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockResolvedValue({
        path: '/path/to/element-screenshot.png',
        width: 400,
        height: 200,
        base64: 'mock-base64',
      });

      const result = await screenshotTool(
        {
          name: 'element-viewport-screenshot',
          selector: '.modal-content',
          fullPage: false,
        },
        context,
      );

      expect(result.ok).toBe(true);
      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'element-viewport-screenshot',
        fullPage: false,
        selector: '.modal-content',
      });
    });
  });

  describe('error handling', () => {
    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await screenshotTool({ name: 'test-screenshot' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('returns error when screenshot fails', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockRejectedValue(
        new Error('Screenshot failed'),
      );

      const result = await screenshotTool({ name: 'test-screenshot' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SCREENSHOT_FAILED);
        expect(result.error.message).toContain('Screenshot failed');
      }
    });

    it('returns error when page is closed', async () => {
      const context = createMockContext();

      vi.spyOn(context.sessionManager, 'screenshot').mockRejectedValue(
        new Error('Target page, context or browser has been closed'),
      );

      const result = await screenshotTool({ name: 'test-screenshot' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
      }
    });
  });
});
