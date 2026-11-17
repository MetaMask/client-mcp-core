import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachNetworkLog,
  extractRpcError,
  isSecretUrlSegment,
  MAX_CONSOLE_TEXT_LENGTH,
  MAX_LOGGED_URL_LENGTH,
  MAX_RPC_BATCH_METHODS,
  MAX_RPC_RESPONSE_BYTES,
  NetworkLogRecorder,
  networkLogTool,
  parseSince,
  readRpcMethod,
  redactUrl,
  redactUrlsInText,
} from './network-log.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

const INFURA_KEY = '0123456789abcdef0123456789abcdef';

type MockRequestOptions = {
  method?: string;
  body?: string | Buffer | null;
  resourceType?: string;
  serviceWorker?: boolean;
  timing?: { startTime: number; responseEnd: number } | null;
  pageUrl?: string;
  frameUrl?: string;
  frameThrows?: boolean;
  failure?: string;
  postDataThrows?: boolean;
};

function createMockRequest(url: string, options: MockRequestOptions = {}) {
  const page = {
    url: () => options.pageUrl ?? 'chrome-extension://abc/home.html',
  };
  const mainFrame = { url: () => page.url(), page: () => page };
  const frame = options.frameUrl
    ? { url: () => options.frameUrl, page: () => page }
    : mainFrame;
  Object.assign(page, { mainFrame: () => mainFrame });
  const body =
    typeof options.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : (options.body ?? null);
  return {
    url: () => url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'fetch',
    postDataBuffer: () => {
      if (options.postDataThrows) {
        throw new Error('no body');
      }
      return body;
    },
    serviceWorker: () => (options.serviceWorker ? {} : null),
    timing: () =>
      options.timing === null
        ? (() => {
            throw new Error('no timing');
          })()
        : (options.timing ?? { startTime: 1_000, responseEnd: 250.4 }),
    frame: () => {
      if (options.frameThrows || options.serviceWorker) {
        throw new Error('no frame');
      }
      return frame;
    },
    failure: () =>
      options.failure === undefined ? null : { errorText: options.failure },
  };
}

type MockRequest = ReturnType<typeof createMockRequest>;

function createMockResponse(
  request: MockRequest,
  status: number,
  options: {
    body?: string | (() => Promise<Buffer>);
    headers?: Record<string, string>;
  } = {},
) {
  return {
    request: () => request,
    status: () => status,
    headers: () => options.headers ?? {},
    body:
      typeof options.body === 'function'
        ? options.body
        : async () => Buffer.from(options.body ?? '', 'utf8'),
  };
}

function createMockConsoleMessage(
  type: string,
  text: string,
  options: {
    workerUrl?: string;
    pageUrl?: string | null;
    location?: { url: string; lineNumber: number; columnNumber: number };
    noWorkerMethod?: boolean;
  } = {},
) {
  const message: Record<string, unknown> = {
    type: () => type,
    text: () => text,
    page: () =>
      options.pageUrl === null
        ? null
        : { url: () => options.pageUrl ?? 'chrome-extension://abc/home.html' },
    location: () =>
      options.location ?? { url: '', lineNumber: 0, columnNumber: 0 },
  };
  if (!options.noWorkerMethod) {
    message.worker = () =>
      options.workerUrl ? { url: () => options.workerUrl } : null;
  }
  return message;
}

class MockBrowserContext extends EventEmitter {
  async finish(
    request: MockRequest,
    status: number,
    responseOptions: Parameters<typeof createMockResponse>[2] = {},
  ): Promise<void> {
    this.emit('request', request);
    this.emit('response', createMockResponse(request, status, responseOptions));
    this.emit('requestfinished', request);
    await flush();
  }

