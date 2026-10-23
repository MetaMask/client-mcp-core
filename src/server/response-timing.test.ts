import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequestTimer, withMeta } from './response-timing.js';

describe('RequestTimer', () => {
  let now = 0;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const useFakeClock = (start: number): void => {
    now = start;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  };

  it('reports zeros for phases that never started', () => {
    useFakeClock(1000);
    const timer = new RequestTimer();
    now = 1012.4;

    expect(timer.snapshot()).toStrictEqual({
      queueMs: 0,
      toolMs: 0,
      observationMs: 0,
      totalMs: 12,
    });
  });

  it('measures each phase', () => {
    useFakeClock(0);
    const timer = new RequestTimer(0);
    now = 5;
    timer.markEnqueued();
    now = 25;
    timer.markTaskStart();
    now = 125;
    timer.markToolEnd();
    now = 130;
    timer.markObservationStart();
    now = 180;
    timer.markObservationEnd();
    now = 190;

    expect(timer.snapshot()).toStrictEqual({
      queueMs: 20,
      toolMs: 100,
      observationMs: 50,
      totalMs: 190,
    });
  });

  it('measures an unfinished phase up to the snapshot', () => {
    useFakeClock(0);
    const timer = new RequestTimer(0);
    timer.markEnqueued();
    timer.markTaskStart();
    now = 40;

    expect(timer.snapshot().toolMs).toBe(40);
  });

  it('never reports totalMs below the sum of the rounded phases', () => {
    useFakeClock(0);
    const timer = new RequestTimer(0);
    timer.markEnqueued();
    now = 0.5;
    timer.markTaskStart();
    now = 1;
    timer.markToolEnd();
    timer.markObservationStart();
    now = 1.5;
    timer.markObservationEnd();

    // Each phase rounds up to 1ms; the 1.5ms total would round to 2.
    expect(timer.snapshot()).toStrictEqual({
      queueMs: 1,
      toolMs: 1,
      observationMs: 1,
      totalMs: 3,
    });
  });

  it('defaults the request start to now', () => {
    useFakeClock(500);
    const timer = new RequestTimer();
    now = 503;

    expect(timer.meta()).toStrictEqual({
      timing: { queueMs: 0, toolMs: 0, observationMs: 0, totalMs: 3 },
    });
  });
});

describe('withMeta', () => {
  const meta = {
    timing: { queueMs: 1, toolMs: 2, observationMs: 3, totalMs: 7 },
  };

  it('appends meta as the last key of an object body', () => {
    const body = withMeta({ ok: true, result: { a: 1 } }, meta);

    expect(body).toStrictEqual({ ok: true, result: { a: 1 }, meta });
    expect(Object.keys(body as object)).toStrictEqual(['ok', 'result', 'meta']);
  });

  it.each([['text'], [null], [42], [[1, 2]]])(
    'returns non-object body %j unchanged',
    (body) => {
      expect(withMeta(body, meta)).toBe(body);
    },
  );
});
