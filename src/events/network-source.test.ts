import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { MAX_RPC_REQUEST_BYTES } from './json-rpc.js';
import {
  MAX_CONCURRENT_RPC_READS,
  MAX_PENDING_REQUESTS,
  MAX_RESOURCE_BUFFER_BYTES,
  MAX_RPC_RESPONSE_BYTES,
  MAX_TOTAL_BUFFER_BYTES,
  NETWORK_EVENTS,
  NetworkSource,
  RPC_RESPONSE_READ_TIMEOUT_MS,
} from './network-source.js';
import { SessionEvents } from './session-events.js';
import type {
  CdpEvent,
  CdpEventTarget,
  CdpManager,
  CdpSubscribeOptions,
  CdpSubscription,
  CdpTargetLifecycleEvent,
} from '../platform/cdp-manager.js';
import type { NetworkRecord } from '../tools/types/events.js';

const INFURA_KEY = '0123456789abcdef0123456789abcdef';
const SW: CdpEventTarget = {
  kind: 'sw',
  targetId: 'W1',
  url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg.js',
};
const PAGE: CdpEventTarget = {
  kind: 'page',
  targetId: 'P1',
  url: 'https://dapp.example/',
};

/**
 * Starts a network source on a fake manager.
 *
 * @param sendToEventTarget - Answers `Network.getResponseBody`.
 * @returns The session events, an emitter and the subscribe options.
 */
