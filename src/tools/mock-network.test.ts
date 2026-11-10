import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_RECORDED_BODY_BYTES,
  findMatchingRule,
  getOriginRoutePattern,
  isSensitiveHeader,
  matchesUrlFilter,
  matchesUrlPattern,
  mockNetworkTool,
  NetworkMockRouteManager,
  recordRequestBody,
  redactHeaders,
  redactJsonValue,
  REDACTED_VALUE,
} from './mock-network.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { NetworkMockRouteRule } from './types';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

const MOCK_RULE: NetworkMockRouteRule = {
  id: 'accounts-supported-networks',
  method: 'GET',
  url: 'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
  response: {
    status: 200,
    json: { fullSupport: [1, 1337], partialSupport: { balances: [] } },
  },
};

const BALANCES_RULE: NetworkMockRouteRule = {
  id: 'accounts-balances',
  method: 'GET',
  url: 'https://accounts.api.cx.metamask.io/v5/multiaccount/balances**',
  response: {
    status: 200,
    json: { count: 0, balances: [], unprocessedNetworks: [] },
  },
};

function createMockBrowserContext() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRoute(
  method: string,
  url: string,
  options: {
    body?: Buffer | string | null;
    headers?: Record<string, string>;
    serviceWorker?: boolean;
  } = {},
) {
  const body =
    typeof options.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : (options.body ?? null);
  return {
    request: vi.fn().mockReturnValue({
      method: vi.fn().mockReturnValue(method),
      url: vi.fn().mockReturnValue(url),
      headers: vi.fn().mockReturnValue(options.headers ?? {}),
      postDataBuffer: vi.fn().mockReturnValue(body),
      serviceWorker: vi.fn().mockReturnValue(options.serviceWorker ? {} : null),
    }),
    continue: vi.fn().mockResolvedValue(undefined),
    fulfill: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(
  options: {
    hasActive?: boolean;
    browserContext?: ReturnType<typeof createMockBrowserContext>;
  } = {},
): ToolContext {
  const sessionManager = createMockSessionManager({
    hasActive: options.hasActive ?? true,
  });
  sessionManager.getContext.mockReturnValue(
    options.browserContext ?? createMockBrowserContext(),
  );

  return {
    sessionManager,
    page: {},
    refMap: new Map(),
    workflowContext: {
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    },
    toolRegistry: new Map(),
  } as unknown as ToolContext;
}

describe('mockNetworkTool', () => {
  it('adds a mock route rule', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    const result = await mockNetworkTool(
      { action: 'add', rule: MOCK_RULE },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe('add');
      expect(result.result.added).toBe(1);
      expect(result.result.rules).toStrictEqual([MOCK_RULE]);
    }
    expect(browserContext.route).toHaveBeenCalledWith(
      'https://accounts.api.cx.metamask.io/**',
      expect.any(Function),
    );
  });

  it('clears mock routes', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    await mockNetworkTool({ action: 'add', rule: MOCK_RULE }, context);
    const result = await mockNetworkTool({ action: 'clear' }, context);

    expect(result.ok).toBe(true);
    expect(browserContext.unroute).toHaveBeenCalledWith(
      'https://accounts.api.cx.metamask.io/**',
      expect.any(Function),
    );
  });

  it('lists mock routes', async () => {
    const context = createMockContext();

    await mockNetworkTool({ action: 'add', rule: MOCK_RULE }, context);
    const result = await mockNetworkTool({ action: 'list' }, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe('list');
      expect(result.result.rules).toStrictEqual([MOCK_RULE]);
    }
  });

  it('returns request records', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    await mockNetworkTool({ action: 'add', rule: MOCK_RULE }, context);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    await routeHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
      ),
    );

    const result = await mockNetworkTool(
      { action: 'requests', limit: 25 },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe('requests');
      expect(result.result.requests).toHaveLength(1);
      expect(result.result.summary.hits).toBe(1);
    }
  });

  it('returns an error when no session is active', async () => {
    const context = createMockContext({ hasActive: false });

    const result = await mockNetworkTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });
});

