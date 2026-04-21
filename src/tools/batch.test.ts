import { describe, it, expect, vi } from 'vitest';

import { runStepsTool } from './batch.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext, ToolFunction } from '../types/http.js';

function createMockContext(
  options: {
    hasActive?: boolean;
    toolRegistry?: Map<string, ToolFunction<any, any>>;
  } = {},
): ToolContext {
  const { hasActive = true, toolRegistry } = options;

  return {
    sessionManager: createMockSessionManager({ hasActive }),
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
    toolRegistry,
  } as unknown as ToolContext;
}

describe('runStepsTool', () => {
  it('returns error when no active session', async () => {
    const context = createMockContext({ hasActive: false });

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { testId: 'button' } }] },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns internal error when tool registry is missing', async () => {
    const context = createMockContext();

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { testId: 'button' } }] },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INTERNAL_ERROR);
      expect(result.error.message).toContain('Tool registry not available');
    }
  });

  it('executes a single step successfully', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'clicked',
    });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { testId: 'button' } }] },
      context,
    );

    expect(clickHandler).toHaveBeenCalledWith(
      { testId: 'button', timeoutMs: 15000 },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: true,
        result: 'clicked',
      });
      expect(result.result.steps[0].meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.result.steps[0].meta.timestamp).toStrictEqual(
        expect.any(String),
      );
      expect(result.result.summary).toMatchObject({
        ok: true,
        total: 1,
        succeeded: 1,
        failed: 0,
      });
    }
  });

  it('returns unknown tool error in the step result', async () => {
    const context = createMockContext({ toolRegistry: new Map() });

    const result = await runStepsTool(
      { steps: [{ tool: 'unknown_tool', args: {} }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0]).toMatchObject({
        tool: 'unknown_tool',
        ok: false,
        error: {
          code: ErrorCodes.MM_UNKNOWN_TOOL,
          message: 'Unknown tool: unknown_tool',
        },
      });
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('records a failed step when a handler returns ok false', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'MM_CLICK_FAILED', message: 'Click failed' },
    });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { testId: 'btn' } }] },
      context,
    );

    expect(clickHandler).toHaveBeenCalledWith(
      { testId: 'btn', timeoutMs: 15000 },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: false,
        error: { code: 'MM_CLICK_FAILED', message: 'Click failed' },
      });
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('stops on error when stopOnError is true', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'ERR', message: 'fail' },
    });
    const typeHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: 'typed' });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: { testId: 'btn' } },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(typeHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('collects multiple step results with mixed outcomes', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'clicked',
    });
    const typeHandler = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'MM_TYPE_FAILED', message: 'Type failed' },
    });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: { testId: 'button' } },
          { tool: 'unknown_tool', args: {} },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
      },
      context,
    );

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(typeHandler).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(3);
      expect(result.result.steps.map((step) => step.ok)).toStrictEqual([
        true,
        false,
        false,
      ]);
      expect(result.result.steps[1].error?.code).toBe(
        ErrorCodes.MM_UNKNOWN_TOOL,
      );
      expect(result.result.steps[2].error?.code).toBe('MM_TYPE_FAILED');
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 3,
        succeeded: 1,
        failed: 2,
      });
      expect(result.result.summary.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('records internal error when a handler throws', async () => {
    const clickHandler = vi.fn().mockRejectedValue(new Error('Timeout'));
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { testId: 'btn' } }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: false,
        error: {
          code: ErrorCodes.MM_INTERNAL_ERROR,
        },
      });
      expect(result.result.steps[0].error?.message).toContain('Timeout');
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('stops on error for unknown tool when stopOnError is true', async () => {
    const typeHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: 'typed' });
    const context = createMockContext({
      toolRegistry: new Map([['type', typeHandler]]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'unknown_tool', args: {} },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(typeHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0]).toMatchObject({
        tool: 'unknown_tool',
        ok: false,
        error: {
          code: ErrorCodes.MM_UNKNOWN_TOOL,
        },
      });
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('returns validation error for invalid tool args', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'clicked',
    });
    const typeHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: 'typed' });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: {} },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
      },
      context,
    );

    expect(clickHandler).not.toHaveBeenCalled();
    expect(typeHandler).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(2);
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
        },
      });
      expect(result.result.steps[0].error?.message).toContain('Exactly one of');
      expect(result.result.steps[1]).toMatchObject({
        tool: 'type',
        ok: true,
      });
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 2,
        succeeded: 1,
        failed: 1,
      });
    }
  });

  it('stops on validation error when stopOnError is true', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'clicked',
    });
    const typeHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: 'typed' });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: {} },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(clickHandler).not.toHaveBeenCalled();
    expect(typeHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
        },
      });
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('stops on handler throw when stopOnError is true', async () => {
    const clickHandler = vi.fn().mockRejectedValue(new Error('Timeout'));
    const typeHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: 'typed' });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: { testId: 'btn' } },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(typeHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0]).toMatchObject({
        tool: 'click',
        ok: false,
        error: {
          code: ErrorCodes.MM_INTERNAL_ERROR,
        },
      });
      expect(result.result.steps[0].error?.message).toContain('Timeout');
      expect(result.result.summary).toMatchObject({
        ok: false,
        total: 1,
        succeeded: 0,
        failed: 1,
      });
    }
  });

  it('excludes observations when includeObservations is "none"', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: { clicked: true },
    });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      {
        steps: [{ tool: 'click', args: { testId: 'btn' } }],
        includeObservations: 'none',
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0]).not.toHaveProperty('observation');
    }
  });

  it('marks remaining steps as skipped when batchTimeoutMs is exceeded', async () => {
    const clickHandler = vi.fn().mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, result: 'clicked' }), 50);
        }),
    );
    const typeHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'typed',
    });
    const context = createMockContext({
      toolRegistry: new Map([
        ['click', clickHandler],
        ['type', typeHandler],
      ]),
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: { testId: 'btn' } },
          { tool: 'type', args: { testId: 'input', text: 'hello' } },
          { tool: 'click', args: { testId: 'submit' } },
        ],
        batchTimeoutMs: 1,
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(3);
      // First step may succeed or be skipped depending on timing
      // Steps after deadline should be skipped
      const skippedSteps = result.result.steps.filter(
        (step) => step.meta.skipped === true,
      );
      expect(skippedSteps.length).toBeGreaterThan(0);
      skippedSteps.forEach((step) => {
        expect(step.ok).toBe(false);
        expect(step.error?.code).toBe('MM_BATCH_TIMEOUT');
      });
      expect(result.result.summary.skipped).toBeGreaterThan(0);
    }
  });

  it('resolves navigate_home alias to navigate with screen: home', async () => {
    const navigateHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: { navigated: true },
    });
    const context = createMockContext({
      toolRegistry: new Map([['navigate', navigateHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'navigate_home' }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
    }
    expect(navigateHandler).toHaveBeenCalledWith({ screen: 'home' }, context);
  });

  it('resolves navigate-home (hyphenated) alias to navigate with screen: home', async () => {
    const navigateHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: { navigated: true },
    });
    const context = createMockContext({
      toolRegistry: new Map([['navigate', navigateHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'navigate-home' }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
    }
    expect(navigateHandler).toHaveBeenCalledWith({ screen: 'home' }, context);
  });

  it('resolves navigate_settings alias to navigate with screen: settings', async () => {
    const navigateHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: { navigated: true },
    });
    const context = createMockContext({
      toolRegistry: new Map([['navigate', navigateHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'navigate_settings' }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
    }
    expect(navigateHandler).toHaveBeenCalledWith(
      { screen: 'settings' },
      context,
    );
  });

  it('normalises within.ref to within.a11yRef in step args', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: 'clicked',
    });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      {
        steps: [
          {
            tool: 'click',
            args: { testId: 'btn', within: { ref: 'e1' } },
          },
        ],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(clickHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          testId: 'btn',
          within: { a11yRef: 'e1' },
        }),
        context,
      );
    }
  });
});