  async fail(request: MockRequest): Promise<void> {
    this.emit('request', request);
    this.emit('requestfailed', request);
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
}

function createRecorder(
  options: ConstructorParameters<typeof NetworkLogRecorder>[1] = {},
) {
  const browserContext = new MockBrowserContext();
  const recorder = new NetworkLogRecorder(browserContext as never, options);
  return { browserContext, recorder };
}

function createMockContext(
  options: { hasActive?: boolean; browserContext?: MockBrowserContext } = {},
): ToolContext {
  const sessionManager = createMockSessionManager({
    hasActive: options.hasActive ?? true,
  });
  sessionManager.getContext.mockReturnValue(
    options.browserContext ?? new MockBrowserContext(),
  );
  return {
    sessionManager,
    page: {},
    refMap: new Map(),
    workflowContext: {},
    toolRegistry: new Map(),
  } as unknown as ToolContext;
}

describe('NetworkLogRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a finished request with status, timing and source', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest('https://gas.api.cx.metamask.io/networks/1/fees', {
        serviceWorker: true,
      }),
      200,
    );

    expect(recorder.readRequests({}).requests).toStrictEqual([
      {
        seq: 1,
        t: 1_000,
        method: 'GET',
        url: 'https://gas.api.cx.metamask.io/networks/1/fees',
        type: 'fetch',
        status: 200,
        ms: 250,
        source: 'service-worker',
      },
    ]);
  });

  it('records page requests with the page and frame URL', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest('https://example.com/a', {
        pageUrl: 'https://dapp.example/',
      }),
      200,
    );
    await browserContext.finish(
      createMockRequest('https://example.com/b', {
        pageUrl: 'https://dapp.example/',
        frameUrl: 'https://iframe.example/',
      }),
      200,
    );
    await browserContext.finish(
      createMockRequest('https://example.com/c', { frameThrows: true }),
      200,
    );

    const records = recorder.readRequests({}).requests;
    expect(records[0]).toMatchObject({
      source: 'page',
      pageUrl: 'https://dapp.example/',
    });
    expect(records[0]).not.toHaveProperty('frameUrl');
    expect(records[1]).toMatchObject({
      source: 'page',
      frameUrl: 'https://iframe.example/',
    });
    expect(records[2]).toStrictEqual(
      expect.objectContaining({ source: 'page' }),
    );
    expect(records[2]).not.toHaveProperty('pageUrl');
  });

  it('records a failed request with its failure text and no status', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.fail(
      createMockRequest('https://security-alerts.api.cx.metamask.io/x', {
        failure: 'net::ERR_ABORTED',
        serviceWorker: true,
      }),
    );
    await browserContext.fail(
      createMockRequest('https://example.com/unknown', {}),
    );

    const [aborted, unknown] = recorder.readRequests({}).requests;
    expect(aborted).toMatchObject({ failure: 'net::ERR_ABORTED' });
    expect(aborted).not.toHaveProperty('status');
    expect(unknown).toMatchObject({ failure: 'failed' });
  });

  it('falls back to wall-clock timing when Playwright has none', async () => {
    const { browserContext, recorder } = createRecorder();
    const request = createMockRequest('https://example.com/', {
      timing: null,
    });
    browserContext.emit('request', request);
    vi.setSystemTime(5_120);
    browserContext.emit('requestfinished', request);
    await flush();

    expect(recorder.readRequests({}).requests[0]).toMatchObject({
      t: 5_000,
      ms: 120,
    });
  });

  it('uses the finish time when the request start was not seen', async () => {
    const { browserContext, recorder } = createRecorder();
    browserContext.emit(
      'requestfinished',
      createMockRequest('https://example.com/', {
        timing: { startTime: 0, responseEnd: -1 },
      }),
    );
    await flush();

    expect(recorder.readRequests({}).requests[0]).toMatchObject({
      t: 5_000,
      ms: 0,
    });
    expect(recorder.getSummary().requests.pending).toBe(0);
  });

  it('ignores non-http requests and counts them', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest('chrome-extension://abc/scripts/app.js'),
      200,
    );
    await browserContext.finish(createMockRequest('data:text/plain,hi'), 200);
    await browserContext.finish(createMockRequest('not a url'), 200);

    expect(recorder.readRequests({}).requests).toHaveLength(0);
    expect(recorder.getSummary().requests.ignored).toBe(3);
  });

  it('parses single and batch JSON-RPC methods', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest(`https://mainnet.infura.io/v3/${INFURA_KEY}`, {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
      }),
      200,
    );
    await browserContext.finish(
      createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
          { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [] },
        ]),
      }),
      200,
    );

    const [single, batch] = recorder.readRequests({}).requests;
    expect(single).toMatchObject({
      url: 'https://mainnet.infura.io/v3/[REDACTED]',
      rpcMethod: 'eth_blockNumber',
    });
    expect(batch).toMatchObject({
      rpcMethod: ['eth_chainId', 'eth_getBalance'],
      rpcBatchSize: 2,
    });
  });

  it('does not read JSON-RPC errors by default', async () => {
    const { browserContext, recorder } = createRecorder();
    const body = vi.fn();
    await browserContext.finish(
      createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}',
      }),
      200,
      { body },
    );

    expect(body).not.toHaveBeenCalled();
    expect(recorder.readRequests({}).requests[0]).not.toHaveProperty(
      'rpcError',
    );
  });

  it('records JSON-RPC errors when rpcErrors is on', async () => {
    const { browserContext, recorder } = createRecorder();
    recorder.configure({ rpcErrors: true });
    await browserContext.finish(
      createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}',
      }),
      200,
      {
        body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}',
      },
    );
    await browserContext.finish(
      createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":2,"method":"eth_chainId"}',
      }),
      200,
      { body: '{"jsonrpc":"2.0","id":2,"result":"0x1"}' },
    );
    await browserContext.finish(
      createMockRequest('https://example.com/not-rpc', { method: 'POST' }),
      200,
      { body: '{"error":{"message":"ignored"}}' },
    );

    const [failed, ok, notRpc] = recorder.readRequests({}).requests;
    expect(failed.rpcError).toStrictEqual({
      code: -32000,
      message: 'execution reverted',
    });
    expect(ok).not.toHaveProperty('rpcError');
    expect(notRpc).not.toHaveProperty('rpcError');
    expect(recorder.readRequests({ errors: true }).requests).toStrictEqual([
      failed,
    ]);
  });

  it('skips JSON-RPC bodies that are too large, unreadable or slow', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { browserContext, recorder } = createRecorder();
    recorder.configure({ rpcErrors: true });
    const rpc = (): MockRequest =>
      createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs"}',
      });

    await browserContext.finish(rpc(), 200, {
      headers: { 'content-length': String(MAX_RPC_RESPONSE_BYTES + 1) },
    });
    await browserContext.finish(rpc(), 200, {
      body: 'x'.repeat(MAX_RPC_RESPONSE_BYTES + 1),
    });
    await browserContext.finish(rpc(), 200, {
      body: async () => {
        throw new Error('body gone');
      },
    });
    await browserContext.finish(rpc(), 200, { body: 'not json' });

    const slow = rpc();
    browserContext.emit('request', slow);
    browserContext.emit(
      'response',
      createMockResponse(slow, 200, {
        body: async () => new Promise<Buffer>(() => undefined),
      }),
    );
    browserContext.emit('requestfinished', slow);
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    const records = recorder.readRequests({}).requests;
    expect(records).toHaveLength(5);
    expect(records.every((record) => record.rpcError === undefined)).toBe(true);
    expect(recorder.getSummary().rpcErrorsSkipped).toBe(3);
  });

  it('limits concurrent JSON-RPC body reads', async () => {
    const { browserContext, recorder } = createRecorder();
    recorder.configure({ rpcErrors: true });
    const resolvers: ((body: Buffer) => void)[] = [];
    for (let index = 0; index < 9; index++) {
      const request = createMockRequest('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}',
      });
      browserContext.emit('request', request);
      browserContext.emit(
        'response',
        createMockResponse(request, 200, {
          body: async () =>
            new Promise<Buffer>((resolve) => resolvers.push(resolve)),
        }),
      );
      browserContext.emit('requestfinished', request);
    }
    await flush();
    expect(resolvers).toHaveLength(8);
    expect(recorder.getSummary().rpcErrorsSkipped).toBe(1);

    for (const resolve of resolvers) {
      resolve(Buffer.from('{"error":{"code":1,"message":"x"}}'));
    }
    await flush();
    expect(recorder.readRequests({ errors: true }).requests).toHaveLength(8);
  });

  it('records only error console messages by default', () => {
    const { browserContext, recorder } = createRecorder();
    browserContext.emit(
      'console',
      createMockConsoleMessage('error', 'boom', {
        workerUrl: 'chrome-extension://abc/scripts/app-init.js',
        location: {
          url: 'chrome-extension://abc/scripts/app-init.js',
          lineNumber: 10,
          columnNumber: 4,
        },
      }),
    );
    browserContext.emit(
      'console',
      createMockConsoleMessage('warning', 'careful'),
    );
    browserContext.emit('console', createMockConsoleMessage('log', 'noise'));
    browserContext.emit('console', createMockConsoleMessage('assert', 'bad'));

    expect(recorder.readConsole({}).messages).toStrictEqual([
      {
        seq: 1,
        t: 5_000,
        level: 'error',
        text: 'boom',
        source: 'service-worker',
        sourceUrl: 'chrome-extension://abc/scripts/app-init.js',
        location: 'chrome-extension://abc/scripts/app-init.js:10:4',
      },
      {
        seq: 2,
        t: 5_000,
        level: 'error',
        text: 'bad',
        source: 'page',
        sourceUrl: 'chrome-extension://abc/home.html',
      },
    ]);
  });

  it('records configured console levels and handles old Playwright messages', () => {
    const { browserContext, recorder } = createRecorder();
    recorder.configure({
      consoleLevels: ['warning', 'log', 'info', 'debug', 'log'],
    });
    browserContext.emit(
      'console',
      createMockConsoleMessage('warning', 'careful'),
    );
    browserContext.emit(
      'console',
      createMockConsoleMessage('log', 'hello', { noWorkerMethod: true }),
    );
    browserContext.emit(
      'console',
      createMockConsoleMessage('info', 'i', { pageUrl: null }),
    );
    browserContext.emit('console', createMockConsoleMessage('debug', 'd'));
    browserContext.emit('console', createMockConsoleMessage('table', 't'));
    browserContext.emit('console', createMockConsoleMessage('error', 'e'));

    expect(recorder.getConfig().consoleLevels).toStrictEqual([
      'warning',
      'log',
      'info',
      'debug',
    ]);
    expect(
      recorder.readConsole({}).messages.map(({ level, text }) => [level, text]),
    ).toStrictEqual([
      ['warning', 'careful'],
      ['log', 'hello'],
      ['info', 'i'],
      ['debug', 'd'],
      ['log', 't'],
    ]);
    expect(recorder.readConsole({}).messages[2]).not.toHaveProperty(
      'sourceUrl',
    );
  });

  it('falls back to the page when reading the worker throws', () => {
    const { browserContext, recorder } = createRecorder();
    const message = createMockConsoleMessage('error', 'x');
    message.worker = () => {
      throw new Error('gone');
    };
    message.location = () => {
      throw new Error('gone');
    };
    browserContext.emit('console', message);

    expect(recorder.readConsole({}).messages[0]).toMatchObject({
      source: 'page',
    });
  });

  it('truncates and redacts console text', () => {
    const { browserContext, recorder } = createRecorder();
    browserContext.emit(
      'console',
      createMockConsoleMessage(
        'error',
        `fetch https://mainnet.infura.io/v3/${INFURA_KEY} failed ${'x'.repeat(
          MAX_CONSOLE_TEXT_LENGTH,
        )}`,
      ),
    );

    const { text } = recorder.readConsole({}).messages[0];
    expect(text).toContain('https://mainnet.infura.io/v3/[REDACTED] failed');
    expect(text).not.toContain(INFURA_KEY);
    expect(text).toHaveLength(MAX_CONSOLE_TEXT_LENGTH + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('records uncaught page errors as errors', () => {
    const { browserContext, recorder } = createRecorder();
    browserContext.emit('weberror', {
      error: () => new TypeError('x is undefined'),
      page: () => ({ url: () => 'https://dapp.example/' }),
    });
    browserContext.emit('weberror', {
      error: () => new Error('no page'),
      page: () => null,
    });
    recorder.configure({ consoleLevels: ['warning'] });
    browserContext.emit('weberror', {
      error: () => new Error('not recorded'),
      page: () => null,
    });

    expect(recorder.readConsole({}).messages).toStrictEqual([
      {
        seq: 1,
        t: 5_000,
        level: 'error',
        text: 'Uncaught TypeError: x is undefined',
        source: 'page',
        sourceUrl: 'https://dapp.example/',
        uncaught: true,
      },
      {
        seq: 2,
        t: 5_000,
        level: 'error',
        text: 'Uncaught Error: no page',
        source: 'page',
        uncaught: true,
      },
    ]);
  });

  it('drops the oldest records past the limit and counts them', async () => {
    const { browserContext, recorder } = createRecorder({
      maxNetworkRecords: 2,
      maxConsoleRecords: 1,
    });
    for (const path of ['a', 'b', 'c']) {
      await browserContext.finish(
        createMockRequest(`https://example.com/${path}`),
        200,
      );
    }
    browserContext.emit('console', createMockConsoleMessage('error', '1'));
    browserContext.emit('console', createMockConsoleMessage('error', '2'));

    expect(
      recorder.readRequests({}).requests.map((record) => record.url),
    ).toStrictEqual(['https://example.com/b', 'https://example.com/c']);
    expect(recorder.readConsole({}).messages.map((m) => m.text)).toStrictEqual([
      '2',
    ]);
    expect(recorder.getSummary()).toMatchObject({
      cursor: 5,
      requests: { kept: 2, total: 3, dropped: 1, max: 2 },
      console: { kept: 1, total: 2, dropped: 1, max: 1 },
    });
    expect(recorder.readRequests({ cursor: 0 }).gap).toBe(true);
    expect(recorder.readRequests({ cursor: 1 }).gap).toBeUndefined();
    expect(recorder.readConsole({ cursor: 3 }).gap).toBe(true);
  });

  it('reads incrementally with a cursor and pages with limit', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest('https://example.com/1'),
      200,
    );
    const mark = recorder.getCursor();
    for (const path of ['2', '3', '4']) {
      await browserContext.finish(
        createMockRequest(`https://example.com/${path}`),
        200,
      );
    }
    browserContext.emit('console', createMockConsoleMessage('error', 'e'));

    const firstPage = recorder.readRequests({ cursor: mark, limit: 2 });
    expect(firstPage.requests.map((record) => record.seq)).toStrictEqual([
      2, 3,
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.cursor).toBe(3);

    const secondPage = recorder.readRequests({
      cursor: firstPage.cursor,
      limit: 2,
    });
    expect(secondPage.requests.map((record) => record.seq)).toStrictEqual([4]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.cursor).toBe(5);

    expect(recorder.readConsole({ cursor: mark }).messages).toHaveLength(1);
    expect(recorder.readRequests({ cursor: 5 }).requests).toHaveLength(0);
  });

  it('returns the newest records without a cursor', async () => {
    const { browserContext, recorder } = createRecorder();
    for (const path of ['1', '2', '3']) {
      await browserContext.finish(
        createMockRequest(`https://example.com/${path}`),
        200,
      );
    }

    const result = recorder.readRequests({ limit: 2 });
    expect(result.requests.map((record) => record.seq)).toStrictEqual([2, 3]);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe(3);
    expect(result).not.toHaveProperty('gap');
  });

  it('filters by since, url and errors', async () => {
    const { browserContext, recorder } = createRecorder();
    recorder.configure({ consoleLevels: ['error', 'warning'] });
    await browserContext.finish(
      createMockRequest('https://a.example/ok', {
        timing: { startTime: 1_000, responseEnd: 1 },
      }),
      200,
    );
    await browserContext.finish(
      createMockRequest('https://b.example/missing', {
        timing: { startTime: 2_000, responseEnd: 1 },
      }),
      404,
    );
    browserContext.emit(
      'console',
      createMockConsoleMessage('warning', 'w', {
        pageUrl: 'https://dapp.example/',
      }),
    );
    browserContext.emit('console', createMockConsoleMessage('error', 'e'));

    expect(
      recorder.readRequests({ since: 1_500 }).requests.map((r) => r.url),
    ).toStrictEqual(['https://b.example/missing']);
    expect(
      recorder
        .readRequests({ since: new Date(1_500).toISOString() })
        .requests.map((r) => r.url),
    ).toStrictEqual(['https://b.example/missing']);
    expect(
      recorder.readRequests({ url: 'a.example' }).requests.map((r) => r.url),
    ).toStrictEqual(['https://a.example/ok']);
    expect(
      recorder
        .readRequests({ url: 'https://*.example/**' })
        .requests.map((r) => r.url),
    ).toHaveLength(2);
    expect(
      recorder.readRequests({ errors: true }).requests.map((r) => r.status),
    ).toStrictEqual([404]);
    expect(
      recorder.readConsole({ errors: true }).messages.map((m) => m.text),
    ).toStrictEqual(['e']);
    expect(
      recorder.readConsole({ url: 'dapp.example' }).messages.map((m) => m.text),
    ).toStrictEqual(['w']);
  });

  it('removes returned records with clear and keeps the cursor counting', async () => {
    const { browserContext, recorder } = createRecorder();
    for (const path of ['1', '2', '3']) {
      await browserContext.finish(
        createMockRequest(`https://example.com/${path}`),
        200,
      );
    }

    const drained = recorder.readRequests({ clear: true, limit: 2, cursor: 0 });
    expect(drained.requests.map((record) => record.seq)).toStrictEqual([1, 2]);
    expect(recorder.readRequests({}).requests.map((r) => r.seq)).toStrictEqual([
      3,
    ]);
    expect(
      recorder.readRequests({ clear: true, url: 'nothing' }).requests,
    ).toHaveLength(0);

    recorder.clear();
    expect(recorder.readRequests({}).requests).toHaveLength(0);
    await browserContext.finish(
      createMockRequest('https://example.com/4'),
      200,
    );
    expect(recorder.readRequests({}).requests[0].seq).toBe(4);
  });

  it('never throws from a listener', async () => {
    const { browserContext, recorder } = createRecorder();
    const broken = {
      ...createMockRequest('https://example.com/'),
      method: () => {
        throw new Error('request disposed');
      },
    };
    browserContext.emit('request', broken);
    browserContext.emit('requestfinished', broken);
    browserContext.emit('requestfailed', broken);
    browserContext.emit('weberror', {
      error: () => new Error('page gone'),
      page: () => ({
        url: () => {
          throw new Error('closed');
        },
      }),
    });
    await flush();

    expect(recorder.readRequests({}).requests).toHaveLength(0);
    expect(recorder.readConsole({}).messages).toHaveLength(1);
  });

  it('keeps recording across pages and service worker restarts', async () => {
    const { browserContext, recorder } = createRecorder();
    await browserContext.finish(
      createMockRequest('https://example.com/before', { serviceWorker: true }),
      200,
    );
    browserContext.emit('serviceworker', {});
    browserContext.emit('page', {});
    await browserContext.finish(
      createMockRequest('https://example.com/after', { serviceWorker: true }),
      200,
    );

    expect(recorder.readRequests({}).requests).toHaveLength(2);
  });
});