describe('NetworkMockRouteManager', () => {
  it('fulfills matching requests and records hits', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(BALANCES_RULE);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'GET',
      'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=0x1',
    );

    await routeHandler(route);

    expect(route.fulfill).toHaveBeenCalledWith({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        count: 0,
        balances: [],
        unprocessedNetworks: [],
      }),
    });
    expect(route.continue).not.toHaveBeenCalled();
    expect(manager.getSummary()).toMatchObject({
      hits: 1,
      misses: 0,
      lastMatchedUrl:
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=0x1',
    });
  });

  it('does not install duplicate route handlers for the same origin', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(BALANCES_RULE);
    await manager.addRule({
      ...BALANCES_RULE,
      id: 'accounts-balances-replacement',
      url: 'https://accounts.api.cx.metamask.io/v4/multiaccount/transactions**',
    });

    expect(browserContext.route).toHaveBeenCalledTimes(1);
  });

  it('unroutes orphaned origin when replacing a rule with a different origin', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(MOCK_RULE);
    expect(browserContext.route).toHaveBeenCalledTimes(1);

    await manager.addRule({
      ...MOCK_RULE,
      url: 'https://other-api.example.com/v1/data',
      response: { status: 200, json: {} },
    });

    expect(browserContext.route).toHaveBeenCalledTimes(2);
    expect(browserContext.unroute).toHaveBeenCalledWith(
      'https://accounts.api.cx.metamask.io/**',
      expect.any(Function),
    );
  });

  it('keeps origin route when another rule still uses it', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(MOCK_RULE);
    await manager.addRule(BALANCES_RULE);
    expect(browserContext.route).toHaveBeenCalledTimes(1);

    await manager.addRule({
      ...MOCK_RULE,
      url: 'https://other-api.example.com/v1/data',
      response: { status: 200, json: {} },
    });

    expect(browserContext.unroute).not.toHaveBeenCalled();
  });

  it('normalizes user header keys to lowercase', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule({
      id: 'header-test',
      method: 'GET',
      url: 'https://accounts.api.cx.metamask.io/headers',
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/xml', 'X-Custom': 'val' },
        json: {},
      },
    });
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'GET',
      'https://accounts.api.cx.metamask.io/headers',
    );

    await routeHandler(route);

    expect(route.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/xml',
          'x-custom': 'val',
        },
      }),
    );
  });

  it('ignores unroute failures while clearing', async () => {
    const browserContext = createMockBrowserContext();
    browserContext.unroute.mockRejectedValue(new Error('already removed'));
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(BALANCES_RULE);
    await manager.clear();

    expect(manager.listRules()).toStrictEqual([]);
  });

  it('continues unmatched same-origin requests and records misses', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(BALANCES_RULE);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'POST',
      'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=0x1',
    );

    await routeHandler(route);

    expect(route.continue).toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(manager.getSummary()).toMatchObject({ hits: 0, misses: 1 });
  });

  it('uses default status for JSON responses without explicit status', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule({
      ...MOCK_RULE,
      response: { json: { ok: true } },
    });
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'GET',
      'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
    );

    await routeHandler(route);

    expect(route.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
    );
  });

  it('uses text responses with custom headers', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule({
      id: 'text-response',
      method: 'GET',
      url: 'https://accounts.api.cx.metamask.io/text',
      response: {
        status: 202,
        headers: { 'x-test': 'yes' },
        body: 'ok',
      },
    });
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'GET',
      'https://accounts.api.cx.metamask.io/text',
    );

    await routeHandler(route);

    expect(route.fulfill).toHaveBeenCalledWith({
      status: 202,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/plain',
        'x-test': 'yes',
      },
      body: 'ok',
    });
  });

  it('uses an empty string for text responses without body', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule({
      id: 'empty-text',
      method: 'GET',
      url: 'https://accounts.api.cx.metamask.io/empty',
      response: { status: 204 },
    });
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    const route = createMockRoute(
      'GET',
      'https://accounts.api.cx.metamask.io/empty',
    );

    await routeHandler(route);

    expect(route.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ body: '' }),
    );
  });

  it('limits retained request records', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never, 2);

    await manager.addRule(BALANCES_RULE);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];

    await routeHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=1',
      ),
    );
    await routeHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=2',
      ),
    );
    await routeHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=3',
      ),
    );

    expect(manager.getRequests()).toHaveLength(2);
    expect(manager.getRequests(1)[0]?.url).toContain('account=3');
  });
});

describe('network mock URL helpers', () => {
  it('returns an origin-scoped Playwright route glob', () => {
    expect(getOriginRoutePattern(BALANCES_RULE.url)).toBe(
      'https://accounts.api.cx.metamask.io/**',
    );
  });

  it('matches exact URLs', () => {
    expect(
      matchesUrlPattern(
        'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
        'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
      ),
    ).toBe(true);
  });

  it('matches single-star glob URLs', () => {
    expect(
      matchesUrlPattern(
        'https://accounts.api.cx.metamask.io/*.json',
        'https://accounts.api.cx.metamask.io/file.json',
      ),
    ).toBe(true);
  });

  it('matches glob URLs', () => {
    expect(
      matchesUrlPattern(
        BALANCES_RULE.url,
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=0x1',
      ),
    ).toBe(true);
  });

  it('does not match different paths', () => {
    expect(
      matchesUrlPattern(
        BALANCES_RULE.url,
        'https://accounts.api.cx.metamask.io/v4/multiaccount/transactions',
      ),
    ).toBe(false);
  });

  it('finds matching rules by method and URL', () => {
    const request = {
      method: () => 'GET',
      url: () =>
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances?account=0x1',
    };

    expect(findMatchingRule([BALANCES_RULE], request)).toBe(BALANCES_RULE);
  });
});

