import { describe, expect, it, vi } from 'vitest';

import {
  buildPreflightResponse,
  DEFAULT_MAX_RECORDED_BODY_BYTES,
  FETCH_COMMAND_TIMEOUT_MS,
  findMatchingRule,
  getFetchPatterns,
  getOriginRoutePattern,
  isCorsPreflight,
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
import type {
  CdpEventListener,
  CdpWatchedSession,
  CdpWatchSessionsOptions,
} from '../platform/cdp-manager.js';
import type { ToolContext } from '../types/http.js';

const cdpMocks = vi.hoisted(() => ({ getCdpManager: vi.fn() }));

vi.mock('../platform/cdp-manager.js', () => ({
  getCdpManager: cdpMocks.getCdpManager,
}));

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
    responseStatus?: number;
  } = {},
) {
  const body =
    typeof options.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : (options.body ?? null);
  const request = {
    method: vi.fn().mockReturnValue(method),
    url: vi.fn().mockReturnValue(url),
    headers: vi.fn().mockReturnValue(options.headers ?? {}),
    postDataBuffer: vi.fn().mockReturnValue(body),
    serviceWorker: vi.fn().mockReturnValue(options.serviceWorker ? {} : null),
    response: vi
      .fn()
      .mockResolvedValue(
        options.responseStatus === undefined
          ? null
          : { status: () => options.responseStatus },
      ),
  };
  return {
    request: vi.fn().mockReturnValue(request),
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

async function addAndGetHandler(rule: NetworkMockRouteRule) {
  const browserContext = createMockBrowserContext();
  const manager = new NetworkMockRouteManager(browserContext as never);
  await manager.addRule(rule);
  const routeHandler = browserContext.route.mock.calls[0]?.[1];
  return { manager, browserContext, routeHandler };
}

describe('NetworkMockRouteManager request recording', () => {
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

const RECORD_ONLY_RULE: NetworkMockRouteRule = {
  id: 'segment-record',
  method: 'POST',
  url: 'https://api.segment.io/**',
  record: { body: true, headers: true },
};

describe('NetworkMockRouteManager record-only rules', () => {
  it('forwards the request unchanged and records it', async () => {
    const { manager, routeHandler } = await addAndGetHandler(RECORD_ONLY_RULE);
    const route = createMockRoute('POST', 'https://api.segment.io/v1/batch', {
      body: JSON.stringify(SEGMENT_BATCH),
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      responseStatus: 202,
    });

    await routeHandler(route);

    expect(route.continue).toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record).toMatchObject({
      matched: true,
      ruleId: 'segment-record',
      method: 'POST',
      url: 'https://api.segment.io/v1/batch',
      headers: {
        authorization: REDACTED_VALUE,
        'content-type': 'application/json',
      },
      body: {
        type: 'json',
        value: { ...SEGMENT_BATCH, writeKey: REDACTED_VALUE },
      },
    });
  });

  it('records the real status of a forwarded request', async () => {
    const { manager, routeHandler } = await addAndGetHandler(RECORD_ONLY_RULE);
    const route = createMockRoute('POST', 'https://api.segment.io/v1/batch', {
      body: '{}',
      responseStatus: 202,
    });

    await routeHandler(route);
    await vi.waitFor(() => {
      expect(manager.getRequests()[0]?.status).toBe(202);
    });
  });

  it('leaves status out when the forwarded response does not arrive', async () => {
    vi.useFakeTimers();
    try {
      const { manager, routeHandler } =
        await addAndGetHandler(RECORD_ONLY_RULE);
      const route = createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{}',
      });
      route.request().response.mockReturnValue(new Promise(() => undefined));

      await routeHandler(route);
      await vi.advanceTimersByTimeAsync(5000);

      expect(manager.getRequests()[0]).not.toHaveProperty('status');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves status out when the response request fails', async () => {
    const { manager, routeHandler } = await addAndGetHandler(RECORD_ONLY_RULE);
    const route = createMockRoute('POST', 'https://api.segment.io/v1/batch', {
      body: '{}',
    });
    route.request().response.mockRejectedValue(new Error('target closed'));

    await routeHandler(route);
    await vi.waitFor(() => {
      expect(route.request().response).toHaveBeenCalled();
    });

    expect(manager.getRequests()[0]).not.toHaveProperty('status');
  });

  it('leaves status out when request.response throws', async () => {
    const { manager, routeHandler } = await addAndGetHandler(RECORD_ONLY_RULE);
    const route = createMockRoute('POST', 'https://api.segment.io/v1/batch', {
      body: '{}',
    });
    route.request().response.mockImplementation(() => {
      throw new Error('detached');
    });

    await routeHandler(route);

    expect(route.continue).toHaveBeenCalled();
    expect(manager.getRequests()[0]).not.toHaveProperty('status');
  });

  it('counts a forwarded record-only rule as a hit', async () => {
    const { manager, routeHandler } = await addAndGetHandler(RECORD_ONLY_RULE);

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: '{}',
      }),
    );

    expect(manager.getSummary()).toMatchObject({ hits: 1, misses: 0 });
  });

  it('does not record headers or bodies that the rule does not opt in to', async () => {
    const { manager, routeHandler } = await addAndGetHandler({
      ...RECORD_ONLY_RULE,
      record: {},
    });

    await routeHandler(
      createMockRoute('POST', 'https://api.segment.io/v1/batch', {
        body: JSON.stringify(SEGMENT_BATCH),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const [record] = manager.getRequests(undefined, { includeBodies: true });
    expect(record?.matched).toBe(true);
    expect(record).not.toHaveProperty('headers');
    expect(record).not.toHaveProperty('body');
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

  it('keeps invalid JSON as text without a value', () => {
    expect(
      recordRequestBody(Buffer.from('{not json'), 'application/json'),
    ).toStrictEqual({ type: 'text', size: 9, redacted: true });
  });

  it('keeps plain text as text', () => {
    expect(
      recordRequestBody(Buffer.from('hello world'), 'text/plain'),
    ).toStrictEqual({ type: 'text', size: 11, value: 'hello world' });
  });

  it('does not keep the value of a truncated JSON body', () => {
    const body = JSON.stringify({
      writeKey: 'secret-write-key',
      batch: [{ event: 'x'.repeat(200) }],
    });
    const result = recordRequestBody(Buffer.from(body), 'application/json', 60);

    expect(result).toStrictEqual({
      type: 'json',
      size: Buffer.byteLength(body),
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret-write-key');
  });

  it('does not keep the value of a truncated JSON body without a content type', () => {
    const body = JSON.stringify({ mnemonic: 'word1 word2 word3' });
    const result = recordRequestBody(Buffer.from(body), undefined, 20);

    expect(result).toStrictEqual({
      type: 'json',
      size: Buffer.byteLength(body),
      truncated: true,
    });
  });

  const NON_STRING_SECRETS = [
    { name: 'array', value: ['word1', 'word2', 'word3'], secret: 'word1' },
    {
      name: 'object',
      value: { format: 'hex', data: '0xdeadbeef' },
      secret: '0xdeadbeef',
    },
    { name: 'number', value: 12345, secret: '12345' },
  ];

  const SENSITIVE_KEYS = ['mnemonic', 'privateKey', 'apiKey'];

  describe.each(SENSITIVE_KEYS)('truncated JSON with "%s"', (key) => {
    it.each(NON_STRING_SECRETS)('keeps no $name value', ({ value, secret }) => {
      const body = JSON.stringify({ [key]: value, other: 'y'.repeat(100) });
      const result = recordRequestBody(
        Buffer.from(body),
        'application/json',
        30,
      );

      expect(result).toStrictEqual({
        type: 'json',
        size: Buffer.byteLength(body),
        truncated: true,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  describe.each(SENSITIVE_KEYS)('invalid JSON with "%s"', (key) => {
    it.each(NON_STRING_SECRETS)(
      'withholds the $name value',
      ({ value, secret }) => {
        const body = `{"${key}": ${JSON.stringify(value)}} trailing`;
        const result = recordRequestBody(Buffer.from(body), 'application/json');

        expect(result).toStrictEqual({
          type: 'text',
          size: Buffer.byteLength(body),
          redacted: true,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      },
    );
  });

  describe.each(SENSITIVE_KEYS)('JSON text with "%s"', (key) => {
    it.each(NON_STRING_SECRETS)(
      'parses and redacts the $name value without a JSON content type',
      ({ value, secret }) => {
        const body = JSON.stringify({ [key]: value, other: 'keep' });
        const result = recordRequestBody(Buffer.from(body), 'text/plain');

        expect(result).toStrictEqual({
          type: 'json',
          size: Buffer.byteLength(body),
          value: { [key]: REDACTED_VALUE, other: 'keep' },
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      },
    );
  });

  it('redacts non-string sensitive form values', () => {
    const body =
      'mnemonic=word1+word2&privateKey=%7B%22hex%22%3A%220xdeadbeef%22%7D&apiKey=12345&scope=read';
    const result = recordRequestBody(
      Buffer.from(body),
      'application/x-www-form-urlencoded',
    );

    expect(result.type).toBe('text');
    expect(result.value).toBe(
      `mnemonic=${encodeURIComponent(REDACTED_VALUE)}&privateKey=${encodeURIComponent(
        REDACTED_VALUE,
      )}&apiKey=${encodeURIComponent(REDACTED_VALUE)}&scope=read`,
    );
    expect(String(result.value)).not.toContain('0xdeadbeef');
    expect(String(result.value)).not.toContain('word1');
    expect(String(result.value)).not.toContain('12345');
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

const SCAN_RULE: NetworkMockRouteRule = {
  id: 'tron-scan',
  method: 'POST',
  url: 'https://security-alerts.api.cx.metamask.io/tron/transaction/scan',
  response: { status: 200, json: { verdict: 'Malicious' } },
};
const SCAN_PATTERN = {
  urlPattern: 'https://security-alerts.api.cx.metamask.io/*',
  requestStage: 'Request',
};
const ACCOUNTS_PATTERN = {
  urlPattern: 'https://accounts.api.cx.metamask.io/*',
  requestStage: 'Request',
};

type FakeFetchSession = CdpWatchedSession & {
  send: ReturnType<typeof vi.fn>;
  emit(method: string, params: Record<string, unknown>): void;
  listenerCount(method: string): number;
};

/**
 * Creates a watched offscreen document or iframe session.
 *
 * @param kind - The target kind.
 * @param targetId - The target ID.
 * @param reply - Answers a command; a returned promise can hang or reject.
 * @returns The session handed to the watcher, with its handles.
 */
function createFetchSession(
  kind: 'offscreen' | 'iframe',
  targetId = `${kind}-1`,
  reply: (
    method: string,
    params: Record<string, unknown>,
  ) => unknown = () => ({}),
): FakeFetchSession {
  const listeners = new Map<string, Set<CdpEventListener>>();
  const send = vi.fn(async (method: string, params: Record<string, unknown>) =>
    reply(method, params),
  );
  const session = {
    send,
    detach: vi.fn(async () => undefined),
    on: vi.fn((method: string, listener: CdpEventListener) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(listener);
    }),
    off: vi.fn((method: string, listener: CdpEventListener) => {
      listeners.get(method)?.delete(listener);
    }),
  };
  return {
    session,
    target: () => ({ kind, targetId, url: '' }),
    send,
    emit(method, params): void {
      for (const listener of listeners.get(method) ?? []) {
        listener(params);
      }
    },
    listenerCount: (method) => listeners.get(method)?.size ?? 0,
  };
}

/**
 * Creates a fake CDP manager that hands the given sessions to a watcher.
 *
 * @param initial - Sessions live when the watch starts.
 * @returns The manager mock and its handles.
 */
function createFakeCdpManager(initial: FakeFetchSession[] = []) {
  const watches: CdpWatchSessionsOptions[] = [];
  const unwatch = vi.fn(async () => undefined);
  const manager = {
    watchSessions: vi.fn(async (options: CdpWatchSessionsOptions) => {
      watches.push(options);
      for (const watched of initial) {
        await options.onAttach(watched);
      }
      return { unwatch };
    }),
  };
  return {
    manager,
    watches,
    unwatch,
    attach: async (watched: FakeFetchSession): Promise<void> =>
      watches.at(-1)?.onAttach(watched),
    detach: (watched: FakeFetchSession): void =>
      watches.at(-1)?.onDetach?.(watched.target()),
  };
}

/**
 * Creates a Chromium browser context mock whose CDP manager is `cdp`.
 *
 * @param cdp - The fake CDP manager.
 * @returns The browser context mock.
 */
function createCdpBrowserContext(cdp: ReturnType<typeof createFakeCdpManager>) {
  cdpMocks.getCdpManager.mockReturnValue(cdp.manager);
  return { ...createMockBrowserContext(), browser: vi.fn(() => ({})) };
}

/**
 * Pauses a request on a fake session and lets the handler answer it.
 *
 * @param watched - The session.
 * @param request - The paused request.
 * @param requestId - The CDP request ID.
 */
async function pause(
  watched: FakeFetchSession,
  request: Record<string, unknown>,
  requestId = 'request-1',
): Promise<void> {
  watched.emit('Fetch.requestPaused', { requestId, request });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param watched - The session.
 * @param method - The CDP method.
 * @returns The parameters of each call of the method.
 */
function sent(
  watched: FakeFetchSession,
  method: string,
): Record<string, unknown>[] {
  return watched.send.mock.calls
    .filter(([name]) => name === method)
    .map(([, params]) => params as Record<string, unknown>);
}

describe('NetworkMockRouteManager offscreen document and iframes', () => {
  it('reports only pages and the service worker without a browser', async () => {
    const manager = new NetworkMockRouteManager(
      createMockBrowserContext() as never,
    );
    expect(manager.getCoverage()).toStrictEqual({ contexts: [], pending: [] });

    await manager.addRule(MOCK_RULE);

    expect(manager.getCoverage()).toStrictEqual({
      contexts: ['page', 'sw'],
      pending: ['offscreen', 'iframe'],
    });
    expect(cdpMocks.getCdpManager).not.toHaveBeenCalled();
  });

  it('does not watch without a browser session', async () => {
    const cdp = createFakeCdpManager();
    const browserContext = createCdpBrowserContext(cdp);
    browserContext.browser.mockReturnValue(null as never);
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(MOCK_RULE);

    expect(cdp.manager.watchSessions).not.toHaveBeenCalled();
  });

  it('enables Fetch for the rule origins on the offscreen document and new iframes', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );

    await manager.addRule(SCAN_RULE);

    expect(cdp.manager.watchSessions).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['offscreen', 'iframe'] }),
    );
    expect(sent(offscreen, 'Fetch.enable')).toStrictEqual([
      { patterns: [SCAN_PATTERN] },
    ]);
    expect(manager.getCoverage()).toStrictEqual({
      contexts: ['page', 'sw', 'offscreen'],
      pending: ['iframe'],
    });

    const iframe = createFetchSession('iframe');
    await cdp.attach(iframe);
    expect(manager.getCoverage().contexts).toStrictEqual([
      'page',
      'sw',
      'offscreen',
      'iframe',
    ]);

    cdp.detach(iframe);
    expect(manager.getCoverage().pending).toStrictEqual(['iframe']);
    expect(iframe.listenerCount('Fetch.requestPaused')).toBe(0);
  });

  it('enables Fetch again when a rule adds an origin, and not for a known one', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );

    await manager.addRules([SCAN_RULE, MOCK_RULE, BALANCES_RULE]);

    expect(sent(offscreen, 'Fetch.enable')).toStrictEqual([
      { patterns: [SCAN_PATTERN] },
      { patterns: [SCAN_PATTERN, ACCOUNTS_PATTERN] },
    ]);
    expect(cdp.manager.watchSessions).toHaveBeenCalledTimes(1);
  });

  it('fulfills a mocked request with a base64 body and records it', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule({
      ...SCAN_RULE,
      record: { body: true, headers: true },
    });

    await pause(iframe, {
      url: SCAN_RULE.url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'x' },
      postData: '{"tx":"0x1"}',
    });

    expect(sent(iframe, 'Fetch.fulfillRequest')).toStrictEqual([
      {
        requestId: 'request-1',
        responseCode: 200,
        responseHeaders: [
          { name: 'access-control-allow-origin', value: '*' },
          { name: 'content-type', value: 'application/json' },
        ],
        body: Buffer.from('{"verdict":"Malicious"}').toString('base64'),
      },
    ]);
    expect(
      manager.getRequests(undefined, { includeBodies: true }),
    ).toStrictEqual([
      expect.objectContaining({
        method: 'POST',
        url: SCAN_RULE.url,
        matched: true,
        ruleId: SCAN_RULE.id,
        status: 200,
        context: 'iframe',
        headers: {
          'content-type': 'application/json',
          authorization: REDACTED_VALUE,
        },
        body: { type: 'json', size: 12, value: { tx: '0x1' } },
      }),
    ]);
    expect(manager.getRequests()[0]).not.toHaveProperty('serviceWorker');
  });

  it('forwards a request a record-only rule or no rule matches', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule({
      id: 'scan-record',
      method: 'POST',
      url: SCAN_RULE.url,
      record: { body: true },
    });

    await pause(offscreen, {
      url: SCAN_RULE.url,
      method: 'POST',
      postDataEntries: [
        { bytes: Buffer.from('{"a":').toString('base64') },
        { bytes: Buffer.from('1}').toString('base64') },
        {},
      ],
    });
    await pause(
      offscreen,
      { url: `${SCAN_RULE.url}/other`, method: 'GET' },
      'request-2',
    );

    expect(sent(offscreen, 'Fetch.continueRequest')).toStrictEqual([
      { requestId: 'request-1' },
      { requestId: 'request-2' },
    ]);
    const records = manager.getRequests(undefined, { includeBodies: true });
    expect(records[0]).toStrictEqual(
      expect.objectContaining({
        matched: true,
        context: 'offscreen',
        body: { type: 'json', size: 7, value: { a: 1 } },
      }),
    );
    expect(records[0]).not.toHaveProperty('status');
    expect(records[1]).toStrictEqual(
      expect.objectContaining({ matched: false, context: 'offscreen' }),
    );
  });

  it('records an empty body and defaults for a request without details', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule({
      id: 'scan-get',
      method: 'GET',
      url: SCAN_RULE.url,
      record: { body: true },
    });

    await pause(offscreen, { url: SCAN_RULE.url });
    offscreen.emit('Fetch.requestPaused', { requestId: 'request-2' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      manager.getRequests(undefined, { includeBodies: true }),
    ).toStrictEqual([
      expect.objectContaining({
        method: 'GET',
        matched: true,
        body: { type: 'empty', size: 0 },
      }),
      expect.objectContaining({ method: 'GET', url: '', matched: false }),
    ]);
  });

  it('answers the CORS preflight of a mocked request without recording it', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);

    await pause(iframe, {
      url: SCAN_RULE.url,
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    expect(sent(iframe, 'Fetch.fulfillRequest')).toStrictEqual([
      {
        requestId: 'request-1',
        responseCode: 204,
        responseHeaders: [
          { name: 'access-control-allow-origin', value: '*' },
          { name: 'access-control-allow-methods', value: 'POST' },
          { name: 'access-control-allow-headers', value: 'content-type' },
        ],
      },
    ]);
    expect(manager.getRequests()).toStrictEqual([]);
  });

  it('forwards the CORS preflight of a request it does not mock', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule({ ...SCAN_RULE, response: undefined, record: {} });

    await pause(iframe, {
      url: SCAN_RULE.url,
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'POST' },
    });

    expect(sent(iframe, 'Fetch.continueRequest')).toStrictEqual([
      { requestId: 'request-1' },
    ]);
    expect(manager.getRequests()).toStrictEqual([]);
  });

  it('leaves an OPTIONS rule to plain OPTIONS requests, as route() does', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRules([
      SCAN_RULE,
      {
        ...SCAN_RULE,
        id: 'scan-options',
        method: 'OPTIONS',
        response: { status: 418, body: 'teapot' },
      },
    ]);

    const preflight = (requestMethod: string): Record<string, unknown> => ({
      url: SCAN_RULE.url,
      method: 'OPTIONS',
      headers: { 'access-control-request-method': requestMethod },
    });
    await pause(iframe, preflight('POST'), 'preflight-post');
    await pause(iframe, preflight('PUT'), 'preflight-put');
    await pause(iframe, { url: SCAN_RULE.url, method: 'OPTIONS' }, 'options');

    expect(
      sent(iframe, 'Fetch.fulfillRequest').map(
        ({ requestId, responseCode }) => ({ requestId, responseCode }),
      ),
    ).toStrictEqual([
      { requestId: 'preflight-post', responseCode: 204 },
      { requestId: 'options', responseCode: 418 },
    ]);
    expect(sent(iframe, 'Fetch.continueRequest')).toStrictEqual([
      { requestId: 'preflight-put' },
    ]);
    expect(manager.getRequests()).toStrictEqual([
      expect.objectContaining({ method: 'OPTIONS', ruleId: 'scan-options' }),
    ]);
  });

  it('ignores Fetch failures on a closed session', async () => {
    const iframe = createFetchSession('iframe', 'iframe-1', (method) => {
      if (method !== 'Fetch.enable') {
        throw new Error('Session closed. The iframe target is gone.');
      }
      return {};
    });
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);

    await pause(iframe, { url: SCAN_RULE.url, method: 'POST' });
    await manager.clear();

    expect(sent(iframe, 'Fetch.continueRequest')).toHaveLength(1);
    expect(sent(iframe, 'Fetch.disable')).toHaveLength(1);
  });

  it('reports no contexts on list without rules', async () => {
    const cdp = createFakeCdpManager();
    const context = createMockContext({
      browserContext: createCdpBrowserContext(cdp) as never,
    });

    const listed = await mockNetworkTool({ action: 'list' }, context);

    expect(listed.ok && listed.result).toStrictEqual(
      expect.objectContaining({ contexts: [], pending: [] }),
    );
    expect(cdp.manager.watchSessions).not.toHaveBeenCalled();
  });

  it('continues a paused request whose fulfill fails, and says so in its record', async () => {
    const iframe = createFetchSession('iframe', 'iframe-1', (method) => {
      if (method === 'Fetch.fulfillRequest') {
        throw new Error('Invalid header');
      }
      return {};
    });
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);

    await pause(iframe, { url: SCAN_RULE.url, method: 'POST' });

    expect(sent(iframe, 'Fetch.continueRequest')).toStrictEqual([
      { requestId: 'request-1' },
    ]);
    expect(manager.getRequests()).toStrictEqual([
      {
        timestamp: expect.any(String),
        method: 'POST',
        url: SCAN_RULE.url,
        matched: true,
        ruleId: SCAN_RULE.id,
        context: 'iframe',
        mockError: 'Invalid header',
      },
    ]);
  });

  it('bounds a Fetch command that never answers', async () => {
    vi.useFakeTimers();
    try {
      const iframe = createFetchSession('iframe', 'iframe-1', async (method) =>
        method === 'Fetch.continueRequest' ? {} : new Promise(() => undefined),
      );
      const cdp = createFakeCdpManager();
      const manager = new NetworkMockRouteManager(
        createCdpBrowserContext(cdp) as never,
      );
      await manager.addRule(SCAN_RULE);

      const attaching = cdp.attach(iframe);
      await vi.advanceTimersByTimeAsync(FETCH_COMMAND_TIMEOUT_MS);
      await attaching;
      expect(manager.getCoverage().pending).toStrictEqual([
        'offscreen',
        'iframe',
      ]);

      iframe.emit('Fetch.requestPaused', {
        requestId: 'request-1',
        request: { url: SCAN_RULE.url, method: 'POST' },
      });
      await vi.advanceTimersByTimeAsync(FETCH_COMMAND_TIMEOUT_MS);

      expect(sent(iframe, 'Fetch.continueRequest')).toStrictEqual([
        { requestId: 'request-1' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a paused event without a request ID', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);

    iframe.emit('Fetch.requestPaused', {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent(iframe, 'Fetch.continueRequest')).toStrictEqual([]);
  });

  it('disables Fetch and stops watching on clear', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);
    const listener = vi.mocked(offscreen.session.on).mock.calls[0]?.[1];

    await manager.clear();
    listener({ requestId: 'late', request: { url: SCAN_RULE.url } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cdp.unwatch).toHaveBeenCalledTimes(1);
    expect(sent(offscreen, 'Fetch.disable')).toStrictEqual([{}]);
    expect(offscreen.listenerCount('Fetch.requestPaused')).toBe(0);
    expect(sent(offscreen, 'Fetch.continueRequest')).toStrictEqual([
      { requestId: 'late' },
    ]);
    expect(manager.getRequests()).toStrictEqual([]);
    expect(manager.getCoverage()).toStrictEqual({ contexts: [], pending: [] });
  });

  it('leaves alone an iframe that attaches while clear stops the watch', async () => {
    const cdp = createFakeCdpManager();
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    cdp.manager.watchSessions.mockImplementationOnce(async (options) => {
      cdp.watches.push(options);
      await started;
      return { unwatch: cdp.unwatch };
    });
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    const adding = manager.addRule(SCAN_RULE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clearing = manager.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = createFetchSession('iframe');
    await cdp.attach(iframe);
    release();
    await Promise.all([adding, clearing]);

    expect(sent(iframe, 'Fetch.enable')).toStrictEqual([]);
    expect(iframe.listenerCount('Fetch.requestPaused')).toBe(0);
    expect(manager.getCoverage()).toStrictEqual({ contexts: [], pending: [] });

    await manager.addRule(SCAN_RULE);
    await cdp.attach(iframe);
    await pause(iframe, { url: SCAN_RULE.url, method: 'POST' });

    expect(iframe.listenerCount('Fetch.requestPaused')).toBe(1);
    expect(sent(iframe, 'Fetch.fulfillRequest')).toHaveLength(1);
    expect(manager.getRequests()).toHaveLength(1);
  });

  it('does not fail an add whose watch fails while clear stops it', async () => {
    const cdp = createFakeCdpManager();
    let fail = (): void => undefined;
    cdp.manager.watchSessions.mockImplementationOnce(
      async () =>
        new Promise((_resolve, reject) => {
          fail = (): void => reject(new Error('No browser'));
        }),
    );
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    const adding = manager.addRule(SCAN_RULE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clearing = manager.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));

    fail();

    expect(await Promise.all([adding, clearing])).toStrictEqual([
      undefined,
      undefined,
    ]);
  });

  it('takes a session handed over twice only once', async () => {
    const iframe = createFetchSession('iframe');
    const cdp = createFakeCdpManager([iframe]);
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );
    await manager.addRule(SCAN_RULE);

    await cdp.attach(iframe);

    expect(iframe.listenerCount('Fetch.requestPaused')).toBe(1);
    expect(sent(iframe, 'Fetch.enable')).toHaveLength(1);
  });

  it('retries the watch after it failed', async () => {
    const cdp = createFakeCdpManager();
    cdp.manager.watchSessions.mockRejectedValueOnce(new Error('No browser'));
    const manager = new NetworkMockRouteManager(
      createCdpBrowserContext(cdp) as never,
    );

    await manager.addRule(SCAN_RULE);
    await manager.syncContexts();

    expect(cdp.manager.watchSessions).toHaveBeenCalledTimes(2);
    cdp.watches[0]?.onError?.(new Error('attach failed'));
  });

  it('watches the new CDP manager after a relaunch', async () => {
    const offscreen = createFetchSession('offscreen');
    const first = createFakeCdpManager([offscreen]);
    const browserContext = createCdpBrowserContext(first);
    const manager = new NetworkMockRouteManager(browserContext as never);
    await manager.addRule(SCAN_RULE);
    const second = createFakeCdpManager();
    cdpMocks.getCdpManager.mockReturnValue(second.manager);

    await manager.syncContexts();

    expect(first.unwatch).toHaveBeenCalledTimes(1);
    expect(second.manager.watchSessions).toHaveBeenCalledTimes(1);
    expect(manager.getCoverage().pending).toStrictEqual([
      'offscreen',
      'iframe',
    ]);
  });

  it('keeps page and service worker routes when the CDP manager is unavailable', async () => {
    const cdp = createFakeCdpManager();
    const browserContext = createCdpBrowserContext(cdp);
    cdpMocks.getCdpManager.mockImplementation(() => {
      throw new Error('disposed');
    });
    const manager = new NetworkMockRouteManager(browserContext as never);

    await manager.addRule(SCAN_RULE);

    expect(browserContext.route).toHaveBeenCalledTimes(1);
    expect(manager.getCoverage().contexts).toStrictEqual(['page', 'sw']);
    cdpMocks.getCdpManager.mockReset();
  });

  it('reports contexts on add and list', async () => {
    const offscreen = createFetchSession('offscreen');
    const cdp = createFakeCdpManager([offscreen]);
    const browserContext = createCdpBrowserContext(cdp);
    const context = createMockContext({
      browserContext: browserContext as never,
    });

    const added = await mockNetworkTool(
      { action: 'add', rule: SCAN_RULE },
      context,
    );
    const listed = await mockNetworkTool({ action: 'list' }, context);

    for (const response of [added, listed]) {
      expect(response.ok && response.result).toStrictEqual(
        expect.objectContaining({
          contexts: ['page', 'sw', 'offscreen'],
          pending: ['iframe'],
        }),
      );
    }
  });

  it('records the context of page and service worker requests', async () => {
    const manager = new NetworkMockRouteManager(
      createMockBrowserContext() as never,
    );
    await manager.addRule(MOCK_RULE);
    const browserContext = createMockBrowserContext();
    const routed = new NetworkMockRouteManager(browserContext as never);
    await routed.addRule(MOCK_RULE);
    const handler = browserContext.route.mock.calls[0]?.[1] as (
      route: unknown,
    ) => Promise<void>;

    await handler(createMockRoute('GET', MOCK_RULE.url));
    await handler(
      createMockRoute('GET', MOCK_RULE.url, { serviceWorker: true }),
    );

    expect(
      routed.getRequests().map(({ context, serviceWorker }) => ({
        context,
        serviceWorker,
      })),
    ).toStrictEqual([
      { context: 'page', serviceWorker: undefined },
      { context: 'sw', serviceWorker: true },
    ]);
  });
});

describe('getFetchPatterns', () => {
  it('returns one request-stage pattern per rule origin', () => {
    expect(
      getFetchPatterns([SCAN_RULE, MOCK_RULE, BALANCES_RULE]),
    ).toStrictEqual([SCAN_PATTERN, ACCOUNTS_PATTERN]);
    expect(getFetchPatterns([])).toStrictEqual([]);
  });
});

describe('buildPreflightResponse', () => {
  it('echoes a concrete origin and allows credentials', () => {
    expect(
      buildPreflightResponse([SCAN_RULE], SCAN_RULE.url, {
        origin: 'https://dapp.example',
        'access-control-request-method': 'POST',
      }),
    ).toStrictEqual({
      responseCode: 204,
      responseHeaders: [
        { name: 'access-control-allow-origin', value: 'https://dapp.example' },
        { name: 'access-control-allow-methods', value: 'POST' },
        { name: 'access-control-allow-headers', value: '*' },
        { name: 'access-control-allow-credentials', value: 'true' },
      ],
    });
  });

  it('answers nothing without a mocked rule for the requested method', () => {
    expect(
      buildPreflightResponse([SCAN_RULE], SCAN_RULE.url, {}),
    ).toBeUndefined();
  });

  it('detects browser preflights only', () => {
    expect(
      isCorsPreflight('options', { 'access-control-request-method': 'POST' }),
    ).toBe(true);
    expect(isCorsPreflight('OPTIONS', {})).toBe(false);
    expect(
      isCorsPreflight('POST', { 'access-control-request-method': 'POST' }),
    ).toBe(false);
  });
});
