import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  setToolRegistry,
  getToolRegistry,
  hasToolRegistry,
  setToolValidator,
  getToolValidator,
  handleRunSteps,
} from './batch.js';
import type { ToolRegistry, ToolHandler, ToolValidator } from './batch.js';
import { setSessionManager } from '../session-manager.js';
import type { ISessionManager } from '../session-manager.js';

/**
 * Creates a mock session manager for testing.
 *
 * @param hasActive Whether the mock session should be active
 * @returns Mock session manager instance
 */
const createMockSessionManager = (
  hasActive: boolean = true,
): ISessionManager => ({
  hasActiveSession: vi.fn().mockReturnValue(hasActive),
  getSessionId: vi.fn().mockReturnValue(hasActive ? 'test-session' : undefined),
  getSessionState: vi.fn().mockReturnValue(undefined),
  getSessionMetadata: vi.fn().mockReturnValue(undefined),
  launch: vi.fn().mockResolvedValue({
    sessionId: 'test-session',
    extensionId: 'ext-123',
    state: {},
  }),
  cleanup: vi.fn().mockResolvedValue(true),
  getPage: vi.fn(),
  setActivePage: vi.fn(),
  getTrackedPages: vi.fn().mockReturnValue([]),
  classifyPageRole: vi.fn().mockReturnValue('extension'),
  getContext: vi.fn(),
  getExtensionState: vi.fn().mockResolvedValue({ screen: 'home' }),
  setRefMap: vi.fn(),
  getRefMap: vi.fn().mockReturnValue(new Map()),
  clearRefMap: vi.fn(),
  resolveA11yRef: vi.fn(),
  navigateToHome: vi.fn().mockResolvedValue(undefined),
  navigateToSettings: vi.fn().mockResolvedValue(undefined),
  navigateToUrl: vi.fn(),
  navigateToNotification: vi.fn(),
  waitForNotificationPage: vi.fn(),
  screenshot: vi.fn().mockResolvedValue({ path: '/path/to/screenshot.png' }),
  getBuildCapability: vi.fn().mockReturnValue(undefined),
  getFixtureCapability: vi.fn().mockReturnValue(undefined),
  getChainCapability: vi.fn().mockReturnValue(undefined),
  getContractSeedingCapability: vi.fn().mockReturnValue(undefined),
  getStateSnapshotCapability: vi.fn().mockReturnValue(undefined),
  getEnvironmentMode: vi.fn().mockReturnValue('e2e'),
});

/**
 * Clears the tool validator by resetting it to undefined.
 */
function clearToolValidator(): void {
  setToolValidator((() => ({ success: true })) as ToolValidator);
  setToolValidator(undefined as unknown as ToolValidator);
}