const SEGMENT_RULE: NetworkMockRouteRule = {
  id: 'segment',
  method: 'POST',
  url: 'https://api.segment.io/**',
  response: { status: 200, json: { success: true } },
  record: { body: true },
};

const SEGMENT_BATCH = {
  batch: [
    {
      type: 'track',
      event: 'Transaction Submitted',
      properties: { chain_id: '0x1', token_symbol: 'ETH' },
      messageId: 'm-1',
    },
  ],
  writeKey: 'secret-write-key',
  sentAt: '2026-11-10T10:00:00.000Z',
};

describe('NetworkMockRouteManager request recording', () => {
  async function addAndGetHandler(rule: NetworkMockRouteRule) {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);
    await manager.addRule(rule);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    return { manager, routeHandler };
  }

  it('does not record bodies or headers by default', async () => {
    const { manager, routeHandler } = await addAndGetHandler({
      ...SEGMENT_RULE,
      record: undefined,
    });

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: JSON.stringify(SEGMENT_BATCH),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('headers');
  });

  it('records a parsed JSON body and redacts writeKey', async () => {
    const { manager, routeHandler } = await addAndGetHandler(SEGMENT_RULE);

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: JSON.stringify(SEGMENT_BATCH),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record?.matched).toBe(true);
    expect(record?.ruleId).toBe('segment');
    expect(record?.body).toStrictEqual({
      type: 'json',
      size: Buffer.byteLength(JSON.stringify(SEGMENT_BATCH)),
      value: { ...SEGMENT_BATCH, writeKey: REDACTED_VALUE },
    });
  });

  it('omits recorded bodies unless includeBodies is set', async () => {
    const { manager, routeHandler } = await addAndGetHandler({
      ...SEGMENT_RULE,
      record: { body: true, headers: true },
    });

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: JSON.stringify(SEGMENT_BATCH),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [record] = manager.getRequests();
    expect(record).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('headers');
    expect(record?.url).toBe('https://api.segment.io/v1/batch');
  });

  it('records redacted request headers when opted in', async () => {
    const { manager, routeHandler } = await addAndGetHandler({
      ...SEGMENT_RULE,
      record: { headers: true },
    });

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        headers: {
          Authorization: 'Basic c2VjcmV0Og==',
          'content-type': 'application/json',
          cookie: 'session=1',
          'x-api-key': 'k',
          'user-agent': 'analytics-node-next/latest',
        },
      }),
    );

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record?.headers).toStrictEqual({
      authorization: REDACTED_VALUE,
      'content-type': 'application/json',
      cookie: REDACTED_VALUE,
      'x-api-key': REDACTED_VALUE,
      'user-agent': 'analytics-node-next/latest',
    });
    expect(record).not.toHaveProperty('body');
  });

  it('does not record bodies for unmatched requests', async () => {
    const { manager, routeHandler } = await addAndGetHandler(SEGMENT_RULE);

    await routeHandler(
      createMockRoute('GET', 'https://api.segment.io/v1/projects', {
        body: 'ignored',
      }),
    );

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record?.matched).toBe(false);
    expect(record).not.toHaveProperty('body');
  });

  it('marks requests sent by a service worker', async () => {
    const { manager, routeHandler } = await addAndGetHandler(SEGMENT_RULE);

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{}',
        serviceWorker: true,
      }),
    );
    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{}',
      }),
    );

    const [fromWorker, fromPage] = manager.getRequests();
    expect(fromWorker?.serviceWorker).toBe(true);
    expect(fromPage).not.toHaveProperty('serviceWorker');
  });

  it('filters requests by URL glob or substring before applying the limit', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new NetworkMockRouteManager(browserContext as never);
    await manager.addRule(SEGMENT_RULE);
    await manager.addRule(BALANCES_RULE);
    const segmentHandler = browserContext.route.mock.calls[0]?.[1];
    const accountsHandler = browserContext.route.mock.calls[1]?.[1];

    await segmentHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{"n":1}',
      }),
    );
    await accountsHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances',
      ),
    );
    await segmentHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{"n":2}',
      }),
    );
    await accountsHandler(
      createMockRoute(
        'GET',
        'https://accounts.api.cx.metamask.io/v5/multiaccount/balances',
      ),
    );

    expect(
      manager.getRequests(undefined, { url: 'api.segment.io' }),
    ).toHaveLength(2);
    expect(
      manager.getRequests(undefined, { url: 'https://api.segment.io/**' }),
    ).toHaveLength(2);

    const latest = manager.getRequests(1, {
      url: 'api.segment.io',
      includeBodies: true,
    });
    expect(latest).toHaveLength(1);
    expect(latest[0]?.body?.value).toStrictEqual({ n: 2 });
  });

  it('still records the request when request accessors throw', async () => {
    const { manager, routeHandler } = await addAndGetHandler({
      ...SEGMENT_RULE,
      record: { body: true, headers: true },
    });
    const route = createMockRoute('POST', 'https://api.segment.io/v1/batch');
    const request = route.request();
    const fail = () => {
      throw new Error('detached');
    };
    request.headers.mockImplementation(fail);
    request.postDataBuffer.mockImplementation(fail);
    request.serviceWorker.mockImplementation(fail);

    await routeHandler(route);

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record).toMatchObject({
      matched: true,
      headers: {},
      body: { type: 'empty', size: 0 },
    });
    expect(record).not.toHaveProperty('serviceWorker');
    expect(route.fulfill).toHaveBeenCalled();
  });

  it('clears recorded bodies with clear', async () => {
    const { manager, routeHandler } = await addAndGetHandler(SEGMENT_RULE);

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{}',
      }),
    );
    await manager.clear();

    expect(
      manager.getRequests(undefined, { includeBodies: true }),
    ).toStrictEqual([]);
  });
});

