import { describe, expect, it, vi } from 'vitest';

import {
  findMatchingMessageRule,
  matchesMessagePattern,
  mockWebSocketTool,
  truncateMessage,
  WebSocketMockRouteManager,
} from './mock-websocket.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type {
  WebSocketMockDefinition,
  WebSocketMockMessageRule,
} from './types';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

const MOCK_RULE: WebSocketMockMessageRule = {
  id: 'clearinghouse-state',
  match: { includes: 'clearinghouseState' },
  respond: { channel: 'subscriptionResponse', data: { balances: [] } },
};

const MOCK_DEFINITION: WebSocketMockDefinition = {
  url: 'wss://api.hyperliquid.xyz/ws',
  rules: [MOCK_RULE],
  passthrough: false,
};

const MOCK_DEFINITION_PASSTHROUGH: WebSocketMockDefinition = {
  url: 'wss://api.hyperliquid.xyz/ws',
  rules: [MOCK_RULE],
  passthrough: true,
};

function createMockBrowserContext() {
  return {
    routeWebSocket: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockWebSocketRoute(url: string) {
  const handlers: {
    onMessage?: (message: string) => void;
    onClose?: (code?: number, reason?: string) => void;
  } = {};

  const serverHandlers: {
    onMessage?: (message: string) => void;
    onClose?: (code?: number, reason?: string) => void;
  } = {};

  const serverRoute = {
    send: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockImplementation((handler) => {
      serverHandlers.onMessage = handler;
    }),
    onClose: vi.fn().mockImplementation((handler) => {
      serverHandlers.onClose = handler;
    }),
  };

  const route = {
    url: vi.fn().mockReturnValue(url),
    send: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockImplementation((handler) => {
      handlers.onMessage = handler;
    }),
    onClose: vi.fn().mockImplementation((handler) => {
      handlers.onClose = handler;
    }),
    connectToServer: vi.fn().mockReturnValue(serverRoute),
  };

  return { route, handlers, serverRoute, serverHandlers };
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

describe('mockWebSocketTool', () => {
  it('adds a WebSocket mock definition', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    const result = await mockWebSocketTool(
      { action: 'add', mock: MOCK_DEFINITION },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.result.action === 'add') {
      expect(result.result.added).toBe(1);
      expect(result.result.mocks).toStrictEqual([MOCK_DEFINITION]);
    }
    expect(browserContext.routeWebSocket).toHaveBeenCalledWith(
      'wss://api.hyperliquid.xyz/ws',
      expect.any(Function),
    );
  });

  it('adds multiple WebSocket mock definitions', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    const mock2: WebSocketMockDefinition = {
      url: 'wss://other.example.com/ws',
      rules: [{ id: 'other-rule', match: { includes: 'other' } }],
    };

    const result = await mockWebSocketTool(
      { action: 'add', mocks: [MOCK_DEFINITION, mock2] },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.result.action === 'add') {
      expect(result.result.added).toBe(2);
      expect(result.result.mocks).toHaveLength(2);
    }
    expect(browserContext.routeWebSocket).toHaveBeenCalledTimes(2);
  });

  it('clears WebSocket mocks', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    await mockWebSocketTool({ action: 'add', mock: MOCK_DEFINITION }, context);
    const result = await mockWebSocketTool({ action: 'clear' }, context);

    expect(result.ok).toBe(true);
    if (result.ok && result.result.action === 'clear') {
      expect(result.result.cleared).toBe(true);
      expect(result.result.summary.mockCount).toBe(0);
    }
  });

  it('lists active WebSocket mocks', async () => {
    const context = createMockContext();

    await mockWebSocketTool({ action: 'add', mock: MOCK_DEFINITION }, context);
    const result = await mockWebSocketTool({ action: 'list' }, context);

    expect(result.ok).toBe(true);
    if (result.ok && result.result.action === 'list') {
      expect(result.result.mocks).toStrictEqual([MOCK_DEFINITION]);
    }
  });

  it('returns message records', async () => {
    const browserContext = createMockBrowserContext();
    const context = createMockContext({ browserContext });

    await mockWebSocketTool({ action: 'add', mock: MOCK_DEFINITION }, context);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    wsHandler(route);

    handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');

    const result = await mockWebSocketTool({ action: 'messages' }, context);

    expect(result.ok).toBe(true);
    if (result.ok && result.result.action === 'messages') {
      expect(result.result.messages).toHaveLength(1);
      expect(result.result.messages[0]?.matched).toBe(true);
      expect(result.result.summary.hits).toBe(1);
    }
  });

  it('returns an error when no session is active', async () => {
    const context = createMockContext({ hasActive: false });

    const result = await mockWebSocketTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });
});

