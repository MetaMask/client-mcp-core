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
import { createMockSessionManager } from '../test-utils/mock-factories.js';

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
      setSessionManager(createMockSessionManager({ hasActive: true }));
    });

    it('returns error when no active session', async () => {
      setSessionManager(createMockSessionManager({ hasActive: false }));

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

    it('maps includeObservations "none" to observation policy', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: {} }],
        includeObservations: 'none',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(true);
      }
      expect(clickHandler).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ observationPolicy: 'none' }),
      );
    });

    it('maps includeObservations "failures" to observation policy', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: 'mm_click', args: {} }],
        includeObservations: 'failures',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(true);
      }
      expect(clickHandler).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ observationPolicy: 'failures' }),
      );
    });

    it('stops execution when stopOnError=true and handler not found', async () => {
      const typeHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_type: typeHandler });

      const result = await handleRunSteps({
        steps: [
          { tool: 'unknown_tool', args: {} },
          { tool: 'mm_type', args: { text: 'hello' } },
        ],
        stopOnError: true,
      });

      expect(typeHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps.length).toBe(1);
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_UNKNOWN_TOOL');
      }
    });

    it('stops execution when stopOnError=true and validation fails', async () => {
      const clickHandler = vi.fn().mockResolvedValue({ ok: true });
      const typeHandler = vi.fn().mockResolvedValue({ ok: true });
      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const validator: ToolValidator = vi.fn().mockImplementation((tool) => {
        if (tool === 'mm_click') {
          return { success: false, error: { message: 'Invalid testId' } };
        }
        return { success: true };
      });
      setToolValidator(validator);

      const result = await handleRunSteps({
        steps: [
          { tool: 'mm_click', args: { testId: '' } },
          { tool: 'mm_type', args: { text: 'hello' } },
        ],
        stopOnError: true,
      });

      expect(clickHandler).not.toHaveBeenCalled();
      expect(typeHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps.length).toBe(1);
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_INVALID_INPUT');
      }
    });

    it('stops execution when stopOnError=true and handler throws error', async () => {
      const clickHandler = vi.fn().mockRejectedValue(new Error('Timeout'));
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
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe('MM_INTERNAL_ERROR');
      }
    });
  });
});
