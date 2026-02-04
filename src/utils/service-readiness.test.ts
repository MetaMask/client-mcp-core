import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { waitForServiceReady } from './service-readiness.js';

describe('waitForServiceReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('successful responses', () => {
    it('returns immediately on 200 OK response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      await promise;

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8545', {}, 3000);
    });

    it('returns immediately on 503 Service Unavailable response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      await promise;

      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns immediately on other successful status codes', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      });

      await waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('retry behavior - ECONNREFUSED', () => {
    it('retries on ECONNREFUSED error', async () => {
      const connectionError = new Error('Connection refused');
      (connectionError as Error & { cause: object }).cause = {
        code: 'ECONNREFUSED',
      };

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValue({ ok: true, status: 200 });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        delayMs: 500,
      });

      // First call fails with ECONNREFUSED
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past delay
      await vi.advanceTimersByTimeAsync(500);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('uses custom delay between retries', async () => {
      const connectionError = new Error('Connection refused');
      (connectionError as Error & { cause: object }).cause = {
        code: 'ECONNREFUSED',
      };

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValue({ ok: true, status: 200 });

      const customDelay = 1000;
      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        delayMs: customDelay,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance less than custom delay
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past custom delay
      await vi.advanceTimersByTimeAsync(2);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry behavior - AbortError (timeout)', () => {
    it('retries on AbortError', async () => {
      const abortError = new DOMException(
        'The operation was aborted',
        'AbortError',
      );

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(abortError)
        .mockResolvedValue({ ok: true, status: 200 });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        delayMs: 500,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry behavior - non-ok response', () => {
    it('retries on non-ok non-503 response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValue({ ok: true, status: 200 });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        delayMs: 500,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('other errors - service considered ready', () => {
    it('returns on generic errors (considers service ready)', async () => {
      const genericError = new Error('Some other error');

      const mockFetch = vi.fn().mockRejectedValue(genericError);

      await waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns on SSL/cert errors (considers service ready)', async () => {
      const sslError = new Error('self signed certificate');

      const mockFetch = vi.fn().mockRejectedValue(sslError);

      await waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('max attempts exceeded', () => {
    it('throws error after max attempts exceeded', async () => {
      const connectionError = new Error('Connection refused');
      (connectionError as Error & { cause: object }).cause = {
        code: 'ECONNREFUSED',
      };

      const mockFetch = vi.fn().mockRejectedValue(connectionError);

      let caughtError: unknown;
      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        maxAttempts: 3,
        delayMs: 100,
      }).catch((error) => {
        caughtError = error;
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe(
        'Service at http://localhost:8545 failed to become ready after 3 attempts',
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('uses default maxAttempts of 10', async () => {
      const connectionError = new Error('Connection refused');
      (connectionError as Error & { cause: object }).cause = {
        code: 'ECONNREFUSED',
      };

      const mockFetch = vi.fn().mockRejectedValue(connectionError);

      let caughtError: unknown;
      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        delayMs: 10,
      }).catch((error) => {
        caughtError = error;
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe(
        'Service at http://localhost:8545 failed to become ready after 10 attempts',
      );
      expect(mockFetch).toHaveBeenCalledTimes(10);
    });
  });

  describe('custom options', () => {
    it('uses custom timeoutMs for each fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        timeoutMs: 5000,
      });

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8545', {}, 5000);
    });

    it('uses default options when none provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8545', {}, 3000);
    });

    it('combines multiple custom options', async () => {
      const connectionError = new Error('Connection refused');
      (connectionError as Error & { cause: object }).cause = {
        code: 'ECONNREFUSED',
      };

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(connectionError)
        .mockResolvedValue({ ok: true, status: 200 });

      const promise = waitForServiceReady('http://localhost:8545', {
        fetchFn: mockFetch,
        maxAttempts: 5,
        delayMs: 200,
        timeoutMs: 2000,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8545', {}, 2000);

      await vi.advanceTimersByTimeAsync(200);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