describe('batch', () => {
  beforeEach(() => {
    setToolRegistry({});
    clearToolValidator();
  });

  describe('setToolRegistry / getToolRegistry', () => {
    it('sets and gets tool registry', () => {
      const mockHandler: ToolHandler = vi.fn().mockResolvedValue({ ok: true });
      const registry: ToolRegistry = {
        mm_click: mockHandler,
      };

      setToolRegistry(registry);

      expect(getToolRegistry()).toBe(registry);
      expect(getToolRegistry().mm_click).toBe(mockHandler);
    });

    it('replaces existing registry', () => {
      const registry1: ToolRegistry = { tool1: vi.fn() };
      const registry2: ToolRegistry = { tool2: vi.fn() };

      setToolRegistry(registry1);
      setToolRegistry(registry2);

      expect(getToolRegistry()).toBe(registry2);
      expect(getToolRegistry().tool1).toBeUndefined();
      expect(getToolRegistry().tool2).toBeDefined();
    });
  });

  describe('hasToolRegistry', () => {
    it('returns false for empty registry', () => {
      setToolRegistry({});
      expect(hasToolRegistry()).toBe(false);
    });

    it('returns true when registry has handlers', () => {
      setToolRegistry({ mm_click: vi.fn() });
      expect(hasToolRegistry()).toBe(true);
    });
  });

  describe('setToolValidator / getToolValidator', () => {
    it('sets and gets tool validator', () => {
      const validator: ToolValidator = vi
        .fn()
        .mockReturnValue({ success: true });
      setToolValidator(validator);

      expect(getToolValidator()).toBe(validator);
    });

    it('returns undefined when not set', () => {
      expect(getToolValidator()).toBeUndefined();
    });
  });

  describe('handleRunSteps', () => {
    beforeEach(() => {
      setSessionManager(createMockSessionManager(true));
    });

    it('returns error when no active session', async () => {
      setSessionManager(createMockSessionManager(false));

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: { testId: 'button' } }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.code).toBe('MM_NO_ACTIVE_SESSION');
      }
    });

    it('executes steps in sequence', async () => {
      const executionOrder: string[] = [];
      const clickHandler = vi.fn().mockImplementation(async () => {
        executionOrder.push('click');
        return { ok: true, result: 'clicked' };
      });
      const typeHandler = vi.fn().mockImplementation(async () => {
        executionOrder.push('type');
        return { ok: true, result: 'typed' };
      });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: 'mm_click', args: { testId: 'button' } },
          { tool: 'mm_type', args: { testId: 'input', text: 'hello' } },
        ],
      });

      expect(result.ok).toBe(true);
      expect(executionOrder).toStrictEqual(['click', 'type']);
      if (result.ok) {
        expect(result.result?.summary.total).toBe(2);
        expect(result.result?.summary.succeeded).toBe(2);
        expect(result.result?.summary.failed).toBe(0);
      }
    });

    it('returns error for unknown tool', async () => {
      setToolRegistry({});

      const result = await handleRunSteps({
        steps: [{ tool: 'unknown_tool', args: {} }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_UNKNOWN_TOOL');
        expect(result.result?.summary.failed).toBe(1);
      }
    });

    it('stops on error when stopOnError is true', async () => {
      const clickHandler = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'ERR', message: 'fail' },
      });
      const typeHandler = vi.fn().mockResolvedValue({ ok: true });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: 'mm_click', args: {} },
          { tool: 'mm_type', args: { text: 'hello' } },
        ],
        stopOnError: true,
      });

      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(typeHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps.length).toBe(1);
      }
    });

    it('continues on error when stopOnError is false', async () => {
      const clickHandler = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'ERR', message: 'fail' },
      });
      const typeHandler = vi
        .fn()
        .mockResolvedValue({ ok: true, result: 'typed' });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: 'mm_click', args: {} },
          { tool: 'mm_type', args: { text: 'hello' } },
        ],
        stopOnError: false,
      });

      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(typeHandler).toHaveBeenCalledTimes(1);
      if (result.ok) {
        expect(result.result?.steps.length).toBe(2);
        expect(result.result?.summary.failed).toBe(1);
        expect(result.result?.summary.succeeded).toBe(1);
      }
    });

    it('uses tool validator when set', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const validator: ToolValidator = vi.fn().mockReturnValue({
        success: false,
        error: { message: 'Invalid testId' },
      });
      setToolValidator(validator);

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: { testId: '' } }],
      });

      expect(validator).toHaveBeenCalledWith('mm_click', { testId: '' });
      expect(clickHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_INVALID_INPUT');
      }
    });

    it('passes validation when validator returns success', async () => {
      const clickHandler = vi
        .fn()
        .mockResolvedValue({ ok: true, result: 'clicked' });
      setToolRegistry({ mm_click: clickHandler });

      const validator: ToolValidator = vi
        .fn()
        .mockReturnValue({ success: true });
      setToolValidator(validator);

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: { testId: 'btn' } }],
      });

      expect(clickHandler).toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(true);
      }
    });

    it('handles exceptions from tool handlers', async () => {
      const clickHandler = vi.fn().mockRejectedValue(new Error('Timeout'));
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: {} }],
      });

      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_INTERNAL_ERROR');
        expect(result.result?.steps[0].error?.message).toContain('Timeout');
      }
    });

    it('includes duration in step results', async () => {
      const clickHandler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: {} }],
      });

      if (result.ok) {
        expect(result.result?.steps[0].meta?.durationMs).toBeGreaterThanOrEqual(
          10,
        );
      }
    });

    it('includes total duration in summary', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [
          { tool: 'mm_click', args: {} },
          { tool: 'mm_click', args: {} },
        ],
      });

      if (result.ok) {
        expect(result.result?.summary.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('defaults args to empty object when not provided', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      await handleRunSteps({
        steps: [{ tool: 'mm_click' }],
      });

      expect(clickHandler).toHaveBeenCalledWith({}, expect.any(Object));
    });
  });
});