describe('attachNetworkLog', () => {
  it('returns one recorder per browser context', () => {
    const browserContext = new MockBrowserContext();
    const first = attachNetworkLog(browserContext as never);
    const second = attachNetworkLog(browserContext as never);

    expect(second).toBe(first);
    expect(browserContext.listenerCount('requestfinished')).toBe(1);
  });
});

describe('networkLogTool', () => {
  it('returns an error without an active session', async () => {
    const result = await networkLogTool(
      { action: 'requests' },
      createMockContext({ hasActive: false }),
    );

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: ErrorCodes.MM_NO_ACTIVE_SESSION,
        message: 'No active session. Call launch first.',
      },
    });
  });

  it('returns summary.startedAt from mark and every read, new after a relaunch', async () => {
    const browserContext = new MockBrowserContext();
    const context = createMockContext({ browserContext });
    const startedAt = (result: unknown): string =>
      (result as { result: { summary: { startedAt: string } } }).result.summary
        .startedAt;

    const mark = await networkLogTool({ action: 'mark' }, context);
    const requests = await networkLogTool({ action: 'requests' }, context);
    const messages = await networkLogTool({ action: 'console' }, context);

    expect(startedAt(mark)).toStrictEqual(expect.any(String));
    expect(startedAt(requests)).toBe(startedAt(mark));
    expect(startedAt(messages)).toBe(startedAt(mark));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(startedAt(mark)) + 60_000);
    const relaunched = createMockContext({
      browserContext: new MockBrowserContext(),
    });
    const afterRelaunch = await networkLogTool(
      { action: 'requests' },
      relaunched,
    );
    vi.useRealTimers();

    expect(startedAt(afterRelaunch)).not.toBe(startedAt(mark));
  });

  it('marks, reads, configures and clears', async () => {
    const browserContext = new MockBrowserContext();
    const context = createMockContext({ browserContext });

    const mark = await networkLogTool({ action: 'mark' }, context);
    expect(mark).toMatchObject({
      ok: true,
      result: { action: 'mark', cursor: 0 },
    });

    await browserContext.finish(createMockRequest('https://example.com/'), 500);
    browserContext.emit('console', createMockConsoleMessage('error', 'e'));

    const requests = await networkLogTool(
      { action: 'requests', cursor: 0 },
      context,
    );
    expect(requests).toMatchObject({
      ok: true,
      result: {
        action: 'requests',
        requests: [{ url: 'https://example.com/', status: 500 }],
        cursor: 2,
        hasMore: false,
        summary: { cursor: 2 },
      },
    });

    const messages = await networkLogTool(
      { action: 'console', cursor: 0 },
      context,
    );
    expect(messages).toMatchObject({
      ok: true,
      result: { action: 'console', messages: [{ text: 'e' }], cursor: 2 },
    });

    const configure = await networkLogTool(
      { action: 'configure', rpcErrors: true },
      context,
    );
    expect(configure).toMatchObject({
      ok: true,
      result: {
        action: 'configure',
        config: { consoleLevels: ['error'], rpcErrors: true },
      },
    });

    const clear = await networkLogTool({ action: 'clear' }, context);
    expect(clear).toMatchObject({
      ok: true,
      result: {
        action: 'clear',
        cleared: true,
        summary: { requests: { kept: 0 }, console: { kept: 0 } },
      },
    });
  });
});