describe('mockNetworkTool requests options', () => {
  it('passes url and includeBodies to the manager', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    await mockNetworkTool({ action: 'add', rule: SEGMENT_RULE }, context);
    const routeHandler = browserContext.route.mock.calls[0]?.[1];
    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: JSON.stringify(SEGMENT_BATCH),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const withBodies = await mockNetworkTool(
      { action: 'requests', url: 'api.segment.io', includeBodies: true },
      context,
    );
    const withoutBodies = await mockNetworkTool(
      { action: 'requests', url: 'api.segment.io' },
      context,
    );
    const otherUrl = await mockNetworkTool(
      { action: 'requests', url: 'example.com', includeBodies: true },
      context,
    );

    expect(withBodies.ok && withBodies.result.action).toBe('requests');
    if (withBodies.ok && withBodies.result.action === 'requests') {
      expect(withBodies.result.requests[0]?.body?.type).toBe('json');
    }
    if (withoutBodies.ok && withoutBodies.result.action === 'requests') {
      expect(withoutBodies.result.requests[0]).not.toHaveProperty('body');
    }
    if (otherUrl.ok && otherUrl.result.action === 'requests') {
      expect(otherUrl.result.requests).toStrictEqual([]);
      expect(otherUrl.result.summary.requestCount).toBe(1);
    }
  });
});