async function startSource(
  sendToEventTarget: CdpManager['sendToEventTarget'] = vi.fn(),
): Promise<{
  events: SessionEvents;
  emit: (
    method: string,
    params: Record<string, unknown>,
    target?: CdpEventTarget,
  ) => void;
  detach: (event: CdpTargetLifecycleEvent) => void;
  options: CdpSubscribeOptions;
  source: NetworkSource;
  manager: CdpManager;
  subscription: CdpSubscription;
}> {
  let options: CdpSubscribeOptions | undefined;
  const listeners = new Set<(event: CdpTargetLifecycleEvent) => void>();
  const manager = {
    subscribe: vi.fn(async (subscribeOptions: CdpSubscribeOptions) => {
      options = subscribeOptions;
      return { unsubscribe: vi.fn() };
    }),
    sendToEventTarget,
    on: vi.fn(
      (_event: string, listener: (event: CdpTargetLifecycleEvent) => void) => {
        listeners.add(listener);
      },
    ),
    off: vi.fn(
      (_event: string, listener: (event: CdpTargetLifecycleEvent) => void) => {
        listeners.delete(listener);
      },
    ),
  } as unknown as CdpManager;
  const events = new SessionEvents({} as BrowserContext, []);
  const source = new NetworkSource();
  const subscription = await source.start(manager, events);
  const subscribed = options as CdpSubscribeOptions;
  return {
    events,
    source,
    manager,
    subscription,
    options: subscribed,
    emit: (method, params, target = SW): void =>
      subscribed.onEvent({ target, method, params, t: 9999 } as CdpEvent),
    detach: (event): void => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

/**
 * Reads every network record.
 *
 * @param events - The session events.
 * @returns The records.
 */
function readAll(events: SessionEvents): NetworkRecord[] {
  return events.buffer.read<NetworkRecord>({ kind: 'network', limit: 5000 })
    .records;
}

/**
 * Reads every settled network record (what a filtered `mm network` does).
 *
 * @param events - The session events.
 * @returns The records.
 */
function settledReadAll(events: SessionEvents): NetworkRecord[] {
  return events.buffer.read<NetworkRecord>({
    kind: 'network',
    settled: true,
    limit: 5000,
  }).records;
}

/**
 * Builds `Network.requestWillBeSent` parameters.
 *
 * @param requestId - The request ID.
 * @param url - The URL.
 * @param extra - Other parameters.
 * @returns The parameters.
 */
function willBeSent(
  requestId: string,
  url: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { request, ...rest } = extra as {
    request?: Record<string, unknown>;
  };
  return {
    requestId,
    request: { url, method: 'GET', ...request },
    timestamp: 100,
    wallTime: 1_700_000_000.123,
    type: 'Fetch',
    ...rest,
  };
}

describe('NetworkSource', () => {
  it('subscribes to the Network events with body buffer limits', async () => {
    const { options } = await startSource();
    expect(options.events).toStrictEqual(NETWORK_EVENTS);
    expect(options.enable).toStrictEqual({
      Network: {
        maxPostDataSize: MAX_RPC_REQUEST_BYTES,
        maxResourceBufferSize: MAX_RESOURCE_BUFFER_BYTES,
        maxTotalBufferSize: MAX_TOTAL_BUFFER_BYTES,
      },
    });
  });

  it('stops listening for target detaches when unsubscribed', async () => {
    const { subscription, detach, emit, events } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('1', 'https://a/'), PAGE);
    await subscription.unsubscribe();
    detach({ kind: 'page', targetId: PAGE.targetId });
    expect(events.networkStats.pending).toBe(1);
  });

  it('records one request, updated in place with status and ms', async () => {
    const { events, emit } = await startSource();
    emit(
      'Network.requestWillBeSent',
      willBeSent('1', `https://mainnet.infura.io/v3/${INFURA_KEY}?apiKey=s`),
    );
    expect(events.networkStats.pending).toBe(1);
    const read = events.buffer.read<NetworkRecord>({
      kind: 'network',
      limit: 10,
    });
    expect(read.records).toStrictEqual([
      {
        seq: 1,
        t: 1_700_000_000_123,
        target: { kind: 'sw', id: 'W1', url: SW.url },
        method: 'GET',
        url: 'https://mainnet.infura.io/v3/[REDACTED]?apiKey=[REDACTED]',
        type: 'fetch',
      },
    ]);

    emit('Network.responseReceived', {
      requestId: '1',
      response: { status: 200 },
    });
    emit('Network.loadingFinished', { requestId: '1', timestamp: 100.1234 });

    expect(readAll(events)).toStrictEqual([
      expect.objectContaining({ seq: 1, status: 200, ms: 123 }),
    ]);
    expect(events.networkStats.pending).toBe(0);
    // Already read past it: the update is not returned again.
    expect(
      events.buffer.read<NetworkRecord>({
        kind: 'network',
        cursor: read.cursor,
        limit: 10,
      }).records,
    ).toStrictEqual([]);
  });

  it('records a failure with its duration, redacted', async () => {
    const { events, emit } = await startSource();
    emit(
      'Network.requestWillBeSent',
      willBeSent('2', 'https://a.example/slow'),
    );
    emit('Network.loadingFailed', {
      requestId: '2',
      timestamp: 100.05,
      errorText: 'net::ERR_ABORTED',
    });
    emit('Network.requestWillBeSent', willBeSent('3', 'https://a.example/b'));
    emit('Network.loadingFailed', {
      requestId: '3',
      blockedReason: 'mixed-content',
    });

    expect(readAll(events)).toStrictEqual([
      expect.objectContaining({ ms: 50, failure: 'net::ERR_ABORTED' }),
      expect.objectContaining({
        failure: 'failed (blocked: mixed-content)',
      }),
    ]);
    expect(readAll(events)[1]?.ms).toBeUndefined();
  });

  it('includes the CORS reason in a failure', async () => {
    const { events, emit } = await startSource();
    emit(
      'Network.requestWillBeSent',
      willBeSent('c1', 'https://a.example/cors'),
    );
    emit('Network.loadingFailed', {
      requestId: 'c1',
      errorText: 'net::ERR_FAILED',
      corsErrorStatus: {
        corsError: 'MissingAllowOriginHeader',
        failedParameter: 'Access-Control-Allow-Origin',
      },
    });

    expect(readAll(events)[0]?.failure).toBe(
      'net::ERR_FAILED (cors: MissingAllowOriginHeader)',
    );
  });

  it('uses the delivery time and defaults when CDP leaves fields out', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', {
      requestId: '4',
      request: { url: 'https://a.example/' },
    });
    emit('Network.responseReceived', { requestId: '4', response: {} });
    emit('Network.loadingFinished', { requestId: '4' });

    expect(readAll(events)).toStrictEqual([
      {
        seq: 1,
        settledSeq: 2,
        t: 9999,
        target: { kind: 'sw', id: 'W1', url: SW.url },
        method: 'GET',
        url: 'https://a.example/',
        type: 'other',
      },
    ]);
  });

  it('counts non-http URLs as ignored and ignores events without a request ID', async () => {
    const { events, emit } = await startSource();
    emit(
      'Network.requestWillBeSent',
      willBeSent(
        '5',
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js',
      ),
    );
    emit('Network.requestWillBeSent', willBeSent('6', 'data:text/plain,hi'));
    emit('Network.requestWillBeSent', { request: { url: 'https://a/' } });
    emit('Network.requestWillBeSent', { requestId: '7' });
    emit('Network.loadingFinished', { requestId: 'unknown' });
    emit('Network.loadingFailed', { requestId: 'unknown' });
    emit('Network.responseReceived', { requestId: 'unknown' });

    expect(readAll(events)).toStrictEqual([]);
    expect(events.networkStats.ignored).toBe(3);
  });

  it('settles a failed request so a filtered read sees its final state', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('f1', 'https://a.example/'));
    expect(settledReadAll(events)).toStrictEqual([]);

    emit('Network.loadingFailed', {
      requestId: 'f1',
      timestamp: 100.05,
      errorText: 'net::ERR_ABORTED',
    });

    expect(settledReadAll(events)).toStrictEqual([
      expect.objectContaining({
        seq: 1,
        settledSeq: 2,
        failure: 'net::ERR_ABORTED',
      }),
    ]);
  });

  it('settles each redirect hop when the next one starts', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('r1', 'http://a.example/old'));
    expect(settledReadAll(events)).toStrictEqual([]);

    emit(
      'Network.requestWillBeSent',
      willBeSent('r1', 'https://a.example/new', {
        timestamp: 100.02,
        redirectResponse: { status: 301 },
      }),
    );
    // The first hop is final; the new hop is still pending and has no
    // settle position yet.
    expect(settledReadAll(events)).toStrictEqual([
      expect.objectContaining({
        seq: 1,
        settledSeq: 2,
        url: 'http://a.example/old',
        status: 301,
      }),
    ]);

    emit('Network.loadingFinished', { requestId: 'r1', timestamp: 100.05 });
    expect(settledReadAll(events).map((record) => record.seq)).toStrictEqual([
      1, 3,
    ]);
  });

  it('settles every pending request when it starts again on a new manager', async () => {
    const { events, emit, source, manager } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('1', 'https://a/'));
    expect(settledReadAll(events)).toStrictEqual([]);

    await source.start(manager, events);

    expect(settledReadAll(events)).toStrictEqual([
      expect.objectContaining({ seq: 1, settledSeq: 2 }),
    ]);
  });

  it('keys requests by target, so equal request IDs do not mix', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('1', 'https://a.example/sw'));
    emit(
      'Network.requestWillBeSent',
      willBeSent('1', 'https://a.example/page'),
      PAGE,
    );
    emit(
      'Network.responseReceived',
      { requestId: '1', response: { status: 404 } },
      PAGE,
    );
    emit('Network.responseReceived', {
      requestId: '1',
      response: { status: 200 },
    });

    expect(
      readAll(events).map((record) => [record.target.kind, record.status]),
    ).toStrictEqual([
      ['sw', 200],
      ['page', 404],
    ]);
  });

  it('ends a redirect hop and starts a new record for the next URL', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('8', 'http://a.example/old'));
    emit(
      'Network.requestWillBeSent',
      willBeSent('8', 'https://a.example/new', {
        timestamp: 100.02,
        redirectResponse: { status: 301 },
      }),
    );
    emit('Network.responseReceived', {
      requestId: '8',
      response: { status: 200 },
    });
    emit('Network.loadingFinished', { requestId: '8', timestamp: 100.05 });

    expect(
      readAll(events).map(({ url, status, ms }) => ({ url, status, ms })),
    ).toStrictEqual([
      { url: 'http://a.example/old', status: 301, ms: 20 },
      { url: 'https://a.example/new', status: 200, ms: 30 },
    ]);
  });

  it('keeps a redirect hop without a status or time as is', async () => {
    const { events, emit } = await startSource();
    emit('Network.requestWillBeSent', {
      requestId: '9',
      request: { url: 'https://a.example/1' },
    });
    emit('Network.requestWillBeSent', {
      requestId: '9',
      request: { url: 'https://a.example/2' },
      redirectResponse: {},
    });
    expect(readAll(events)[0]).not.toHaveProperty('status');
    expect(readAll(events)[0]).not.toHaveProperty('ms');
  });

  it('reads rpcMethods from postData and postDataEntries', async () => {
    const { events, emit } = await startSource();
    emit(
      'Network.requestWillBeSent',
      willBeSent('10', 'https://rpc.example/', {
        request: {
          method: 'POST',
          postData: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}',
        },
      }),
    );
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 2, method: 'eth_chainId' },
      { jsonrpc: '2.0', id: 3, method: 'eth_blockNumber' },
    ]);
    emit(
      'Network.requestWillBeSent',
      willBeSent('11', 'https://rpc.example/', {
        request: {
          method: 'POST',
          postDataEntries: [
            { bytes: Buffer.from(batch.slice(0, 10)).toString('base64') },
            { bytes: Buffer.from(batch.slice(10)).toString('base64') },
            {},
          ],
        },
      }),
    );
    emit(
      'Network.requestWillBeSent',
      willBeSent('12', 'https://rpc.example/', {
        request: { method: 'POST', postDataEntries: [] },
      }),
    );
    emit(
      'Network.requestWillBeSent',
      willBeSent('13', 'https://rpc.example/', {
        request: {
          method: 'POST',
          postDataEntries: [
            { bytes: Buffer.alloc(70 * 1024, 'a').toString('base64') },
          ],
        },
      }),
    );
    emit(
      'Network.requestWillBeSent',
      willBeSent('14', 'https://rpc.example/', {
        request: { method: 'GET', postData: '{"id":1,"method":"eth_call"}' },
      }),
    );

    expect(readAll(events).map((record) => record.rpcMethods)).toStrictEqual([
      ['eth_call'],
      ['eth_chainId', 'eth_blockNumber'],
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('forgets the oldest pending request past the limit as abandoned', async () => {
    const { events, emit } = await startSource();
    // The record and the pending entry are both full at the limit, so the
    // abandoned record is already out of the buffer: keep the objects the
    // source appends to inspect it.
    const appended: NetworkRecord[] = [];
    const append = events.buffer.append.bind(events.buffer);
    vi.spyOn(events.buffer, 'append').mockImplementation(((
      kind: 'network',
      record: Omit<NetworkRecord, 'seq'>,
    ) => {
      const stored = append(kind, record);
      appended.push(stored);
      return stored;
    }) as typeof events.buffer.append);
    for (let index = 0; index <= MAX_PENDING_REQUESTS; index++) {
      emit('Network.requestWillBeSent', willBeSent(`p${index}`, 'https://a/'));
    }
    expect(events.networkStats.pending).toBe(MAX_PENDING_REQUESTS);
    expect(appended[0]).toMatchObject({ failure: 'abandoned' });
    emit('Network.loadingFinished', { requestId: 'p0', timestamp: 101 });
    expect(readAll(events)[0]?.ms).toBeUndefined();
  });

  it('clears pending requests when it starts on a new manager', async () => {
    const { events, emit, source, manager } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('1', 'https://a/'));
    await source.start(manager, events);
    expect(events.networkStats.pending).toBe(0);
    expect(settledReadAll(events)).toStrictEqual([
      expect.objectContaining({ seq: 1, failure: 'target closed' }),
    ]);
  });

  it('finalizes the pending requests of a target that detaches', async () => {
    const { events, emit, detach } = await startSource();
    emit('Network.requestWillBeSent', willBeSent('1', 'https://a/'), PAGE);
    emit('Network.requestWillBeSent', willBeSent('2', 'https://a/'), PAGE);
    emit('Network.requestWillBeSent', willBeSent('3', 'https://a/'));

    // A detach without a target ID cannot be matched safely: leave it.
    detach({ kind: 'page' });
    expect(events.networkStats.pending).toBe(3);

    detach({ kind: 'page', targetId: PAGE.targetId });
    expect(events.networkStats.pending).toBe(1);
    expect(readAll(events)).toStrictEqual([
      expect.objectContaining({ seq: 1, failure: 'target closed' }),
      expect.objectContaining({ seq: 2, failure: 'target closed' }),
      expect.objectContaining({ seq: 3 }),
    ]);
    expect(readAll(events)[2]).not.toHaveProperty('failure');
    // The finalized requests are settled; the one of the live worker is not.
    expect(settledReadAll(events).map((record) => record.seq)).toStrictEqual([
      1, 2,
    ]);
  });

  describe('rpcError', () => {
    /**
     * Sends one finished JSON-RPC request through a source.
     *
     * @param emit - The source emitter.
     * @param requestId - The request ID.
     * @param finished - Extra `loadingFinished` parameters.
     */
    function rpcRequest(
      emit: (method: string, params: Record<string, unknown>) => void,
      requestId: string,
      finished: Record<string, unknown> = {},
    ): void {
      emit(
        'Network.requestWillBeSent',
        willBeSent(requestId, 'https://rpc.example/', {
          request: {
            method: 'POST',
            postData: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}',
          },
        }),
      );
      emit('Network.loadingFinished', { requestId, ...finished });
    }

    it('is not read by default', async () => {
      const send = vi.fn();
      const { emit } = await startSource(send);
      rpcRequest(emit, '1');
      expect(send).not.toHaveBeenCalled();
    });

    it('reads JSON-RPC bodies when configured, plain and base64', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'execution reverted' },
      });
      const send = vi
        .fn()
        .mockResolvedValueOnce({ body })
        .mockResolvedValueOnce({
          body: Buffer.from(body).toString('base64'),
          base64Encoded: true,
        })
        .mockResolvedValueOnce({ body: '{"result":"0x1"}' })
        .mockResolvedValueOnce({});
      const { events, emit } = await startSource(send);
      events.config = { ...events.config, rpcErrors: true };

      rpcRequest(emit, '1');
      rpcRequest(emit, '2');
      rpcRequest(emit, '3');
      rpcRequest(emit, '4');
      // Not JSON-RPC: never read.
      emit('Network.requestWillBeSent', willBeSent('5', 'https://a/'));
      emit('Network.loadingFinished', { requestId: '5' });
      await vi.waitFor(() =>
        expect(readAll(events)[1]?.rpcError).toBeDefined(),
      );

      expect(send).toHaveBeenCalledTimes(4);
      expect(send).toHaveBeenCalledWith(
        SW,
        'Network.getResponseBody',
        { requestId: '1' },
        { timeoutMs: RPC_RESPONSE_READ_TIMEOUT_MS },
      );
      expect(readAll(events).map((record) => record.rpcError)).toStrictEqual([
        { code: -32000, message: 'execution reverted' },
        { code: -32000, message: 'execution reverted' },
        undefined,
        undefined,
        undefined,
      ]);
      expect(events.networkStats.rpcErrorsSkipped).toBe(0);
    });

    it('settles the record after its rpcError read, not before', async () => {
      let resolveRead!: (value: unknown) => void;
      const send = vi.fn(
        async () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );
      const { events, emit } = await startSource(send);
      events.config = { ...events.config, rpcErrors: true };

      rpcRequest(emit, '1');
      expect(readAll(events)[0]?.settledSeq).toBeUndefined();
      // A filtered read (settled) leaves the record out until its final
      // rpcError is known.
      expect(settledReadAll(events)).toStrictEqual([]);

      resolveRead({ body: '{"error":{"code":-1,"message":"boom"}}' });
      await vi.waitFor(() =>
        expect(readAll(events)[0]?.settledSeq).toBeDefined(),
      );
      expect(readAll(events)[0]?.rpcError).toStrictEqual({
        code: -1,
        message: 'boom',
      });
      expect(settledReadAll(events)).toStrictEqual([
        expect.objectContaining({
          seq: 1,
          rpcError: { code: -1, message: 'boom' },
        }),
      ]);
    });

    it('settles a record whose rpcError read is skipped', async () => {
      const send = vi.fn();
      const { events, emit } = await startSource(send);
      events.config = { ...events.config, rpcErrors: true };

      rpcRequest(emit, '1', { encodedDataLength: MAX_RPC_RESPONSE_BYTES + 1 });

      expect(send).not.toHaveBeenCalled();
      expect(events.networkStats.rpcErrorsSkipped).toBe(1);
      expect(settledReadAll(events)).toStrictEqual([
        expect.objectContaining({ seq: 1, settledSeq: 2 }),
      ]);
    });

    it('bounds the body by decoded bytes, not the encoded length', async () => {
      const send = vi.fn().mockResolvedValue({ body: '{"result":"0x1"}' });
      const { events, emit } = await startSource(send);
      events.config = { ...events.config, rpcErrors: true };
      const postData = '{"jsonrpc":"2.0","id":1,"method":"eth_call"}';
      const start = (requestId: string): void => {
        emit(
          'Network.requestWillBeSent',
          willBeSent(requestId, 'https://rpc.example/', {
            request: { method: 'POST', postData },
          }),
        );
      };

      start('big');
      emit('Network.dataReceived', {
        requestId: 'big',
        dataLength: MAX_RPC_RESPONSE_BYTES + 1,
      });
      emit('Network.loadingFinished', {
        requestId: 'big',
        encodedDataLength: 1,
      });

      start('compressed');
      emit('Network.dataReceived', { requestId: 'compressed', dataLength: 10 });
      emit('Network.loadingFinished', {
        requestId: 'compressed',
        encodedDataLength: MAX_RPC_RESPONSE_BYTES + 1,
      });

      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenCalledWith(
        SW,
        'Network.getResponseBody',
        { requestId: 'compressed' },
        { timeoutMs: RPC_RESPONSE_READ_TIMEOUT_MS },
      );
      expect(events.networkStats.rpcErrorsSkipped).toBe(1);
    });

    it('skips large, failing and concurrent reads and counts them', async () => {
      const resolvers: ((value: unknown) => void)[] = [];
      const send = vi.fn(
        async () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const { events, emit } = await startSource(send);
      events.config = { ...events.config, rpcErrors: true };

      rpcRequest(emit, 'big', {
        encodedDataLength: MAX_RPC_RESPONSE_BYTES + 1,
      });
      for (let index = 0; index < MAX_CONCURRENT_RPC_READS + 1; index++) {
        rpcRequest(emit, `c${index}`);
      }
      expect(send).toHaveBeenCalledTimes(MAX_CONCURRENT_RPC_READS);
      expect(events.networkStats.rpcErrorsSkipped).toBe(2);

      resolvers[0]?.({ body: 'x'.repeat(MAX_RPC_RESPONSE_BYTES + 1) });
      for (const resolve of resolvers.slice(1)) {
        resolve({ body: '{}' });
      }
      await vi.waitFor(() =>
        expect(events.networkStats.rpcErrorsSkipped).toBe(3),
      );

      send.mockRejectedValueOnce(
        new Error('No resource with given identifier'),
      );
      rpcRequest(emit, 'gone');
      await vi.waitFor(() =>
        expect(events.networkStats.rpcErrorsSkipped).toBe(4),
      );
    });
  });
});
