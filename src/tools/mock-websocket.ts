import type { BrowserContext, WebSocketRoute } from '@playwright/test';

import type {
  MockWebSocketInput,
  MockWebSocketResult,
  WebSocketMockDefinition,
  WebSocketMockMessageRecord,
  WebSocketMockMessageRule,
  WebSocketMockSummary,
} from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

const DEFAULT_MAX_MESSAGE_RECORDS = 500;
const DEFAULT_MESSAGE_TRUNCATION = 200;

const webSocketMockManagers = new WeakMap<
  BrowserContext,
  WebSocketMockRouteManager
>();

/**
 * Adds, clears, lists, and inspects targeted WebSocket mocks for the active
 * browser session.
 *
 * @param input - The mock-websocket action and payload.
 * @param context - The tool execution context.
 * @returns The mock-websocket action result.
 */
export async function mockWebSocketTool(
  input: MockWebSocketInput,
  context: ToolContext,
): Promise<ToolResponse<MockWebSocketResult>> {
  const missingSession = requireActiveSession<MockWebSocketResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const manager = getWebSocketMockManager(context.sessionManager.getContext());

  if (input.action === 'add') {
    const mocks = input.mock ? [input.mock] : (input.mocks ?? []);
    await manager.addMocks(mocks);

    return createToolSuccess({
      action: 'add',
      added: mocks.length,
      mocks: manager.listMocks(),
      summary: manager.getSummary(),
    });
  }

  if (input.action === 'clear') {
    manager.clear();

    return createToolSuccess({
      action: 'clear',
      cleared: true,
      summary: manager.getSummary(),
    });
  }

  if (input.action === 'messages') {
    return createToolSuccess({
      action: 'messages',
      messages: manager.getMessages(input.limit),
      summary: manager.getSummary(),
    });
  }

  return createToolSuccess({
    action: 'list',
    mocks: manager.listMocks(),
    summary: manager.getSummary(),
  });
}

/**
 * Manages Playwright routeWebSocket handlers for targeted WebSocket mocks.
 */
export class WebSocketMockRouteManager {
  readonly #browserContext: BrowserContext;

  #mocks: WebSocketMockDefinition[] = [];

  readonly #messageRecords: WebSocketMockMessageRecord[] = [];

  readonly #routeUrls = new Set<string>();

  #activeConnections = 0;

  readonly #maxMessageRecords: number;

  readonly #generationsByUrl = new Map<string, number>();

  readonly #activeSockets = new Set<WebSocketRoute>();

  /**
   * Creates a WebSocket route manager for a browser context.
   *
   * @param browserContext - Browser context that owns route handlers.
   * @param maxMessageRecords - Maximum number of message records to retain.
   */
  constructor(
    browserContext: BrowserContext,
    maxMessageRecords = DEFAULT_MAX_MESSAGE_RECORDS,
  ) {
    this.#browserContext = browserContext;
    this.#maxMessageRecords = maxMessageRecords;
  }

  /**
   * Adds or replaces a WebSocket mock by URL.
   *
   * @param mock - The WebSocket mock definition to add.
   */
  async addMock(mock: WebSocketMockDefinition): Promise<void> {
    const isReplacement = this.#mocks.some(
      (existingMock) => existingMock.url === mock.url,
    );

