import { describe, it, expect } from 'vitest';

import { RequestQueue } from './request-queue.js';

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
});
