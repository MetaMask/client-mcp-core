import { describe, it, expect, vi } from 'vitest';

import { RequestQueue } from './request-queue.js';
import {
  MAX_QUEUE_TIMEOUT_MS,
  QUEUE_SETTLE_TIMEOUT_MS,
} from '../tools/utils/constants.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RequestQueue', () => {
  it('executes enqueued functions sequentially', async () => {
    const queue = new RequestQueue();
    const results: number[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        await sleep(30);
        results.push(1);
      }),
      queue.enqueue(async () => {
        results.push(2);
      }),
      queue.enqueue(async () => {
        results.push(3);
      }),
    ]);

    expect(results).toStrictEqual([1, 2, 3]);
  });

  it('returns the value produced by the enqueued function', async () => {
    const queue = new RequestQueue();
    const result = await queue.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it('returns values from concurrent enqueues in order', async () => {
    const queue = new RequestQueue();
    const [a, b, c] = await Promise.all([
      queue.enqueue(async () => 'first'),
      queue.enqueue(async () => 'second'),
      queue.enqueue(async () => 'third'),
    ]);

    expect(a).toBe('first');
    expect(b).toBe('second');
    expect(c).toBe('third');
  });

  it('rejects when the function exceeds the timeout', async () => {
    const queue = new RequestQueue(50);

    await expect(
      queue.enqueue(
        async () => new Promise((resolve) => setTimeout(resolve, 500)),
      ),
    ).rejects.toThrowError('timed out');
  });

  it('uses a per-request timeout override when provided', async () => {
    const queue = new RequestQueue(500);

    await expect(
      queue.enqueue(async () => sleep(50), { timeoutMs: 10 }),
    ).rejects.toThrowError('Tool execution timed out after 10ms');
  });

  it('remains functional after a timeout rejection', async () => {
    const queue = new RequestQueue(50);

    await queue
      .enqueue(async () => new Promise((resolve) => setTimeout(resolve, 500)))
      .catch(() => {});

    const result = await queue.enqueue(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('propagates errors thrown by the enqueued function', async () => {
    const queue = new RequestQueue();

    await expect(
      queue.enqueue(async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrowError('task failed');
  });

  it('continues processing after an error in a previous task', async () => {
    const queue = new RequestQueue();

    await queue
      .enqueue(async () => {
        throw new Error('fail');
      })
      .catch(() => {});

    const result = await queue.enqueue(async () => 'after-error');
    expect(result).toBe('after-error');
  });

  describe('per-request timeout override', () => {
    it('uses options.timeoutMs when provided instead of default', async () => {
      const queue = new RequestQueue(30_000);

      await expect(
        queue.enqueue(async () => sleep(100).then(() => 'done'), {
          timeoutMs: 50,
        }),
      ).rejects.toThrowError('timed out after 50ms');
    }, 1000);

    it('uses default timeout when options is omitted', async () => {
      const queue = new RequestQueue(50);

      await expect(
        queue.enqueue(async () => sleep(100).then(() => 'done')),
      ).rejects.toThrowError('timed out after 50ms');
    }, 1000);

    it('preserves serialization guarantee with different timeouts', async () => {
      const queue = new RequestQueue(5_000);
      const order: number[] = [];

      const task1 = queue.enqueue(
        async () => {
          order.push(1);
          return 'first';
        },
        { timeoutMs: 1_000 },
      );

      const task2 = queue.enqueue(async () => {
        order.push(2);
        return 'second';
      });

      await Promise.all([task1, task2]);

      expect(order).toStrictEqual([1, 2]);
    });
  });

  describe('abort signal', () => {
    it('passes a signal that is not aborted on the normal path', async () => {
      const queue = new RequestQueue(1_000);
      let seen: AbortSignal | undefined;

      await queue.enqueue(async (signal) => {
        seen = signal;
        return 'ok';
      });

      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    });

    it('aborts the signal with the timeout error before rejecting', async () => {
      const queue = new RequestQueue(20);
      let seen: AbortSignal | undefined;

      const rejection = await queue
        .enqueue(async (signal) => {
          seen = signal;
          return sleep(200);
        })
        .catch((error: unknown) => error);

      expect(seen?.aborted).toBe(true);
      expect(seen?.reason).toBe(rejection);
      expect((rejection as Error).message).toBe(
        'Tool execution timed out after 20ms',
      );
    });

    it('lets a timed-out task stop at its next checkpoint', async () => {
      const queue = new RequestQueue(20);
      const steps: string[] = [];

      await queue
        .enqueue(async (signal) => {
          steps.push('step 1');
          await sleep(60);
          if (signal.aborted) {
            steps.push('stopped');
            return;
          }
          steps.push('step 2');
        })
        .catch(() => undefined);

      expect(steps).toStrictEqual(['step 1', 'stopped']);
    });

    it('gives each task its own signal', async () => {
      const queue = new RequestQueue(20);
      const signals: AbortSignal[] = [];

      await queue
        .enqueue(async (signal) => {
          signals.push(signal);
          return sleep(60);
        })
        .catch(() => undefined);
      await queue.enqueue(async (signal) => {
        signals.push(signal);
      });

      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      expect(signals[0]).not.toBe(signals[1]);
    });

    it('waits for the timed-out task to settle before the next task starts', async () => {
      const queue = new RequestQueue(20);
      const order: string[] = [];

      const first = queue
        .enqueue(async () => {
          await sleep(60);
          order.push('first settled');
        })
        .catch(() => order.push('first rejected'));
      const second = queue.enqueue(async () => {
        order.push('second started');
      });

      await Promise.all([first, second]);

      expect(order).toContain('first rejected');
      expect(order.indexOf('first settled')).toBeLessThan(
        order.indexOf('second started'),
      );
    });
  });

  it('clamps an oversized timeout to MAX_QUEUE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const queue = new RequestQueue();
      const pending = queue
        .enqueue(async () => new Promise<never>(() => undefined), {
          timeoutMs: Number.MAX_SAFE_INTEGER,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(
        MAX_QUEUE_TIMEOUT_MS + QUEUE_SETTLE_TIMEOUT_MS,
      );
      expect(String(await pending)).toContain(
        `timed out after ${MAX_QUEUE_TIMEOUT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
