import { describe, it, expect, vi } from 'vitest';

import { runStepsTool } from './batch.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext, ToolFunction } from '../types/http.js';
import { TARGET_TOOL_NAMES } from '../validation/schemas.js';

function createMockContext(
  options: {
    hasActive?: boolean;
    toolRegistry?: Map<string, ToolFunction<any, any>>;
    driverPlatform?: 'browser' | 'ios' | 'android';
  } = {},
): ToolContext {
  const { hasActive = true, toolRegistry, driverPlatform } = options;

  const driver = driverPlatform
    ? ({ getPlatform: () => driverPlatform } as ToolContext['driver'])
    : undefined;

  return {
    sessionManager: createMockSessionManager({ hasActive }),
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {},
    toolRegistry,
    driver,
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

    expect(clickHandler).toHaveBeenCalledWith({ testId: 'button' }, context);
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

  it('normalises a bare ref arg to a11yRef before dispatch', async () => {
    const clickHandler = vi.fn().mockResolvedValue({ ok: true, result: 'ok' });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'click', args: { ref: 'e1' } }] },
      context,
    );

    expect(clickHandler).toHaveBeenCalledWith({ a11yRef: 'e1' }, context);
    expect(result.ok).toBe(true);
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

    expect(clickHandler).toHaveBeenCalledWith({ testId: 'btn' }, context);
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

  it('accepts observe in step args and does not pass it to the handler', async () => {
    const clickHandler = vi.fn().mockResolvedValue({
      ok: true,
      result: { clicked: true },
    });
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      {
        steps: [{ tool: 'click', args: { testId: 'btn', observe: 'full' } }],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
      expect(result.result.steps[0]).not.toHaveProperty('observation');
    }
    expect(clickHandler).toHaveBeenCalledWith(
      expect.not.objectContaining({ observe: expect.anything() }),
      context,
    );
    expect(clickHandler.mock.calls[0][0]).toMatchObject({ testId: 'btn' });
  });

  it('rejects an invalid observe level in step args', async () => {
    const clickHandler = vi.fn();
    const context = createMockContext({
      toolRegistry: new Map([['click', clickHandler]]),
    });

    const result = await runStepsTool(
      {
        steps: [{ tool: 'click', args: { testId: 'btn', observe: 'all' } }],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].error?.code).toBe('VALIDATION_ERROR');
    }
    expect(clickHandler).not.toHaveBeenCalled();
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

  describe('ref shorthand for every target tool', () => {
    // Per-tool step config for the shorthand tests: required extras and a
    // platform the tool is allowed on (inspect and hover are browser-only,
    // long_press is mobile-only, scroll_to_element's `within` is
    // browser-only). Tools without an entry need neither.
    const STEP_CONFIG: Record<
      string,
      {
        platform?: 'browser' | 'ios' | 'android';
        args?: Record<string, unknown>;
        withinPlatform?: 'browser' | 'ios' | 'android';
      }
    > = {
      type: { args: { text: 'hello' } },
      inspect: { platform: 'browser' },
      hover: { platform: 'browser' },
      scroll_to_element: { platform: 'android', withinPlatform: 'browser' },
      long_press: { platform: 'ios', args: { durationMs: 750 } },
    };

    it.each(TARGET_TOOL_NAMES)(
      'normalises a ref step arg to a11yRef for %s',
      async (tool) => {
        const config = STEP_CONFIG[tool] ?? {};
        const handler = vi.fn().mockResolvedValue({ ok: true, result: 'ok' });
        const context = createMockContext({
          toolRegistry: new Map([[tool, handler]]),
          ...(config.platform ? { driverPlatform: config.platform } : {}),
        });

        const result = await runStepsTool(
          {
            steps: [{ tool, args: { ref: 'e1', ...config.args } }],
          },
          context,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.summary).toMatchObject({
            ok: true,
            total: 1,
            succeeded: 1,
            failed: 0,
          });
        }
        expect(handler).toHaveBeenCalledTimes(1);
        const received = handler.mock.calls[0][0] as Record<string, unknown>;
        expect(received).not.toHaveProperty('ref');
        expect(received.a11yRef).toBe('e1');
      },
    );

    // Every target tool except long_press, whose schema has no `within`.
    it.each(TARGET_TOOL_NAMES.filter((tool) => tool !== 'long_press'))(
      'normalises a within.ref step arg to within.a11yRef for %s',
      async (tool) => {
        const config = STEP_CONFIG[tool] ?? {};
        const handler = vi.fn().mockResolvedValue({ ok: true, result: 'ok' });
        const platform = config.withinPlatform ?? config.platform;
        const context = createMockContext({
          toolRegistry: new Map([[tool, handler]]),
          ...(platform ? { driverPlatform: platform } : {}),
        });

        const result = await runStepsTool(
          {
            steps: [
              {
                tool,
                args: { testId: 'btn', within: { ref: 'e2' }, ...config.args },
              },
            ],
          },
          context,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.summary).toMatchObject({
            ok: true,
            total: 1,
            succeeded: 1,
            failed: 0,
          });
        }
        expect(handler).toHaveBeenCalledTimes(1);
        const received = handler.mock.calls[0][0] as Record<string, unknown>;
        expect(received.within).toStrictEqual({ a11yRef: 'e2' });
      },
    );
  });

  describe('frame with the ref shorthand', () => {
    it.each(['get_text', 'inspect', 'hover'] as const)(
      'keeps frame steps of %s working with the ref shorthand',
      async (tool) => {
        const handler = vi.fn().mockResolvedValue({ ok: true, result: 'ok' });
        const context = createMockContext({
          toolRegistry: new Map([[tool, handler]]),
          driverPlatform: 'browser',
        });

        const result = await runStepsTool(
          {
            steps: [
              // A ref from a frame snapshot already points into its frame.
              { tool, args: { ref: 'f1e3' } },
              // A frame scope goes with a testId or selector target; the
              // frame object itself has no ref shorthand.
              {
                tool,
                args: { testId: 'zoom-in', frame: { testId: 'chart-iframe' } },
              },
            ],
          },
          context,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.summary).toMatchObject({
            ok: true,
            total: 2,
            succeeded: 2,
            failed: 0,
          });
        }
        const first = handler.mock.calls[0][0] as Record<string, unknown>;
        expect(first).not.toHaveProperty('ref');
        expect(first.a11yRef).toBe('f1e3');
        const second = handler.mock.calls[1][0] as Record<string, unknown>;
        expect(second.testId).toBe('zoom-in');
        expect(second.frame).toStrictEqual({ testId: 'chart-iframe' });
      },
    );

    it('passes a ref combined with frame through for the driver to reject', async () => {
      // scopeTargetToFrame (browser driver) rejects frame combined with a
      // ref target: a snapshot ref already points into its frame. run_steps
      // keeps converting the ref and leaves frame untouched, so the driver,
      // not the batch layer, does the rejecting.
      const hoverHandler = vi
        .fn()
        .mockResolvedValue({ ok: true, result: 'ok' });
      const context = createMockContext({
        toolRegistry: new Map([['hover', hoverHandler]]),
        driverPlatform: 'browser',
      });

      const result = await runStepsTool(
        {
          steps: [
            {
              tool: 'hover',
              args: { ref: 'e1', frame: { testId: 'chart-iframe' } },
            },
          ],
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.summary).toMatchObject({
          ok: true,
          total: 1,
          succeeded: 1,
          failed: 0,
        });
      }
      const received = hoverHandler.mock.calls[0][0] as Record<string, unknown>;
      expect(received.a11yRef).toBe('e1');
      expect(received.frame).toStrictEqual({ testId: 'chart-iframe' });
    });
  });

  it('rejects browser-only tools on non-browser platforms', async () => {
    const navigateHandler = vi.fn();
    const clickHandler = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const context = createMockContext({
      toolRegistry: new Map([
        ['navigate', navigateHandler],
        ['click', clickHandler],
      ]),
      driverPlatform: 'ios',
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'navigate', args: { screen: 'home' } },
          { tool: 'click', args: { testId: 'btn' } },
        ],
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(2);
      expect(result.result.steps[0].ok).toBe(false);
      expect(result.result.steps[0].error?.code).toBe(
        'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      );
      expect(navigateHandler).not.toHaveBeenCalled();
      expect(result.result.steps[1].ok).toBe(true);
      expect(clickHandler).toHaveBeenCalled();
    }
  });

  it('halts on a browser-only platform mismatch when stopOnError is set', async () => {
    const navigateHandler = vi.fn();
    const clickHandler = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const context = createMockContext({
      toolRegistry: new Map([
        ['navigate', navigateHandler],
        ['click', clickHandler],
      ]),
      driverPlatform: 'android',
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'navigate', args: { screen: 'home' } },
          { tool: 'click', args: { testId: 'btn' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0].error?.code).toBe(
        'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      );
      expect(navigateHandler).not.toHaveBeenCalled();
      expect(clickHandler).not.toHaveBeenCalled();
    }
  });

  it('allows browser-only tools on browser platform', async () => {
    const navigateHandler = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const context = createMockContext({
      toolRegistry: new Map([['navigate', navigateHandler]]),
      driverPlatform: 'browser',
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'navigate', args: { screen: 'home' } }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
      expect(navigateHandler).toHaveBeenCalled();
    }
  });

  it('rejects mobile-only tools on browser platform', async () => {
    const hermesTargetsHandler = vi.fn();
    const context = createMockContext({
      toolRegistry: new Map([['hermes_targets', hermesTargetsHandler]]),
      driverPlatform: 'browser',
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'hermes_targets', args: {} }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(false);
      expect(result.result.steps[0].error?.code).toBe(
        'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      );
      expect(hermesTargetsHandler).not.toHaveBeenCalled();
    }
  });

  it('rejects mobile-only tools when no driver is present', async () => {
    const hermesTargetsHandler = vi.fn();
    const context = createMockContext({
      toolRegistry: new Map([['hermes_targets', hermesTargetsHandler]]),
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'hermes_targets', args: {} }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(false);
      expect(result.result.steps[0].error?.code).toBe(
        'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      );
      expect(hermesTargetsHandler).not.toHaveBeenCalled();
    }
  });

  it('halts on a mobile-only platform mismatch when stopOnError is set', async () => {
    const hermesTargetsHandler = vi.fn();
    const clickHandler = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const context = createMockContext({
      toolRegistry: new Map([
        ['hermes_targets', hermesTargetsHandler],
        ['click', clickHandler],
      ]),
      driverPlatform: 'browser',
    });

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'hermes_targets', args: {} },
          { tool: 'click', args: { testId: 'btn' } },
        ],
        stopOnError: true,
      },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps).toHaveLength(1);
      expect(result.result.steps[0].error?.code).toBe(
        'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      );
      expect(clickHandler).not.toHaveBeenCalled();
    }
  });

  it('allows mobile-only tools on a mobile platform', async () => {
    const hermesTargetsHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, result: {} });
    const context = createMockContext({
      toolRegistry: new Map([['hermes_targets', hermesTargetsHandler]]),
      driverPlatform: 'ios',
    });

    const result = await runStepsTool(
      { steps: [{ tool: 'hermes_targets', args: {} }] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.steps[0].ok).toBe(true);
      expect(hermesTargetsHandler).toHaveBeenCalled();
    }
  });

  it('stops before the next step when the request is aborted', async () => {
    const controller = new AbortController();
    const clickHandler = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { ok: true, result: 'clicked' };
    });
    const context = {
      ...createMockContext({
        toolRegistry: new Map([['click', clickHandler]]),
      }),
      signal: controller.signal,
    } as ToolContext;

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'click', args: { testId: 'a' } },
          { tool: 'click', args: { testId: 'b' } },
        ],
      },
      context,
    );

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_REQUEST_ABORTED);
    }
  });
});
