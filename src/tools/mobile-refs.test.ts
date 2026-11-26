import type { DeviceBackend, UIElement } from '@metamask/device-mcp';
import { describe, it, expect, vi } from 'vitest';

import { runStepsTool } from './batch.js';
import { longPressTool, scrollToElementTool } from './device.js';
import {
  clickTool,
  getTextTool,
  typeTool,
  waitForTool,
} from './interaction.js';
import { toolRegistry } from './registry.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { CliExitCodes, ErrorCodes, exitCodeForError } from './types/errors.js';
import { MobilePlatformDriver } from '../platform/mobile-platform-driver.js';
import type { ToolContext } from '../types/http.js';

/**
 * Tools with the real mobile driver and a fake device: two buttons that share
 * a label (`e1`, `e2`, ambiguous) and an unnamed tap target (`e3`).
 *
 * @returns The fake device and the tool context, with the refs of a
 * snapshot.
 */
async function setUp(): Promise<{
  backend: DeviceBackend;
  context: ToolContext;
}> {
  const element = (overrides: Partial<UIElement>): UIElement => ({
    type: 'Button',
    frame: { x: 0, y: 0, width: 100, height: 40 },
    enabled: true,
    ...overrides,
  });
  const hierarchy = [
    element({
      type: 'UIView',
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        element({
          label: 'Earn',
          frame: { x: 0, y: 100, width: 100, height: 40 },
        }),
        element({
          label: 'Earn',
          frame: { x: 0, y: 300, width: 100, height: 40 },
        }),
        element({
          type: 'RCTViewComponentView',
          frame: { x: 200, y: 500, width: 48, height: 48 },
        }),
      ],
    }),
  ];
  const backend = {
    platform: 'ios',
    snapshot: vi.fn().mockResolvedValue({
      platform: 'ios',
      hierarchy,
      raw: '',
      timestamp: 0,
    }),
    waitForElement: vi.fn(),
    tapElement: vi.fn().mockResolvedValue({
      success: true,
      x: 0,
      y: 0,
      targetDescription: '',
    }),
    tapCoordinates: vi.fn(),
    typeText: vi.fn(),
    getElementText: vi.fn(),
    scrollToElement: vi.fn(),
    longPress: vi.fn(),
  } as unknown as DeviceBackend;
  const driver = new MobilePlatformDriver(backend);
  const { refMap } = await driver.getAccessibilityTree();
  vi.mocked(backend.snapshot).mockClear();
  const context = {
    sessionManager: createMockSessionManager({ hasActive: true, refMap }),
    refMap,
    workflowContext: {},
    toolRegistry,
    driver,
  } as unknown as ToolContext;
  return { backend, context };
}

describe('mobile refs that a query cannot resolve (#119, P1-46)', () => {
  it.each([
    [
      'type',
      async (c: ToolContext) => typeTool({ a11yRef: 'e2', text: 'x' }, c),
    ],
    ['wait-for', async (c: ToolContext) => waitForTool({ a11yRef: 'e2' }, c)],
    ['get-text', async (c: ToolContext) => getTextTool({ a11yRef: 'e2' }, c)],
    [
      'scroll-to-element',
      async (c: ToolContext) => scrollToElementTool({ a11yRef: 'e2' }, c),
    ],
    [
      'long-press',
      async (c: ToolContext) => longPressTool({ a11yRef: 'e2' }, c),
    ],
  ])(
    '%s refuses an ambiguous ref with exit 4 and a hint, before any device call',
    async (_tool, run) => {
      const { backend, context } = await setUp();

      const result = await run(context);

      expect(result).toStrictEqual({
        ok: false,
        error: {
          code: ErrorCodes.MM_TARGET_NOT_FOUND,
          message:
            'Ref e2 is ambiguous (2 elements on the screen have the same test ID, or the same label and type); only click can use it. Nothing was sent to the device.',
          hint: 'Target it by a unique `--testid`, or run `mm click e2`: it taps the listed element at its bounds.',
        },
      });
      expect(exitCodeForError(ErrorCodes.MM_TARGET_NOT_FOUND)).toBe(
        CliExitCodes.TARGET,
      );
      expect(backend.snapshot).not.toHaveBeenCalled();
      expect(backend.tapElement).not.toHaveBeenCalled();
      expect(backend.tapCoordinates).not.toHaveBeenCalled();
    },
  );

  it('click taps the listed element of an ambiguous ref by its bounds', async () => {
    const { backend, context } = await setUp();

    const result = await clickTool({ a11yRef: 'e2' }, context);

    expect(result).toStrictEqual({
      ok: true,
      result: { clicked: true, target: 'a11yRef:e2 (bounds)' },
    });
    expect(
      vi.mocked(backend.tapElement).mock.calls[0]?.[1]?.element?.frame.y,
    ).toBe(300);
  });

  it('click taps an unnamed ref by its bounds; type names click and tap-coordinates', async () => {
    const { context } = await setUp();

    expect(await clickTool({ a11yRef: 'e3' }, context)).toStrictEqual({
      ok: true,
      result: { clicked: true, target: 'a11yRef:e3 (bounds)' },
    });
    expect(await typeTool({ a11yRef: 'e3', text: 'x' }, context)).toStrictEqual(
      {
        ok: false,
        error: {
          code: ErrorCodes.MM_TARGET_NOT_FOUND,
          message:
            'Ref e3 has no test ID, label or value; only click can use it. Nothing was sent to the device.',
          hint: 'Run `mm click e3` (it taps the element at its bounds) or `mm tap-coordinates 224 524`.',
        },
      },
    );
  });

  it('run-steps applies the same rules to its steps', async () => {
    const { backend, context } = await setUp();

    const result = await runStepsTool(
      {
        steps: [
          { tool: 'get_text', args: { ref: 'e1' } },
          { tool: 'long_press', args: { ref: 'e3' } },
          { tool: 'click', args: { ref: 'e1' } },
        ],
      },
      context,
    );

    expect(result.ok).toBe(true);
    const steps = result.ok ? result.result.steps : [];
    expect(steps.map((step) => [step.ok, step.error?.code])).toStrictEqual([
      [false, ErrorCodes.MM_TARGET_NOT_FOUND],
      [false, ErrorCodes.MM_TARGET_NOT_FOUND],
      [true, undefined],
    ]);
    expect(steps[0]?.error?.hint).toContain('--testid');
    expect(steps[1]?.error?.hint).toContain('mm tap-coordinates 224 524');
    expect(steps[2]?.result).toStrictEqual({
      clicked: true,
      target: 'a11yRef:e1 (bounds)',
    });
    expect(backend.getElementText).not.toHaveBeenCalled();
    expect(backend.longPress).not.toHaveBeenCalled();
    expect(backend.tapElement).toHaveBeenCalledTimes(1);
  });

  it('an unknown ref still fails with the default hint', async () => {
    const { context } = await setUp();

    const result = await clickTool({ a11yRef: 'e99' }, context);

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: ErrorCodes.MM_TARGET_NOT_FOUND,
        message: 'Unknown a11yRef: e99. Available refs: e1, e2, e3',
      },
    });
  });
});
