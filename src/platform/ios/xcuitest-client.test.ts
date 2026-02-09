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

      await client.swipe('left', 200, 400);

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

      await client.tap(10, 20);

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

      await client.tap(10, 20);

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

      await expect(client.tap(10, 20)).rejects.toThrow('fetch failed');

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

      await client.tap(10, 20);

      // retryDelayMs=10: first retry delay=10*(0+1)=10, second=10*(1+1)=20
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);

      sleepSpy.mockRestore();
    });
  });

  describe('request format', () => {
    it('sends correct Content-Type header', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.tap(0, 0);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('includes AbortSignal for timeout', async () => {
      const fetchMock = mockFetchOk({});
      globalThis.fetch = fetchMock;

      await client.tap(0, 0);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].signal).toBeDefined();
    });
  });
});
