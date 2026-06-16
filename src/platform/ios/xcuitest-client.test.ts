/* eslint-disable -- fetch and Response are stable APIs since Node 20.18+ (LTS), see https://nodejs.org/docs/latest-v20.x/api/globals.html#fetch */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { XCUITestClient } from './xcuitest-client.js';
import type {
  RunnerResponse,
  SnapshotNode,
  RunnerErrorPayload,
} from './types.js';

const TEST_PORT = 9876;
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/command`;

function mockFetchOk<T>(data: T): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, data } as RunnerResponse<T>), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError(errorMessage: string): ReturnType<typeof vi.fn> {
  const errorPayload: RunnerErrorPayload = { message: errorMessage };
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ ok: false, error: errorPayload } as RunnerResponse),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
}

describe('XCUITestClient', () => {
  let client: XCUITestClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new XCUITestClient({
      port: TEST_PORT,
      maxRetries: 2,
      retryDelayMs: 10,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('uses default config values', () => {
      const minimalClient = new XCUITestClient({ port: 1234 });
      globalThis.fetch = mockFetchOk({});

      expect(() => minimalClient.tap(100, 200)).not.toThrow();
    });

    it('accepts custom host', async () => {
      const customClient = new XCUITestClient({
        port: 5555,
        host: '192.168.1.10',
      });
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await customClient.tap(10, 20);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.1.10:5555/command',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });

  describe('tap', () => {
    it('sends tap command with coordinates', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.tap(150, 300);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ x: 150, y: 300, command: 'tap' }),
        }),
      );
    });
  });

  describe('type', () => {
    it('sends type command with text', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.type('hello world');

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({ text: 'hello world', command: 'type' }),
        }),
      );
    });
  });

  describe('swipe', () => {
    it('sends swipe command with direction', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.swipe('up');

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({
            direction: 'up',
            x: undefined,
            y: undefined,
            command: 'swipe',
          }),
        }),
      );
    });

    it('sends swipe command with direction and coordinates', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.swipe('left', { x: 200, y: 400 });

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({
            direction: 'left',
            x: 200,
            y: 400,
            command: 'swipe',
          }),
        }),
      );
    });
  });

  describe('snapshot', () => {
    it('returns snapshot node tree', async () => {
      const snapshotData: SnapshotNode[] = [
        {
          index: 0,
          type: 'Application',
          label: 'MyApp',
          children: [
            {
              index: 1,
              type: 'Button',
              label: 'Submit',
              rect: { x: 10, y: 20, width: 100, height: 44 },
              enabled: true,
              hittable: true,
            },
          ],
        },
      ];
      globalThis.fetch = mockFetchOk({ nodes: snapshotData, truncated: false });

      const result = await client.snapshot();

      expect(result).toEqual(snapshotData);
      expect(result[0]?.children?.[0]?.label).toBe('Submit');
    });

    it('passes snapshot options', async () => {
      const fetchMock = mockFetchOk({ nodes: [], truncated: false });
      globalThis.fetch = fetchMock;

      await client.snapshot({ interactiveOnly: true, compact: true });

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({
            interactiveOnly: true,
            compact: true,
            command: 'snapshot',
          }),
        }),
      );
    });
  });

  describe('back', () => {
    it('sends back command', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.back();

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({ command: 'back' }),
        }),
      );
    });
  });

  describe('home', () => {
    it('sends home command', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.home();

      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({ command: 'home' }),
        }),
      );
    });
  });

  describe('waitForRunner', () => {
    it('returns true when snapshot succeeds immediately', async () => {
      globalThis.fetch = mockFetchOk({ nodes: [], truncated: false });
      const result = await client.waitForRunner(5000);
      expect(result).toBe(true);
    });

    it('polls until snapshot succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              data: { nodes: [], truncated: false },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      globalThis.fetch = fetchMock;
      const result = await client.waitForRunner(5000);
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns false on timeout', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await client.waitForRunner(200);
      expect(result).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('sends shutdown command', async () => {
      const fetchMock = mockFetchOk({ message: 'shutdown' });
      globalThis.fetch = fetchMock;
      await client.shutdown();
      expect(fetchMock).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          body: JSON.stringify({ command: 'shutdown' }),
        }),
      );
    });

    it('ignores errors on shutdown', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('connection closed'));
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws on runner error response', async () => {
      globalThis.fetch = mockFetchError('Element not found');

      await expect(client.tap(0, 0)).rejects.toThrow(
        "Runner command 'tap' failed: Element not found",
      );
    });

    it('throws on unknown runner error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(client.tap(0, 0)).rejects.toThrow(
        "Runner command 'tap' failed: unknown error",
      );
    });
  });

  describe('retry logic', () => {
    it('retries on ECONNREFUSED and succeeds', async () => {
      const connRefusedError = new TypeError('fetch failed', {
        cause: { code: 'ECONNREFUSED' },
      });
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(connRefusedError)
        .mockRejectedValueOnce(connRefusedError)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      globalThis.fetch = fetchMock;

      await client.ping();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries on fetch failed message', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      globalThis.fetch = fetchMock;

      await client.ping();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry on timeout error', async () => {
      const timeoutError = new DOMException(
        'The operation timed out',
        'TimeoutError',
      );
      const fetchMock = vi.fn().mockRejectedValueOnce(timeoutError);
      globalThis.fetch = fetchMock;

      await expect(client.tap(10, 20)).rejects.toThrow(
        'The operation timed out',
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry on non-retryable errors', async () => {
      globalThis.fetch = mockFetchError('Bad command');

      await expect(client.tap(0, 0)).rejects.toThrow(
        "Runner command 'tap' failed: Bad command",
      );

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws last error', async () => {
      const connRefusedError = new TypeError('fetch failed', {
        cause: { code: 'ECONNREFUSED' },
      });
      globalThis.fetch = vi.fn().mockRejectedValue(connRefusedError);

      await expect(client.ping()).rejects.toThrow('fetch failed');

      // initial + 2 retries = 3
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('applies exponential backoff between retries', async () => {
      const sleepSpy = vi.spyOn(
        XCUITestClient.prototype as unknown as {
          sleep: (ms: number) => Promise<void>;
        },
        'sleep',
      );
      const connRefusedError = new TypeError('fetch failed', {
        cause: { code: 'ECONNREFUSED' },
      });
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(connRefusedError)
        .mockRejectedValueOnce(connRefusedError)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      await client.ping();

      // retryDelayMs=10: first retry delay=10*(0+1)=10, second=10*(1+1)=20
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);

      sleepSpy.mockRestore();
    });

    describe('mutating commands do not retry', () => {
      it('tap does not retry on ECONNREFUSED', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
        globalThis.fetch = fetchMock;

        await expect(client.tap(10, 20)).rejects.toThrow('fetch failed');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('tapElement does not retry on socket hang up', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
        globalThis.fetch = fetchMock;

        await expect(client.tapElement('Submit')).rejects.toThrow(
          'socket hang up',
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('type does not retry on fetch failed', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
        globalThis.fetch = fetchMock;

        await expect(client.type('hello')).rejects.toThrow('fetch failed');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('fill does not retry on connection errors', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
        globalThis.fetch = fetchMock;

        await expect(client.fill(100, 200, 'secret')).rejects.toThrow(
          'fetch failed',
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('swipe does not retry on connection errors', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
        globalThis.fetch = fetchMock;

        await expect(client.swipe('up')).rejects.toThrow('fetch failed');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('back does not retry on connection errors', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
        globalThis.fetch = fetchMock;

        await expect(client.back()).rejects.toThrow('fetch failed');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('home does not retry on connection errors', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
        globalThis.fetch = fetchMock;

        await expect(client.home()).rejects.toThrow('fetch failed');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    describe('retryable commands still retry', () => {
      it('snapshot still retries on ECONNREFUSED', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi
          .fn()
          .mockRejectedValueOnce(connRefusedError)
          .mockRejectedValueOnce(connRefusedError)
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ ok: true, data: { nodes: [], truncated: false } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        globalThis.fetch = fetchMock;

        const result = await client.snapshot();

        expect(result).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });

      it('bind still retries on ECONNREFUSED', async () => {
        const connRefusedError = new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
        const fetchMock = vi
          .fn()
          .mockRejectedValueOnce(connRefusedError)
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true, data: {} }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        globalThis.fetch = fetchMock;

        await client.bind('io.app.bundle');

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('AbortSignal support', () => {
    it('throws immediately when signal is already aborted without calling fetch', async () => {
      const ctrl = new AbortController();
      ctrl.abort(new Error('user cancelled'));
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await expect(
        client.fill(100, 200, 'text', { signal: ctrl.signal }),
      ).rejects.toThrow('user cancelled');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aborts fetch when signal is triggered', async () => {
      const ctrl = new AbortController();
      const fetchMock = vi.fn().mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(
              new DOMException('The operation was aborted', 'AbortError'),
            );
            return;
          }
          init.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted', 'AbortError'),
            );
          });
        });
      });
      globalThis.fetch = fetchMock;

      const promise = client.tap(100, 200, { signal: ctrl.signal });
      ctrl.abort();

      await expect(promise).rejects.toThrow('aborted');
    });

    it('does not retry non-retryable command when signal aborts during failure', async () => {
      const ctrl = new AbortController();
      const fetchMock = vi.fn().mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(
              new DOMException('The operation was aborted', 'AbortError'),
            );
            return;
          }
          init.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted', 'AbortError'),
            );
          });
        });
      });
      globalThis.fetch = fetchMock;

      const promise = client.fill(100, 200, 'secret', {
        signal: ctrl.signal,
      });

      ctrl.abort(new Error('stop'));

      await expect(promise).rejects.toThrow('stop');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('bails out of retry loop when signal aborts during backoff on retryable command', async () => {
      const ctrl = new AbortController();
      const connRefusedError = new TypeError('fetch failed', {
        cause: { code: 'ECONNREFUSED' },
      });
      const fetchMock = vi.fn().mockRejectedValue(connRefusedError);
      globalThis.fetch = fetchMock;

      const promise = client.ping({ signal: ctrl.signal });

      setTimeout(() => ctrl.abort(new Error('early exit')), 5);

      await expect(promise).rejects.toThrow('early exit');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
