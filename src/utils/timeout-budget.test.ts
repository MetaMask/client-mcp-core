import { describe, expect, it } from 'vitest';

import {
  computeTimeoutBudget,
  resolveActionTimeoutMs,
  TIMEOUT_OVERHEAD_MS,
} from './timeout-budget.js';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
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
    expect(resolveActionTimeoutMs('run_steps', { timeoutMs: 4_000 })).toBe(
      4_000,
    );
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

  it('uses the batch deadline for run_steps and keeps the default without it', () => {
    expect(
      resolveActionTimeoutMs('run_steps', { batchTimeoutMs: 30_000 }),
    ).toBe(30_000);
    expect(
      resolveActionTimeoutMs('run_steps', { batchTimeoutMs: 0 }),
    ).toBeUndefined();
    expect(resolveActionTimeoutMs('run_steps', {})).toBeUndefined();
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