describe('recordRequestBody', () => {
  it('returns empty for a missing or empty body', () => {
    expect(recordRequestBody(null)).toStrictEqual({ type: 'empty', size: 0 });
    expect(recordRequestBody(Buffer.alloc(0))).toStrictEqual({
      type: 'empty',
      size: 0,
    });
  });

  it('parses JSON by content type', () => {
    expect(
      recordRequestBody(
        Buffer.from('{"a":1}'),
        'application/json; charset=utf-8',
      ),
    ).toStrictEqual({ type: 'json', size: 7, value: { a: 1 } });
  });

  it('parses JSON-looking text without a content type', () => {
    expect(recordRequestBody(Buffer.from('[1,2]'))).toStrictEqual({
      type: 'json',
      size: 5,
      value: [1, 2],
    });
  });

  it('keeps invalid JSON as text', () => {
    expect(
      recordRequestBody(Buffer.from('{not json'), 'application/json'),
    ).toStrictEqual({ type: 'text', size: 9, value: '{not json' });
  });

  it('keeps plain text as text', () => {
    expect(
      recordRequestBody(Buffer.from('hello world'), 'text/plain'),
    ).toStrictEqual({ type: 'text', size: 11, value: 'hello world' });
  });

  it('truncates large bodies, keeps them as text and redacts secrets', () => {
    const body = JSON.stringify({
      writeKey: 'secret-write-key',
      batch: [{ event: 'x'.repeat(200) }],
    });
    const result = recordRequestBody(Buffer.from(body), 'application/json', 60);

    expect(result.type).toBe('text');
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(Buffer.byteLength(body));
    expect(result.value).toContain(`"writeKey":"${REDACTED_VALUE}"`);
    expect(result.value).not.toContain('secret-write-key');
    expect(String(result.value).length).toBeLessThanOrEqual(60);
  });

  it('redacts a secret whose value is cut off by truncation', () => {
    const body = JSON.stringify({ writeKey: 'secret-write-key-long-value' });
    const result = recordRequestBody(Buffer.from(body), 'application/json', 20);

    expect(result.truncated).toBe(true);
    expect(result.value).toBe(`{"writeKey":"${REDACTED_VALUE}"`);
  });

  it('uses a 64 KiB default cap', () => {
    const body = Buffer.from('a'.repeat(DEFAULT_MAX_RECORDED_BODY_BYTES + 10));
    const result = recordRequestBody(body, 'text/plain');

    expect(result.truncated).toBe(true);
    expect(String(result.value)).toHaveLength(DEFAULT_MAX_RECORDED_BODY_BYTES);
  });

  it('does not cut a multi-byte character when truncating', () => {
    // "aé€😀" is 1 + 2 + 3 + 4 bytes.
    const body = Buffer.from('aé€😀tail', 'utf8');

    expect(recordRequestBody(body, 'text/plain', 2).value).toBe('a');
    expect(recordRequestBody(body, 'text/plain', 3).value).toBe('aé');
    expect(recordRequestBody(body, 'text/plain', 5).value).toBe('aé');
    expect(recordRequestBody(body, 'text/plain', 8).value).toBe('aé€');
    expect(recordRequestBody(body, 'text/plain', 9).value).toBe('aé€');
    expect(recordRequestBody(body, 'text/plain', 10).value).toBe('aé€😀');
  });

  it('does not store binary bodies', () => {
    expect(
      recordRequestBody(Buffer.from([0x00, 0x01, 0xff, 0xfe])),
    ).toStrictEqual({ type: 'binary', size: 4 });
    expect(
      recordRequestBody(Buffer.from('looks like text'), 'image/png'),
    ).toStrictEqual({ type: 'binary', size: 15 });
    expect(
      recordRequestBody(Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0x41, 0x42])),
    ).toStrictEqual({ type: 'binary', size: 6 });
  });

  it('redacts sensitive form fields', () => {
    expect(
      recordRequestBody(
        Buffer.from('client_secret=abc&scope=read'),
        'application/x-www-form-urlencoded',
      ),
    ).toStrictEqual({
      type: 'text',
      size: 28,
      value: `client_secret=${encodeURIComponent(REDACTED_VALUE)}&scope=read`,
    });
  });
});

describe('request redaction helpers', () => {
  it('flags sensitive header names', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('cookie')).toBe(true);
    expect(isSensitiveHeader('x-api-key')).toBe(true);
    expect(isSensitiveHeader('x-access-token')).toBe(true);
    expect(isSensitiveHeader('x-client-secret')).toBe(true);
    expect(isSensitiveHeader('content-type')).toBe(false);
    expect(isSensitiveHeader('user-agent')).toBe(false);
  });

  it('redacts headers and lowercases names', () => {
    expect(
      redactHeaders({ Authorization: 'Basic abc', Accept: '*/*' }),
    ).toStrictEqual({ authorization: REDACTED_VALUE, accept: '*/*' });
  });

  it('redacts nested sensitive JSON fields but keeps analytics properties', () => {
    expect(
      redactJsonValue({
        writeKey: 'k',
        batch: [
          {
            properties: {
              token_symbol: 'ETH',
              api_key: 'x',
              nested: { password: 'p' },
            },
          },
        ],
      }),
    ).toStrictEqual({
      writeKey: REDACTED_VALUE,
      batch: [
        {
          properties: {
            token_symbol: 'ETH',
            api_key: REDACTED_VALUE,
            nested: { password: REDACTED_VALUE },
          },
        },
      ],
    });
  });

  it('matches URL filters as globs or substrings', () => {
    expect(
      matchesUrlFilter('api.segment.io', 'https://api.segment.io/v1/batch'),
    ).toBe(true);
    expect(
      matchesUrlFilter(
        'https://api.segment.io/**',
        'https://api.segment.io/v1/batch',
      ),
    ).toBe(true);
    expect(
      matchesUrlFilter(
        'https://api.segment.io/*',
        'https://api.segment.io/v1/batch',
      ),
    ).toBe(false);
    expect(
      matchesUrlFilter('segment', 'https://accounts.api.cx.metamask.io/v1'),
    ).toBe(false);
  });
});