    this.#mocks = [
      ...this.#mocks.filter((existingMock) => existingMock.url !== mock.url),
      mock,
    ];

    if (isReplacement) {
      this.#generationsByUrl.set(
        mock.url,
        (this.#generationsByUrl.get(mock.url) ?? 0) + 1,
      );
      this.#closeSocketsForUrl(mock.url);
    } else if (!this.#generationsByUrl.has(mock.url)) {
      this.#generationsByUrl.set(mock.url, 0);
    }

    await this.#ensureRouteForUrl(mock.url);
  }

  /**
   * Adds multiple WebSocket mock definitions.
   *
   * @param mocks - The WebSocket mock definitions to add.
   */
  async addMocks(mocks: WebSocketMockDefinition[]): Promise<void> {
    for (const mock of mocks) {
      await this.addMock(mock);
    }
  }

  /**
   * Clears all mocks, message records, and closes active intercepted sockets.
   * Playwright has no unrouteWebSocket, so route handlers remain installed but
   * pass through to the real server for new connections after clear.
   */
  clear(): void {
    for (const url of this.#generationsByUrl.keys()) {
      this.#generationsByUrl.set(
        url,
        (this.#generationsByUrl.get(url) ?? 0) + 1,
      );
    }
    this.#mocks = [];
    this.#messageRecords.length = 0;

    for (const ws of this.#activeSockets) {
      ws.close({ code: 1001, reason: 'mocks cleared' }).catch(() => undefined);
    }
    this.#activeSockets.clear();
    this.#activeConnections = 0;
  }

  /**
   * Lists currently registered WebSocket mock definitions.
   *
   * @returns Registered mock definitions.
   */
  listMocks(): WebSocketMockDefinition[] {
    return [...this.#mocks];
  }

  /**
   * Gets recorded message hits and misses.
   *
   * @param limit - Optional maximum number of newest records to return.
   * @returns Message records in chronological order.
   */
  getMessages(limit?: number): WebSocketMockMessageRecord[] {
    const records = [...this.#messageRecords];
    if (limit === undefined) {
      return records;
    }
    return records.slice(Math.max(records.length - limit, 0));
  }

  /**
   * Gets aggregate message and mock state.
   *
   * @returns WebSocket mock summary.
   */
  getSummary(): WebSocketMockSummary {
    const hits = this.#messageRecords.filter(
      (record) => record.direction === 'client-to-server' && record.matched,
    ).length;
    const misses = this.#messageRecords.filter(
      (record) => record.direction === 'client-to-server' && !record.matched,
    ).length;

    return {
      mockCount: this.#mocks.length,
      messageCount: this.#messageRecords.length,
      hits,
      misses,
      activeConnections: this.#activeConnections,
      lastMatchedUrl: this.#findLastMatchedUrl(),
    };
  }

  /**
   * Ensures a routeWebSocket handler exists for a URL.
   *
   * @param url - The WebSocket URL to route.
   */
  async #ensureRouteForUrl(url: string): Promise<void> {
    if (this.#routeUrls.has(url)) {
      return;
    }

    await this.#browserContext.routeWebSocket(url, (ws) =>
      this.#handleWebSocketRoute(ws),
    );
    this.#routeUrls.add(url);
  }

  /**
   * Handles an intercepted Playwright WebSocket route.
   *
   * @param ws - The intercepted WebSocket route.
   */
  #handleWebSocketRoute(ws: WebSocketRoute): void {
    if (this.#mocks.length === 0) {
      ws.connectToServer();
      return;
    }

    const url = ws.url();
    const mock = this.#findMockForUrl(url);
    if (!mock) {
      ws.connectToServer();
      return;
    }

    this.#activeConnections += 1;
    this.#activeSockets.add(ws);

    const generation = this.#generationsByUrl.get(url) ?? 0;
    const server =
      (mock.passthrough ?? true) ? ws.connectToServer() : undefined;
    let closed = false;

    ws.onMessage((message) => {
      if ((this.#generationsByUrl.get(url) ?? 0) !== generation) {
        return;
      }

      const messageStr =
        typeof message === 'string' ? message : message.toString('utf-8');
      const rule = findMatchingMessageRule(mock.rules, messageStr);

      if (rule) {
        this.#recordMessage(url, 'client-to-server', messageStr, true, rule.id);

        if (rule.respond !== undefined) {
          const responseText =
            typeof rule.respond === 'string'
              ? rule.respond
              : JSON.stringify(rule.respond);
          const delay = rule.delay ?? 0;
          if (delay > 0) {
            setTimeout(() => {
              if (
                !closed &&
                (this.#generationsByUrl.get(url) ?? 0) === generation
              ) {
                safeSend(ws, responseText);
              }
            }, delay);
          } else {
            safeSend(ws, responseText);
          }
        }

        if (rule.followUpResponse !== undefined) {
          const followUpText =
            typeof rule.followUpResponse === 'string'
              ? rule.followUpResponse
              : JSON.stringify(rule.followUpResponse);
          const followUpDelay = (rule.delay ?? 0) + (rule.followUpDelay ?? 0);
          setTimeout(() => {
            if (
              !closed &&
              (this.#generationsByUrl.get(url) ?? 0) === generation
            ) {
              safeSend(ws, followUpText);
            }
          }, followUpDelay);
        }
      } else {
        this.#recordMessage(url, 'client-to-server', messageStr, false);
        if (server) {
          safeSend(server, message);
        }
      }
    });

    ws.onClose((code, reason) => {
      if (closed) {
        return;
      }
      closed = true;
      this.#removeSocket(ws);
      if (server) {
        server.close({ code, reason }).catch(() => undefined);
      }
    });

    if (server) {
      server.onMessage((message) => {
        if ((this.#generationsByUrl.get(url) ?? 0) !== generation) {
          return;
        }

        const messageStr =
          typeof message === 'string' ? message : message.toString('utf-8');
        this.#recordMessage(url, 'server-to-client', messageStr, false);
        safeSend(ws, message);
      });

      server.onClose((code, reason) => {
        if (closed) {
          return;
        }
        closed = true;
        this.#removeSocket(ws);
        ws.close({ code, reason }).catch(() => undefined);
      });
    }
  }

  /**
   * Finds the mock definition for a WebSocket URL.
   *
   * @param url - The concrete WebSocket URL.
   * @returns The matching mock definition, if any.
   */
  #findMockForUrl(url: string): WebSocketMockDefinition | undefined {
    return this.#mocks.find((existingMock) => existingMock.url === url);
  }

  /**
   * Removes a socket from the active tracking set and decrements the
   * connection counter. Returns false if the socket was not tracked
   * (already removed by clear or a prior close).
   *
   * @param ws - The WebSocket route to remove.
   * @returns Whether the socket was tracked and successfully removed.
   */
  #removeSocket(ws: WebSocketRoute): boolean {
    if (!this.#activeSockets.delete(ws)) {
      return false;
    }
    this.#activeConnections -= 1;
    return true;
  }

  /**
   * Closes all active sockets intercepted for a specific URL.
   * Used when replacing a mock to ensure old connections don't continue
   * using stale rules or fire stale delayed responses.
   *
   * @param url - The WebSocket URL whose connections should be closed.
   */
  #closeSocketsForUrl(url: string): void {
    const toClose = [...this.#activeSockets].filter((ws) => ws.url() === url);
    for (const ws of toClose) {
      ws.close({ code: 1001, reason: 'mock replaced' }).catch(() => undefined);
      this.#removeSocket(ws);
    }
  }

  /**
   * Records a hit or miss for a WebSocket message.
   *
   * @param url - The WebSocket URL.
   * @param direction - The message direction.
   * @param message - The message content.
   * @param matched - Whether a rule matched.
   * @param ruleId - The matched rule id, if any.
   */
  #recordMessage(
    url: string,
    direction: 'client-to-server' | 'server-to-client',
    message: string,
    matched: boolean,
    ruleId?: string,
  ): void {
    this.#messageRecords.push({
      timestamp: new Date().toISOString(),
      url,
      direction,
      message: truncateMessage(message),
      matched,
      ...(ruleId ? { ruleId } : {}),
    });

    if (this.#messageRecords.length > this.#maxMessageRecords) {
      this.#messageRecords.splice(
        0,
        this.#messageRecords.length - this.#maxMessageRecords,
      );
    }
  }

  /**
   * Finds the most recent matched URL.
   *
   * @returns The most recent matched URL, if any.
   */
  #findLastMatchedUrl(): string | undefined {
    return [...this.#messageRecords].reverse().find((record) => record.matched)
      ?.url;
  }
}

