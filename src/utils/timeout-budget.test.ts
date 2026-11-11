import { describe, expect, it } from 'vitest';

import {
  computeTimeoutBudget,
  fallbackHttpTimeoutMs,
  resolveActionTimeoutMs,
  resolveCliHttpTimeoutMs,
  TIMEOUT_OVERHEAD_MS,
} from './timeout-budget.js';
import { toolRegistry } from '../tools/registry.js';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS,
  OBSERVATION_TIMEOUT_MS,
  QUEUE_SETTLE_TIMEOUT_MS,
} from '../tools/utils/constants.js';

describe('computeTimeoutBudget', () => {
  it('puts every layer on top of the action budget', () => {
    expect(computeTimeoutBudget(2000)).toStrictEqual({
      tool: 2000,
      queue: 2000 + OBSERVATION_TIMEOUT_MS + TIMEOUT_OVERHEAD_MS,
      http:
        2000 +
        OBSERVATION_TIMEOUT_MS +
        TIMEOUT_OVERHEAD_MS +
        QUEUE_SETTLE_TIMEOUT_MS +
        TIMEOUT_OVERHEAD_MS,
    });
  });

  it.each([
    0,
    100,
    1000,
    2000,
    5000,
    DEFAULT_INTERACTION_TIMEOUT_MS,
    30_000,
    60_000,
    120_000,
  ])('nests cli http > queue > action + observation for %ims', (action) => {
    const budget = computeTimeoutBudget(action);

    expect(budget.tool).toBe(action);
    expect(budget.queue).toBeGreaterThan(action + OBSERVATION_TIMEOUT_MS);
    expect(budget.http).toBeGreaterThan(budget.queue);
    expect(budget.http).toBeGreaterThanOrEqual(
      budget.queue + QUEUE_SETTLE_TIMEOUT_MS,
    );
  });

  it.each([
    ['click', { timeoutMs: 2500 }, 2500],
    ['click', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['type', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['get_text', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['inspect', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['wait_for', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['scroll_to_element', {}, DEFAULT_INTERACTION_TIMEOUT_MS],
    ['cdp', {}, DEFAULT_CDP_TIMEOUT_MS],
    ['wait_for_notification', {}, DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS],
  ] as const)(
    'derives a nested budget for %s with %o',
    (tool, input, action) => {
      const resolved = resolveActionTimeoutMs(tool, input);
      expect(resolved).toBe(action);

      const budget = computeTimeoutBudget(resolved as number);
      expect(budget.queue).toBeGreaterThan(resolved + OBSERVATION_TIMEOUT_MS);
      expect(budget.http).toBeGreaterThan(budget.queue);
    },
  );
});

describe('resolveActionTimeoutMs', () => {
  it('uses the timeoutMs in the input for any tool', () => {
    expect(resolveActionTimeoutMs('cdp', { timeoutMs: 5_000 })).toBe(5_000);
    expect(
      resolveActionTimeoutMs('wait_for_notification', { timeoutMs: 3_000 }),
    ).toBe(3_000);
    expect(resolveActionTimeoutMs('click', { timeoutMs: 4_000 })).toBe(4_000);
  });

  it('ignores timeoutMs for run_steps', () => {
    // The daemon schema strips it, so the CLI must not budget from it.
    expect(
      resolveActionTimeoutMs('run_steps', { timeoutMs: 4_000 }),
    ).toBeUndefined();
    expect(
      resolveActionTimeoutMs('run_steps', {
        timeoutMs: 4_000,
        steps: [{ tool: 'click' }],
      }),
    ).toBeUndefined();
  });

  it('ignores an unset or non-positive timeoutMs', () => {
    expect(resolveActionTimeoutMs('click', { timeoutMs: 0 })).toBe(
      DEFAULT_INTERACTION_TIMEOUT_MS,
    );
    expect(resolveActionTimeoutMs('click', { timeoutMs: -1 })).toBe(
      DEFAULT_INTERACTION_TIMEOUT_MS,
    );
    expect(resolveActionTimeoutMs('click', { timeoutMs: '1000' })).toBe(
      DEFAULT_INTERACTION_TIMEOUT_MS,
    );
    expect(resolveActionTimeoutMs('click', undefined)).toBe(
      DEFAULT_INTERACTION_TIMEOUT_MS,
    );
  });

  it('covers the batch deadline plus its slowest step for run_steps', () => {
    expect(
      resolveActionTimeoutMs('run_steps', {
        batchTimeoutMs: 30_000,
        steps: [{ tool: 'get_state' }, { tool: 'click', args: {} }],
      }),
    ).toBe(30_000 + DEFAULT_INTERACTION_TIMEOUT_MS);
    // A step with a longer budget moves the whole batch budget.
    expect(
      resolveActionTimeoutMs('run_steps', {
        batchTimeoutMs: 5_000,
        steps: [
          { tool: 'click', args: {} },
          { tool: 'wait_for', args: { timeoutMs: 60_000 } },
        ],
      }),
    ).toBe(5_000 + 60_000);
    // Aliases resolve to the real tool before the budget is looked up.
    expect(
      resolveActionTimeoutMs('run_steps', {
        batchTimeoutMs: 1_000,
        steps: [{ tool: 'scroll-to-element', args: { timeoutMs: 3_000 } }],
      }),
    ).toBe(1_000 + 3_000);
    // No usable step (an invalid body) still assumes one slow step.
    expect(
      resolveActionTimeoutMs('run_steps', {
        batchTimeoutMs: 2_000,
        steps: [],
      }),
    ).toBe(2_000 + DEFAULT_INTERACTION_TIMEOUT_MS);
  });

  it('keeps the default without a batch deadline', () => {
    expect(
      resolveActionTimeoutMs('run_steps', { batchTimeoutMs: 0 }),
    ).toBeUndefined();
    expect(resolveActionTimeoutMs('run_steps', {})).toBeUndefined();
    expect(
      resolveActionTimeoutMs('run_steps', {
        steps: [{ tool: 'click' }],
      }),
    ).toBeUndefined();
  });

  it('keeps the queue default for tools with no timeout concept', () => {
    for (const tool of [
      'navigate',
      'get_state',
      'describe_screen',
      'launch',
      'cleanup',
      'long_press',
    ]) {
      expect(resolveActionTimeoutMs(tool, {})).toBeUndefined();
    }
  });

  it('keeps the queue default for a mobile scroll_to_element', () => {
    // Mobile swipes up to maxAttempts and has no timeout of its own.
    expect(
      resolveActionTimeoutMs('scroll_to_element', {}, { platform: 'ios' }),
    ).toBeUndefined();
    expect(
      resolveActionTimeoutMs('scroll_to_element', {}, { platform: 'android' }),
    ).toBeUndefined();
    expect(
      resolveActionTimeoutMs('scroll_to_element', {}, { platform: 'browser' }),
    ).toBe(DEFAULT_INTERACTION_TIMEOUT_MS);
    // With an explicit timeout it is used on every platform.
    expect(
      resolveActionTimeoutMs(
        'scroll_to_element',
        { timeoutMs: 5_000 },
        { platform: 'ios' },
      ),
    ).toBe(5_000);
  });
});

describe('resolveCliHttpTimeoutMs', () => {
  it('derives the CLI abort from the action budget', () => {
    expect(
      resolveCliHttpTimeoutMs('click', {}, { queueDefaultMs: 30_000 }),
    ).toBe(computeTimeoutBudget(DEFAULT_INTERACTION_TIMEOUT_MS).http);
    expect(resolveCliHttpTimeoutMs('cdp', {})).toBe(
      computeTimeoutBudget(DEFAULT_CDP_TIMEOUT_MS).http,
    );
    expect(resolveCliHttpTimeoutMs('click', { timeoutMs: 2_000 })).toBe(
      computeTimeoutBudget(2_000).http,
    );
  });

  it('nests above the queue default for tools without an action budget', () => {
    for (const queueDefaultMs of [DEFAULT_REQUEST_TIMEOUT_MS, 180_000]) {
      expect(resolveCliHttpTimeoutMs('navigate', {}, { queueDefaultMs })).toBe(
        fallbackHttpTimeoutMs(queueDefaultMs),
      );
      expect(
        resolveCliHttpTimeoutMs('describe_screen', {}, { queueDefaultMs }),
      ).toBe(fallbackHttpTimeoutMs(queueDefaultMs));
      expect(
        resolveCliHttpTimeoutMs('run_steps', { steps: [] }, { queueDefaultMs }),
      ).toBe(fallbackHttpTimeoutMs(queueDefaultMs));
    }
  });

  it('uses the default queue when the daemon state has no value', () => {
    // A state file written before the queue default was published.
    expect(
      resolveCliHttpTimeoutMs('navigate', {}, { queueDefaultMs: undefined }),
    ).toBe(fallbackHttpTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS));
  });

  it('keeps launch and cleanup at least at their command default', () => {
    expect(
      resolveCliHttpTimeoutMs('launch', {}, { commandTimeoutMs: 120_000 }),
    ).toBe(120_000);
    expect(
      resolveCliHttpTimeoutMs(
        'launch',
        {},
        {
          commandTimeoutMs: 120_000,
          queueDefaultMs: 180_000,
        },
      ),
    ).toBe(fallbackHttpTimeoutMs(180_000));
    expect(
      resolveCliHttpTimeoutMs('cleanup', {}, { commandTimeoutMs: 30_000 }),
    ).toBe(fallbackHttpTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS));
  });

  it('takes the larger value for a platform-dependent tool', () => {
    // Mobile scroll_to_element has no action budget, so the daemon keeps the
    // queue default; the browser has 15 s. The CLI does not know the platform.
    expect(
      resolveCliHttpTimeoutMs(
        'scroll_to_element',
        {},
        {
          queueDefaultMs: 30_000,
        },
      ),
    ).toBe(fallbackHttpTimeoutMs(30_000));
    expect(
      resolveCliHttpTimeoutMs(
        'scroll_to_element',
        {},
        {
          queueDefaultMs: 180_000,
        },
      ),
    ).toBe(fallbackHttpTimeoutMs(180_000));
    // An explicit timeout is the same on every platform.
    expect(
      resolveCliHttpTimeoutMs('scroll_to_element', { timeoutMs: 5_000 }),
    ).toBe(computeTimeoutBudget(5_000).http);
  });

  it('covers the queue default for run_steps with a batch deadline', () => {
    const input = {
      batchTimeoutMs: 20_000,
      steps: [{ tool: 'click', args: {} }],
    };
    const action = 20_000 + DEFAULT_INTERACTION_TIMEOUT_MS;

    expect(
      resolveCliHttpTimeoutMs('run_steps', input, {
        queueDefaultMs: 30_000,
      }),
    ).toBe(computeTimeoutBudget(action).http);
    // The Mobile daemon gives run_steps at least its 180 s queue default.
    expect(
      resolveCliHttpTimeoutMs('run_steps', input, {
        queueDefaultMs: 180_000,
      }),
    ).toBe(fallbackHttpTimeoutMs(180_000));
  });

  it.each([DEFAULT_REQUEST_TIMEOUT_MS, 180_000])(
    'nests above the daemon queue for every registered tool (%ims daemon)',
    (queueDefaultMs) => {
      for (const toolName of toolRegistry.keys()) {
        const platform = 'android';
        const action = resolveActionTimeoutMs(toolName, {}, { platform });
        let daemonQueueMs =
          action === undefined
            ? queueDefaultMs
            : computeTimeoutBudget(action).queue;
        if (toolName === 'run_steps') {
          daemonQueueMs = Math.max(daemonQueueMs, queueDefaultMs);
        }

        expect(
          resolveCliHttpTimeoutMs(toolName, {}, { queueDefaultMs }),
        ).toBeGreaterThan(daemonQueueMs + QUEUE_SETTLE_TIMEOUT_MS);
      }
    },
  );
});
