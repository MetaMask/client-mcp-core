/**
 * Unit tests for interaction tool handlers.
 *
 * Tests handleClick, handleType, and handleWaitFor with various target types,
 * error scenarios, and page closure detection.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { clickTool, typeTool, waitForTool } from './interaction.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import * as discoveryModule from './utils/discovery.js';
import * as targetsModule from './utils/targets.js';
import type { ToolContext } from '../types/http.js';

function createMockLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(
  options: {
    hasActive?: boolean;
    page?: object;
    refMap?: Map<string, string>;
  } = {},
): ToolContext {
  return {
    sessionManager: createMockSessionManager({
      hasActive: options.hasActive ?? true,
    }),
    page: (options.page ?? {}) as ToolContext['page'],
    refMap: options.refMap ?? new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('interaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clickTool', () => {
    it('clicks element by testId', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ testId: 'my-button' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.clicked).toBe(true);
        expect(result.result.target).toBe('testId:my-button');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'my-button',
        context.refMap,
        15000,
      );
      expect(locator.click).toHaveBeenCalled();
    });

    it('uses custom timeout when provided', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      await clickTool({ testId: 'my-button', timeoutMs: 5000 }, context);

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'my-button',
        context.refMap,
        5000,
      );
    });

    it('clicks element by CSS selector', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ selector: 'button.primary' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.clicked).toBe(true);
        expect(result.result.target).toBe('selector:button.primary');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'selector',
        'button.primary',
        context.refMap,
        15000,
      );
    });

    it('clicks element by accessibility reference', async () => {
      const page = {};
      const locator = createMockLocator();
      const refMap = new Map([['e5', 'button[aria-label="Submit"]']]);
      const context = createMockContext({ page, refMap });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ a11yRef: 'e5' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.clicked).toBe(true);
        expect(result.result.target).toBe('a11yRef:e5');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'a11yRef',
        'e5',
        refMap,
        15000,
      );
    });

    it('returns error when no target specified', async () => {
      const result = await clickTool({} as any, createMockContext());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when multiple targets specified', async () => {
      const result = await clickTool(
        { testId: 'button', selector: '.button' } as any,
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when validation result is invalid but not caught by isInvalidTargetSelection', async () => {
      vi.spyOn(targetsModule, 'validateTargetSelection').mockReturnValue({
        valid: true,
      } as any);

      const result = await clickTool({ testId: 'button' }, createMockContext());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toBe('Invalid target selection');
      }
    });

    it('handles page closure gracefully', async () => {
      const locator = createMockLocator();
      locator.click.mockRejectedValue(
        new Error('Target page, context or browser has been closed'),
      );
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ testId: 'close-btn' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.clicked).toBe(true);
        expect(result.result.pageClosedAfterClick).toBe(true);
        expect(result.result.target).toBe('testId:close-btn');
      }
    });

    it('handles browser closed error gracefully', async () => {
      const locator = createMockLocator();
      locator.click.mockRejectedValue(new Error('browser has been closed'));
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ testId: 'close-btn' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.pageClosedAfterClick).toBe(true);
      }
    });

    it('returns error when click fails with non-closure error', async () => {
      const locator = createMockLocator();
      locator.click.mockRejectedValue(new Error('Element is not clickable'));
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await clickTool({ testId: 'my-button' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CLICK_FAILED);
      }
    });

    it('returns error when element not found', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout waiting for element'),
      );

      const result = await clickTool({ testId: 'nonexistent' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      }
    });

    it('returns error when no session active', async () => {
      const result = await clickTool(
        { testId: 'my-button' },
        createMockContext({ hasActive: false }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('typeTool', () => {
    it('types text into element by testId', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await typeTool(
        { testId: 'amount-input', text: '0.5' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.typed).toBe(true);
        expect(result.result.target).toBe('testId:amount-input');
        expect(result.result.textLength).toBe(3);
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'amount-input',
        context.refMap,
        15000,
      );
      expect(locator.fill).toHaveBeenCalledWith('0.5');
    });

    it('uses custom timeout when provided', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      await typeTool(
        { testId: 'input', text: 'test', timeoutMs: 3000 },
        context,
      );

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'input',
        context.refMap,
        3000,
      );
    });

    it('types text into element by CSS selector', async () => {
      const locator = createMockLocator();
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await typeTool(
        { selector: 'input[name="email"]', text: 'test@example.com' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.typed).toBe(true);
        expect(result.result.target).toBe('selector:input[name="email"]');
        expect(result.result.textLength).toBe(16);
      }
      expect(locator.fill).toHaveBeenCalledWith('test@example.com');
    });

    it('types text into element by accessibility reference', async () => {
      const page = {};
      const locator = createMockLocator();
      const refMap = new Map([['e3', 'input[aria-label="Amount"]']]);
      const context = createMockContext({ page, refMap });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await typeTool({ a11yRef: 'e3', text: '100' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.typed).toBe(true);
        expect(result.result.target).toBe('a11yRef:e3');
        expect(result.result.textLength).toBe(3);
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'a11yRef',
        'e3',
        refMap,
        15000,
      );
    });

    it('types empty string and reports zero length', async () => {
      const locator = createMockLocator();
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await typeTool({ testId: 'input', text: '' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.typed).toBe(true);
        expect(result.result.textLength).toBe(0);
      }
      expect(locator.fill).toHaveBeenCalledWith('');
    });

    it('returns error when no target specified', async () => {
      const result = await typeTool(
        { text: 'test' } as any,
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when multiple targets specified', async () => {
      const result = await typeTool(
        { testId: 'input', selector: 'input', text: 'test' } as any,
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when validation result is invalid but not caught by isInvalidTargetSelection', async () => {
      vi.spyOn(targetsModule, 'validateTargetSelection').mockReturnValue({
        valid: true,
      } as any);

      const result = await typeTool(
        { testId: 'input', text: 'test' },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toBe('Invalid target selection');
      }
    });

    it('returns error when fill fails', async () => {
      const locator = createMockLocator();
      locator.fill.mockRejectedValue(new Error('Element is not editable'));
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await typeTool({ testId: 'input', text: 'test' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TYPE_FAILED);
      }
    });

    it('returns error when element not found', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout waiting for element'),
      );

      const result = await typeTool(
        { testId: 'nonexistent', text: 'test' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      }
    });

    it('returns error when no session active', async () => {
      const result = await typeTool(
        { testId: 'input', text: 'test' },
        createMockContext({ hasActive: false }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('waitForTool', () => {
    it('waits for element by testId', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await waitForTool({ testId: 'loading-spinner' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.found).toBe(true);
        expect(result.result.target).toBe('testId:loading-spinner');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'loading-spinner',
        context.refMap,
        15000,
      );
    });

    it('uses custom timeout when provided', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      await waitForTool({ testId: 'element', timeoutMs: 30000 }, context);

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'element',
        context.refMap,
        30000,
      );
    });

    it('waits for element by CSS selector', async () => {
      const page = {};
      const locator = createMockLocator();
      const context = createMockContext({ page });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await waitForTool(
        { selector: '.success-message' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.found).toBe(true);
        expect(result.result.target).toBe('selector:.success-message');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'selector',
        '.success-message',
        context.refMap,
        15000,
      );
    });

    it('waits for element by accessibility reference', async () => {
      const page = {};
      const locator = createMockLocator();
      const refMap = new Map([['e10', 'button[aria-label="Confirm"]']]);
      const context = createMockContext({ page, refMap });

      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const result = await waitForTool({ a11yRef: 'e10' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.found).toBe(true);
        expect(result.result.target).toBe('a11yRef:e10');
      }
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'a11yRef',
        'e10',
        refMap,
        15000,
      );
    });

    it('returns error when no target specified', async () => {
      const result = await waitForTool({} as any, createMockContext());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when multiple targets specified', async () => {
      const result = await waitForTool(
        { testId: 'element', selector: '.element' } as any,
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Exactly one');
      }
    });

    it('returns error when validation result is invalid but not caught by isInvalidTargetSelection', async () => {
      vi.spyOn(targetsModule, 'validateTargetSelection').mockReturnValue({
        valid: true,
      } as any);

      const result = await waitForTool(
        { testId: 'element' },
        createMockContext(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toBe('Invalid target selection');
      }
    });

    it('returns error when element not found within timeout', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout 15000ms exceeded'),
      );

      const result = await waitForTool({ testId: 'nonexistent' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      }
    });

    it('returns error when page closed during wait', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Target page has been closed'),
      );

      const result = await waitForTool({ testId: 'element' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      }
    });

    it('returns error when no session active', async () => {
      const result = await waitForTool(
        { testId: 'element' },
        createMockContext({ hasActive: false }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });
});