describe('redactUrl', () => {
  it.each([
    [
      `https://mainnet.infura.io/v3/${INFURA_KEY}`,
      'https://mainnet.infura.io/v3/[REDACTED]',
    ],
    [
      `wss://linea-mainnet.infura.io/ws/v3/${INFURA_KEY}`,
      'wss://linea-mainnet.infura.io/ws/v3/[REDACTED]',
    ],
    [`https://${INFURA_KEY}.rpc.example/`, 'https://[REDACTED].rpc.example/'],
    [
      'https://api.example/x?apiKey=abc&chainId=1&token=t&x-api-key=k&flag',
      'https://api.example/x?apiKey=[REDACTED]&chainId=1&token=[REDACTED]&x-api-key=[REDACTED]&flag',
    ],
    [
      'https://user:pass@api.example/path#frag',
      'https://api.example/path#frag',
    ],
    ['https://api.example/x?%E0%A4%A=1', 'https://api.example/x?%E0%A4%A=1'],
    [
      'https://accounts.api.cx.metamask.io/v4/multiaccount/transactions?accountAddresses=0x5cfe73b6021e818b776b421b1c4db2474086a7e1',
      'https://accounts.api.cx.metamask.io/v4/multiaccount/transactions?accountAddresses=0x5cfe73b6021e818b776b421b1c4db2474086a7e1',
    ],
    ['not a url', 'not a url'],
  ])('redacts %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });

  it('keeps addresses, hashes and UUIDs in paths', () => {
    const url =
      'https://api.example/0x5cfe73b6021e818b776b421b1c4db2474086a7e1/123e4567-e89b-12d3-a456-426614174000';
    expect(redactUrl(url)).toBe(url);
  });

  it('cuts long URLs', () => {
    const url = `https://api.example/?q=${'a'.repeat(MAX_LOGGED_URL_LENGTH)}`;
    expect(redactUrl(url)).toHaveLength(MAX_LOGGED_URL_LENGTH + 1);
  });

  it('redacts every URL in a text', () => {
    expect(
      redactUrlsInText(
        `a https://x.example/v3/${INFURA_KEY} b https://y.example/?key=1`,
      ),
    ).toBe(
      'a https://x.example/v3/[REDACTED] b https://y.example/?key=[REDACTED]',
    );
  });
});

describe('isSecretUrlSegment', () => {
  it.each([
    [INFURA_KEY, true],
    ['AbCdEfGh1234567890IjKlMnOp', true],
    ['multiaccount', false],
    ['supportedNetworks', false],
    ['0x5cfe73b6021e818b776b421b1c4db2474086a7e1', false],
    ['123e4567-e89b-12d3-a456-426614174000', false],
    ['abcdefghijklmnopqrstuvwxyz', false],
  ])('%s -> %s', (segment, expected) => {
    expect(isSecretUrlSegment(segment)).toBe(expected);
  });
});

describe('readRpcMethod', () => {
  const request = (body: string | Buffer | null, method = 'POST') => {
    const mock = createMockRequest('https://rpc.example/', { method, body });
    return mock;
  };

  it('ignores GET requests, empty, large and non-JSON bodies', () => {
    expect(
      readRpcMethod(request('{"method":"x","id":1}', 'GET')),
    ).toBeUndefined();
    expect(readRpcMethod(request(null))).toBeUndefined();
    expect(
      readRpcMethod(request(Buffer.alloc(256 * 1024 + 1, 0x20))),
    ).toBeUndefined();
    expect(readRpcMethod(request('method=eth_call'))).toBeUndefined();
    expect(readRpcMethod(request('{bad json'))).toBeUndefined();
    expect(
      readRpcMethod(
        createMockRequest('https://rpc.example/', {
          method: 'POST',
          postDataThrows: true,
        }),
      ),
    ).toBeUndefined();
  });

  it('needs a JSON-RPC shape', () => {
    expect(readRpcMethod(request('{"method":"track"}'))).toBeUndefined();
    expect(readRpcMethod(request('[1,{"event":"x"}]'))).toBeUndefined();
    expect(readRpcMethod(request('{"method":1,"id":1}'))).toBeUndefined();
    expect(readRpcMethod(request('{"method":"x","params":[]}'))).toStrictEqual({
      rpcMethod: 'x',
    });
  });

  it('caps batch methods', () => {
    const batch = Array.from(
      { length: MAX_RPC_BATCH_METHODS + 5 },
      (_, id) => ({ jsonrpc: '2.0', id, method: `m${id}` }),
    );
    const result = readRpcMethod(request(JSON.stringify(batch)));
    expect(result).toMatchObject({ rpcBatchSize: MAX_RPC_BATCH_METHODS + 5 });
    expect((result as { rpcMethod: string[] }).rpcMethod).toHaveLength(
      MAX_RPC_BATCH_METHODS,
    );
  });
});

describe('extractRpcError', () => {
  it('returns undefined without an error', () => {
    expect(extractRpcError({ result: '0x1' })).toBeUndefined();
    expect(extractRpcError(null)).toBeUndefined();
    expect(extractRpcError([{ result: 1 }, 'x'])).toBeUndefined();
  });

  it('returns the first batch error with the count', () => {
    expect(
      extractRpcError([
        { result: 1 },
        { error: { code: -32601, message: 'method not found' } },
        { error: { message: 7 } },
      ]),
    ).toStrictEqual({ code: -32601, message: 'method not found', count: 2 });
    expect(extractRpcError({ error: {} })).toStrictEqual({
      message: 'unknown error',
    });
  });
});

describe('parseSince', () => {
  it.each([
    [undefined, undefined],
    [1_700_000_000_000, 1_700_000_000_000],
    ['1700000000000', 1_700_000_000_000],
    ['2026-11-17T10:00:00.000Z', Date.parse('2026-11-17T10:00:00.000Z')],
    ['yesterday', undefined],
  ])('parses %s', (input, expected) => {
    expect(parseSince(input)).toBe(expected);
  });
});