describe('WebSocketMockRouteManager', () => {
  it('responds to matching messages in full mock mode', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );

    wsHandler(route);
    handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');

    expect(route.send).toHaveBeenCalledWith(JSON.stringify(MOCK_RULE.respond));
  });

  it('connects to server in passthrough mode', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION_PASSTHROUGH);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route } = createMockWebSocketRoute('wss://api.hyperliquid.xyz/ws');

    wsHandler(route);

    expect(route.connectToServer).toHaveBeenCalled();
  });

  it('forwards unmatched messages to server in passthrough mode', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION_PASSTHROUGH);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers, serverRoute } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );

    wsHandler(route);
    handlers.onMessage?.('unmatched message');

    expect(serverRoute.send).toHaveBeenCalledWith('unmatched message');
  });

  it('does not install duplicate route handlers for the same URL', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    await manager.addMock({ ...MOCK_DEFINITION, rules: [] });

    expect(browserContext.routeWebSocket).toHaveBeenCalledTimes(1);
    expect(browserContext.routeWebSocket).toHaveBeenCalledWith(
      'wss://api.hyperliquid.xyz/ws',
      expect.any(Function),
    );
  });

  it('replaces mock when adding with same URL', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    const oldRule: WebSocketMockMessageRule = {
      id: 'old',
      match: { includes: 'old' },
      respond: 'old',
    };
    const newRule: WebSocketMockMessageRule = {
      id: 'new',
      match: { includes: 'new' },
      respond: 'new',
    };

    await manager.addMock({ url: 'wss://test.com/ws', rules: [oldRule] });
    await manager.addMock({ url: 'wss://test.com/ws', rules: [newRule] });

    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute('wss://test.com/ws');
    wsHandler(route);

    handlers.onMessage?.('new');
    expect(route.send).toHaveBeenCalledWith(newRule.respond);

    handlers.onMessage?.('old');
    expect(route.send).toHaveBeenCalledTimes(1);
  });

  it('records message hits and misses', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    wsHandler(route);

    handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');
    handlers.onMessage?.('unmatched');

    expect(manager.getSummary()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('handles delay before responding', async () => {
    vi.useFakeTimers();

    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);
    const delayedRule = { ...MOCK_RULE, delay: 500 };

    await manager.addMock({ ...MOCK_DEFINITION, rules: [delayedRule] });
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    wsHandler(route);

    handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');
    expect(route.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(route.send).toHaveBeenCalledWith(
      JSON.stringify(delayedRule.respond),
    );

    vi.useRealTimers();
  });

  it('handles followUpResponse with delay', async () => {
    vi.useFakeTimers();

    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);
    const followUpRule: WebSocketMockMessageRule = {
      id: 'follow-up-test',
      match: { includes: 'test' },
      followUpResponse: { channel: 'followUp', data: {} },
      followUpDelay: 500,
    };

    await manager.addMock({ url: 'wss://test.com/ws', rules: [followUpRule] });
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute('wss://test.com/ws');
    wsHandler(route);

    handlers.onMessage?.('test message');
    expect(route.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(route.send).toHaveBeenCalledWith(
      JSON.stringify(followUpRule.followUpResponse),
    );

    vi.useRealTimers();
  });

  it('sends followUpResponse after respond when both have delays', async () => {
    vi.useFakeTimers();

    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);
    const rule: WebSocketMockMessageRule = {
      id: 'ordered-test',
      match: { includes: 'trigger' },
      respond: { initial: true },
      delay: 1000,
      followUpResponse: { followUp: true },
      followUpDelay: 500,
    };

    await manager.addMock({
      url: 'wss://test.com/ws',
      rules: [rule],
      passthrough: false,
    });
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute('wss://test.com/ws');
    wsHandler(route);

    handlers.onMessage?.('trigger');

    // At 500ms: neither should have fired
    vi.advanceTimersByTime(500);
    expect(route.send).not.toHaveBeenCalled();

    // At 1000ms: only respond should have fired
    vi.advanceTimersByTime(500);
    expect(route.send).toHaveBeenCalledTimes(1);
    expect(route.send).toHaveBeenCalledWith(JSON.stringify({ initial: true }));

    // At 1500ms: followUp should also have fired
    vi.advanceTimersByTime(500);
    expect(route.send).toHaveBeenCalledTimes(2);
    expect(route.send).toHaveBeenLastCalledWith(
      JSON.stringify({ followUp: true }),
    );

    vi.useRealTimers();
  });

  it('limits retained message records', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never, 2);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    wsHandler(route);

    handlers.onMessage?.('msg1');
    handlers.onMessage?.('msg2');
    handlers.onMessage?.('msg3');

    expect(manager.getMessages()).toHaveLength(2);
    expect(manager.getMessages()[0]?.message).toBe('msg2');
    expect(manager.getMessages()[1]?.message).toBe('msg3');
  });

  it('clears makes handler no-op', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];

    manager.clear();

    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    wsHandler(route);
    handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');

    expect(route.send).not.toHaveBeenCalled();
  });

  it('tracks active connections', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );

    expect(manager.getSummary().activeConnections).toBe(0);

    wsHandler(route);
    expect(manager.getSummary().activeConnections).toBe(1);

    handlers.onClose?.(1000, 'test');
    expect(manager.getSummary().activeConnections).toBe(0);
  });

  it('reports zero activeConnections immediately after clear', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route } = createMockWebSocketRoute('wss://api.hyperliquid.xyz/ws');

    wsHandler(route);
    expect(manager.getSummary().activeConnections).toBe(1);

    manager.clear();
    // activeConnections must be 0 synchronously, before any onClose fires
    expect(manager.getSummary().activeConnections).toBe(0);
  });

  it('does not go negative when onClose fires after clear', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );

    wsHandler(route);
    manager.clear();

    // Simulate the async onClose firing after clear already reset the counter
    handlers.onClose?.(1001, 'mocks cleared');
    expect(manager.getSummary().activeConnections).toBe(0);
  });

  it('closes active sockets on clear', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route } = createMockWebSocketRoute('wss://api.hyperliquid.xyz/ws');

    wsHandler(route);
    expect(manager.getSummary().activeConnections).toBe(1);

    manager.clear();

    expect(route.close).toHaveBeenCalledWith({
      code: 1001,
      reason: 'mocks cleared',
    });
  });

  it('does not fire stale delayed response after clear and re-add', async () => {
    vi.useFakeTimers();

    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);
    const delayedRule: WebSocketMockMessageRule = {
      id: 'delayed',
      match: { includes: 'trigger' },
      respond: { stale: true },
      delay: 1000,
    };

    // 1. Add mock with delayed response, open connection, trigger timer
    await manager.addMock({
      url: 'wss://test.com/ws',
      rules: [delayedRule],
      passthrough: false,
    });
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute('wss://test.com/ws');
    wsHandler(route);
    handlers.onMessage?.('trigger');

    // 2. Clear and re-add a different mock before the timer fires
    manager.clear();
    await manager.addMock({
      url: 'wss://test.com/ws',
      rules: [{ id: 'new', match: { includes: 'new' } }],
      passthrough: false,
    });

    // 3. Advance past the original delay — stale response must NOT fire
    vi.advanceTimersByTime(1500);
    expect(route.send).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('closes active sockets when replacing a mock for the same URL', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route } = createMockWebSocketRoute('wss://api.hyperliquid.xyz/ws');

    wsHandler(route);
    expect(manager.getSummary().activeConnections).toBe(1);

    // Replace mock for the same URL
    const newRule: WebSocketMockMessageRule = {
      id: 'new-rule',
      match: { includes: 'new' },
      respond: 'new',
    };
    await manager.addMock({
      url: 'wss://api.hyperliquid.xyz/ws',
      rules: [newRule],
      passthrough: false,
    });

    expect(route.close).toHaveBeenCalledWith({
      code: 1001,
      reason: 'mock replaced',
    });
    expect(manager.getSummary().activeConnections).toBe(0);
  });

  it('does not close sockets when adding a mock for a new URL', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route } = createMockWebSocketRoute('wss://api.hyperliquid.xyz/ws');

    wsHandler(route);

    // Add mock for a DIFFERENT URL — should not close existing socket
    await manager.addMock({
      url: 'wss://other.example.com/ws',
      rules: [{ id: 'other', match: { includes: 'other' } }],
      passthrough: false,
    });

    expect(route.close).not.toHaveBeenCalled();
    expect(manager.getSummary().activeConnections).toBe(1);
  });

  it('invalidates stale delayed responses when replacing a mock', async () => {
    vi.useFakeTimers();

    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);
    const delayedRule: WebSocketMockMessageRule = {
      id: 'delayed',
      match: { includes: 'trigger' },
      respond: { stale: true },
      delay: 1000,
    };

    await manager.addMock({
      url: 'wss://test.com/ws',
      rules: [delayedRule],
      passthrough: false,
    });
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute('wss://test.com/ws');
    wsHandler(route);

    // Trigger a delayed response
    handlers.onMessage?.('trigger');

    // Replace mock before the timer fires — should close old socket
    await manager.addMock({
      url: 'wss://test.com/ws',
      rules: [{ id: 'new', match: { includes: 'new' } }],
      passthrough: false,
    });

    // The old socket is closed, so simulate onClose firing
    handlers.onClose?.(1001, 'mock replaced');

    // Advance past the old delay — stale response must NOT fire
    vi.advanceTimersByTime(1500);
    expect(route.send).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('handles server close in passthrough mode', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION_PASSTHROUGH);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, serverHandlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );

    wsHandler(route);
    serverHandlers.onClose?.(1000, 'server closed');

    expect(route.close).toHaveBeenCalledWith({
      code: 1000,
      reason: 'server closed',
    });
  });

  it('does not throw when sending to a closed connection', async () => {
    const browserContext = createMockBrowserContext();
    const manager = new WebSocketMockRouteManager(browserContext as never);

    await manager.addMock(MOCK_DEFINITION);
    const wsHandler = browserContext.routeWebSocket.mock.calls[0]?.[1];
    const { route, handlers } = createMockWebSocketRoute(
      'wss://api.hyperliquid.xyz/ws',
    );
    route.send.mockImplementation(() => {
      throw new Error('WebSocket is already closed');
    });

    wsHandler(route);

    expect(() => {
      handlers.onMessage?.('{"subscription":{"type":"clearinghouseState"}}');
    }).not.toThrowError();
  });
});

describe('WebSocket mock message helpers', () => {
  it('matches single string includes', () => {
    expect(matchesMessagePattern('foo', 'contains foo bar')).toBe(true);
  });

  it('matches array of includes (all must match)', () => {
    expect(matchesMessagePattern(['foo', 'bar'], 'foo and bar')).toBe(true);
  });

  it('rejects when not all array items match', () => {
    expect(matchesMessagePattern(['foo', 'baz'], 'foo and bar')).toBe(false);
  });

  it('finds matching message rule', () => {
    const rules = [MOCK_RULE, { id: 'other', match: { includes: 'other' } }];

    expect(findMatchingMessageRule(rules, 'contains clearinghouseState')).toBe(
      MOCK_RULE,
    );
  });

  it('truncates long messages', () => {
    const longMessage = 'x'.repeat(201);
    expect(truncateMessage(longMessage)).toBe(`${'x'.repeat(200)}...`);
  });

  it('does not truncate short messages', () => {
    expect(truncateMessage('short')).toBe('short');
  });
});
