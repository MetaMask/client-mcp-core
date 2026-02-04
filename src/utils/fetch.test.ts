/**
 * Tests for fetchWithTimeout utility function
 *
 * @module utils/fetch.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchWithTimeout } from './fetch.js';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('successful fetch', () => {
    it('returns response on successful fetch', async () => {
      const mockResponse = new Response('OK', { status: 200 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal('fetch', mockFetch);

      const promise = fetchWithTimeout('http://example.com');
      const result = await promise;

      expect(result).toBe(mockResponse);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith('http://example.com', {
        signal: expect.any(AbortSignal),
      });
    });

    it('passes options to fetch', async () => {
      const mockResponse = new Response('OK', { status: 200 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal('fetch', mockFetch);

      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      };

      const result = await fetchWithTimeout('http://example.com', options);

      expect(result).toBe(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith('http://example.com', {
        ...options,
        signal: expect.any(AbortSignal),
      });
    });

    it('clears timeout after successful fetch', async () => {
      const mockResponse = new Response('OK', { status: 200 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal('fetch', mockFetch);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await fetchWithTimeout('http://example.com');

      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    });
  });

  describe('timeout behavior', () => {
    it('uses default timeout of 5000ms', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise(() => {});
      });
      vi.stubGlobal('fetch', mockFetch);

      const promise = fetchWithTimeout('http://example.com');

      // Advance time to just before timeout
      await vi.advanceTimersByTimeAsync(4999);

      // Get the AbortSignal from the call
      const callArgs = mockFetch.mock.calls[0];
      const signal = callArgs[1].signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2);
      expect(signal.aborted).toBe(true);

      // Clean up - reject the promise to avoid unhandled rejection
      promise.catch(() => {});
    });

    it('uses custom timeout when provided', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise(() => {});
      });
      vi.stubGlobal('fetch', mockFetch);

      const customTimeout = 3000;
      const promise = fetchWithTimeout(
        'http://example.com',
        {},
        customTimeout,
      );

      // Advance time to just before custom timeout
      await vi.advanceTimersByTimeAsync(2999);

      const callArgs = mockFetch.mock.calls[0];
      const signal = callArgs[1].signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      // Advance past custom timeout
      await vi.advanceTimersByTimeAsync(2);
      expect(signal.aborted).toBe(true);

      // Clean up
      promise.catch(() => {});
    });

    it('aborts fetch when timeout exceeded', async () => {
      const mockFetch = vi.fn().mockImplementation(
        (_url, options: { signal: AbortSignal }) => {
          return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
              reject(new Error('The operation was aborted'));
            });
          });
        },
      );
      vi.stubGlobal('fetch', mockFetch);

      let caughtError: unknown;
      const promise = fetchWithTimeout('http://example.com', {}, 1000).catch(
        (error) => {
          caughtError = error;
        },
      );

      await vi.advanceTimersByTimeAsync(1001);
      await promise;

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('The operation was aborted');
    });
  });

  describe('error handling', () => {
    it('clears timeout when fetch throws error', async () => {
      const error = new Error('Network error');
      const mockFetch = vi.fn().mockRejectedValue(error);
      vi.stubGlobal('fetch', mockFetch);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await expect(fetchWithTimeout('http://example.com')).rejects.toThrow(
        'Network error',
      );

      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    });

    it('propagates fetch errors', async () => {
      const networkError = new TypeError('Failed to fetch');
      const mockFetch = vi.fn().mockRejectedValue(networkError);
      vi.stubGlobal('fetch', mockFetch);

      await expect(fetchWithTimeout('http://example.com')).rejects.toThrow(
        'Failed to fetch',
      );
    });
  });
});
