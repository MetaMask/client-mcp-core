import { describe, expect, it, vi } from 'vitest';

import {
  findMatchingRule,
  getOriginRoutePattern,
  matchesUrlPattern,
  mockNetworkTool,
  NetworkMockRouteManager,
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

function createMockRoute(method: string, url: string) {
  return {
    request: vi.fn().mockReturnValue({
      method: vi.fn().mockReturnValue(method),
      url: vi.fn().mockReturnValue(url),
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
    knowledgeStore: {},
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
      if (result.result.action !== 'add') {
        throw new Error(`Expected add result, got ${result.result.action}`);
      }
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
      if (result.result.action !== 'list') {
        throw new Error(`Expected list result, got ${result.result.action}`);
      }
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
      if (result.result.action !== 'requests') {
        throw new Error(
          `Expected requests result, got ${result.result.action}`,
        );
      }
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
