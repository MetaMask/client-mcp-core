import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { delay, retryUntil } from './retry';

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('delay', () => {
    it('resolves after specified milliseconds', async () => {
      const promise = delay(1000);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(await promise).toBeUndefined();
    });

    it('resolves immediately with zero delay', async () => {
      const promise = delay(0);

      await vi.advanceTimersByTimeAsync(0);

      expect(await promise).toBeUndefined();
    });

    it('resolves after multiple advances', async () => {
      const promise = delay(5000);

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);

      expect(await promise).toBeUndefined();
    });
  });

  describe('retryUntil', () => {
    it('returns result on first success', async () => {
      const operation = vi.fn().mockResolvedValueOnce('success');
      const isSuccess = vi.fn().mockReturnValueOnce(true);

      const result = await retryUntil(operation, isSuccess, {
        attempts: 3,
        delayMs: 100,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(isSuccess).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds on second attempt', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValueOnce('success');
      const isSuccess = vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 3,
        delayMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(isSuccess).toHaveBeenCalledTimes(2);
    });

    it('respects delay between retries', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValueOnce('success');
      const isSuccess = vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 3,
        delayMs: 500,
      });

      // First operation happens immediately
      expect(operation).toHaveBeenCalledTimes(1);

      // Advance 250ms - not enough for retry
      await vi.advanceTimersByTimeAsync(250);
      expect(operation).toHaveBeenCalledTimes(1);

      // Advance another 250ms - now retry happens
      await vi.advanceTimersByTimeAsync(250);
      expect(operation).toHaveBeenCalledTimes(2);

      const result = await promise;
      expect(result).toBe('success');
    });

    it('returns last result when all attempts fail', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail1')
        .mockResolvedValueOnce('fail2')
        .mockResolvedValueOnce('fail3');
      const isSuccess = vi.fn().mockReturnValue(false);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 3,
        delayMs: 100,
      });

      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result).toBe('fail3');
      expect(operation).toHaveBeenCalledTimes(3);
      expect(isSuccess).toHaveBeenCalledTimes(3);
    });

    it('does not delay after final attempt', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValueOnce('fail');
      const isSuccess = vi.fn().mockReturnValue(false);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 2,
        delayMs: 1000,
      });

      // First operation happens immediately
      expect(operation).toHaveBeenCalledTimes(1);

      // Advance 1000ms for delay
      await vi.advanceTimersByTimeAsync(1000);
      expect(operation).toHaveBeenCalledTimes(2);

      // No more delays should be scheduled
      const result = await promise;
      expect(result).toBe('fail');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('handles single attempt', async () => {
      const operation = vi.fn().mockResolvedValueOnce('result');
      const isSuccess = vi.fn().mockReturnValueOnce(true);

      const result = await retryUntil(operation, isSuccess, {
        attempts: 1,
        delayMs: 100,
      });

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(isSuccess).toHaveBeenCalledTimes(1);
    });

    it('calls isSuccess with operation result', async () => {
      const operation = vi.fn().mockResolvedValueOnce({ data: 'test' });
      const isSuccess = vi.fn().mockReturnValueOnce(true);

      await retryUntil(operation, isSuccess, {
        attempts: 1,
        delayMs: 100,
      });

      expect(isSuccess).toHaveBeenCalledWith({ data: 'test' });
    });

    it('retries multiple times with consistent delay', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail1')
        .mockResolvedValueOnce('fail2')
        .mockResolvedValueOnce('success');
      const isSuccess = vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 3,
        delayMs: 200,
      });

      // First attempt
      expect(operation).toHaveBeenCalledTimes(1);

      // Advance 200ms for first retry
      await vi.advanceTimersByTimeAsync(200);
      expect(operation).toHaveBeenCalledTimes(2);

      // Advance 200ms for second retry
      await vi.advanceTimersByTimeAsync(200);
      expect(operation).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe('success');
    });

    it('handles async operation errors', async () => {
      const error = new Error('operation failed');
      const operation = vi.fn().mockRejectedValueOnce(error);
      const isSuccess = vi.fn();

      const promise = retryUntil(operation, isSuccess, {
        attempts: 1,
        delayMs: 100,
      });

      await expect(promise).rejects.toThrowError('operation failed');
    });

    it('stops retrying after success even with remaining attempts', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValueOnce('success');
      const isSuccess = vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 5,
        delayMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(isSuccess).toHaveBeenCalledTimes(2);
    });

    it('handles zero delay between retries', async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValueOnce('success');
      const isSuccess = vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = retryUntil(operation, isSuccess, {
        attempts: 2,
        delayMs: 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });
});