/**
 * Sends a message on a WebSocket route, silently ignoring errors from
 * closed connections.
 *
 * @param ws - The WebSocket-like object with a send method.
 * @param ws.send - The send method to invoke.
 * @param message - The message to send.
 */
function safeSend(
  ws: { send(message: string | Buffer): void },
  message: string | Buffer,
): void {
  try {
    ws.send(message);
  } catch {
    /* connection closed — nothing to do */
  }
}

/**
 * Gets the WebSocket route manager for a browser context.
 *
 * @param browserContext - Browser context that owns route handlers.
 * @returns A stable manager for the browser context.
 */
export function getWebSocketMockManager(
  browserContext: BrowserContext,
): WebSocketMockRouteManager {
  let manager = webSocketMockManagers.get(browserContext);
  if (!manager) {
    manager = new WebSocketMockRouteManager(browserContext);
    webSocketMockManagers.set(browserContext, manager);
  }
  return manager;
}

/**
 * Finds the first matching message rule for a WebSocket message.
 *
 * @param rules - Rules to match against.
 * @param message - The WebSocket message to match.
 * @returns The matching message rule, if any.
 */
export function findMatchingMessageRule(
  rules: WebSocketMockMessageRule[],
  message: string,
): WebSocketMockMessageRule | undefined {
  return rules.find((rule) =>
    matchesMessagePattern(rule.match.includes, message),
  );
}

/**
 * Checks whether a message matches a pattern.
 *
 * @param includes - The string or strings to look for.
 * @param message - The message to search in.
 * @returns True if all strings appear in the message.
 */
export function matchesMessagePattern(
  includes: string | string[],
  message: string,
): boolean {
  if (typeof includes === 'string') {
    return message.includes(includes);
  }

  return includes.every((pattern) => message.includes(pattern));
}

/**
 * Truncates a message to a maximum length.
 *
 * @param message - The message to truncate.
 * @param maxLength - Maximum length before truncation.
 * @returns The truncated message with ellipsis if needed.
 */
export function truncateMessage(
  message: string,
  maxLength = DEFAULT_MESSAGE_TRUNCATION,
): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength)}...`;
}
