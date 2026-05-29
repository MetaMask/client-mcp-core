import type {
  BrowserContext,
  Request as PlaywrightRequest,
  Route,
} from '@playwright/test';

import type {
  MockNetworkInput,
  MockNetworkResult,
  NetworkMockRequestRecord,
  NetworkMockRouteRule,
  NetworkMockSummary,
} from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

const DEFAULT_MAX_REQUEST_RECORDS = 500;
const DEFAULT_JSON_HEADERS = {
  'access-control-allow-origin': '*',
  'content-type': 'application/json',
};
const DEFAULT_TEXT_HEADERS = {
  'access-control-allow-origin': '*',
  'content-type': 'text/plain',
};
const networkMockManagers = new WeakMap<
  BrowserContext,
  NetworkMockRouteManager
>();

/**
 * Adds, clears, lists, and inspects targeted network mocks for the active
 * browser session.
 *
 * @param input - The mock-network action and payload.
 * @param context - The tool execution context.
 * @returns The mock-network action result.
 */
export async function mockNetworkTool(
  input: MockNetworkInput,
  context: ToolContext,
): Promise<ToolResponse<MockNetworkResult>> {
  const missingSession = requireActiveSession<MockNetworkResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const manager = getNetworkMockManager(context.sessionManager.getContext());

  if (input.action === 'add') {
    const routes = input.rule ? [input.rule] : (input.routes ?? []);
    await manager.addRules(routes);

    return createToolSuccess({
      action: 'add',
      added: routes.length,
      rules: manager.listRules(),
      summary: manager.getSummary(),
    });
  }

  if (input.action === 'clear') {
    await manager.clear();

    return createToolSuccess({
      action: 'clear',
      cleared: true,
      summary: manager.getSummary(),
    });
  }

  if (input.action === 'requests') {
    return createToolSuccess({
      action: 'requests',
      requests: manager.getRequests(input.limit),
      summary: manager.getSummary(),
    });
  }

  return createToolSuccess({
    action: 'list',
    rules: manager.listRules(),
    summary: manager.getSummary(),
  });
}

/**
 * Manages Playwright route handlers for targeted network mocks.
 */
export class NetworkMockRouteManager {
  readonly #browserContext: BrowserContext;

  #rules: NetworkMockRouteRule[] = [];

  readonly #requestRecords: NetworkMockRequestRecord[] = [];

  readonly #routePatterns = new Set<string>();

  readonly #maxRequestRecords: number;

  readonly #routeHandler = async (route: Route): Promise<void> => {
    await this.#handleRoute(route);
  };

  /**
   * Creates a route manager for a browser context.
   *
   * @param browserContext - Browser context that owns route handlers.
   * @param maxRequestRecords - Maximum number of request records to retain.
   */
  constructor(
    browserContext: BrowserContext,
    maxRequestRecords = DEFAULT_MAX_REQUEST_RECORDS,
  ) {
    this.#browserContext = browserContext;
    this.#maxRequestRecords = maxRequestRecords;
  }

  /**
   * Adds or replaces a route rule by id.
   *
   * @param rule - The route rule to add.
   */
  async addRule(rule: NetworkMockRouteRule): Promise<void> {
    const replaced = this.#rules.find(
      (existingRule) => existingRule.id === rule.id,
    );
    this.#rules = [
      ...this.#rules.filter((existingRule) => existingRule.id !== rule.id),
      rule,
    ];
    await this.#ensureRouteForRule(rule);
    if (replaced) {
      await this.#removeOrphanedPattern(replaced);
    }
  }

  /**
   * Adds multiple route rules.
   *
   * @param rules - The route rules to add.
   */
  async addRules(rules: NetworkMockRouteRule[]): Promise<void> {
    for (const rule of rules) {
      await this.addRule(rule);
    }
  }

  /**
   * Clears all rules, request records, and installed routes.
   */
  async clear(): Promise<void> {
    this.#rules = [];
    this.#requestRecords.length = 0;
    await this.#unrouteAll();
  }

  /**
   * Lists currently registered route rules.
   *
   * @returns Registered route rules.
   */
  listRules(): NetworkMockRouteRule[] {
    return [...this.#rules];
  }

  /**
   * Gets recorded request hits and misses.
   *
   * @param limit - Optional maximum number of newest records to return.
   * @returns Request records in chronological order.
   */
  getRequests(limit?: number): NetworkMockRequestRecord[] {
    const records = [...this.#requestRecords];
    if (limit === undefined) {
      return records;
    }
    return records.slice(Math.max(records.length - limit, 0));
  }

  /**
   * Gets aggregate request and route state.
   *
   * @returns Network mock summary.
   */
  getSummary(): NetworkMockSummary {
    const hits = this.#requestRecords.filter((record) => record.matched).length;
    const misses = this.#requestRecords.length - hits;
    const lastRequest = this.#requestRecords.at(-1);

    return {
      ruleCount: this.#rules.length,
      requestCount: this.#requestRecords.length,
      hits,
      misses,
      lastMatchedUrl: this.#findLastMatchedUrl(),
      lastRequestUrl: lastRequest?.url,
    };
  }

  /**
   * Ensures a host-scoped route exists for a rule.
   *
   * @param rule - The rule whose origin should be routed.
   */
  async #ensureRouteForRule(rule: NetworkMockRouteRule): Promise<void> {
    const pattern = getOriginRoutePattern(rule.url);
    if (this.#routePatterns.has(pattern)) {
      return;
    }

    await this.#browserContext.route(pattern, this.#routeHandler);
    this.#routePatterns.add(pattern);
  }

  /**
   * Removes the route pattern for a replaced rule if no remaining rule uses
   * the same origin.
   *
   * @param replaced - The rule that was just replaced.
   */
  async #removeOrphanedPattern(replaced: NetworkMockRouteRule): Promise<void> {
    const oldPattern = getOriginRoutePattern(replaced.url);
    const stillUsed = this.#rules.some(
      (rule) => getOriginRoutePattern(rule.url) === oldPattern,
    );
    if (stillUsed || !this.#routePatterns.has(oldPattern)) {
      return;
    }

    await this.#browserContext
      .unroute(oldPattern, this.#routeHandler)
      .catch(() => undefined);
    this.#routePatterns.delete(oldPattern);
  }

  /**
   * Removes all installed route handlers from the browser context.
   */
  async #unrouteAll(): Promise<void> {
    await Promise.all(
      [...this.#routePatterns].map(async (pattern) => {
        await this.#browserContext
          .unroute(pattern, this.#routeHandler)
          .catch(() => undefined);
      }),
    );
    this.#routePatterns.clear();
  }

  /**
   * Handles an intercepted Playwright route.
   *
   * @param route - The intercepted route.
   */
  async #handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const matchedRule = findMatchingRule(this.#rules, request);

    if (!matchedRule) {
      this.#recordRequest(request, false);
      await route.continue();
      return;
    }

    this.#recordRequest(
      request,
      true,
      matchedRule.id,
      matchedRule.response.status,
    );
    await route.fulfill({
      status: matchedRule.response.status ?? 200,
      headers: buildResponseHeaders(matchedRule),
      body: buildResponseBody(matchedRule),
    });
  }

  /**
   * Records a hit or miss for an intercepted request.
   *
   * @param request - The intercepted Playwright request.
   * @param matched - Whether a rule matched.
   * @param ruleId - The matched rule id, if any.
   * @param status - The fulfilled response status, if any.
   */
  #recordRequest(
    request: PlaywrightRequest,
    matched: boolean,
    ruleId?: string,
    status?: number,
  ): void {
    this.#requestRecords.push({
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      matched,
      ...(ruleId ? { ruleId } : {}),
      ...(status ? { status } : {}),
    });

    if (this.#requestRecords.length > this.#maxRequestRecords) {
      this.#requestRecords.splice(
        0,
        this.#requestRecords.length - this.#maxRequestRecords,
      );
    }
  }

  /**
   * Finds the most recent matched URL.
   *
   * @returns The most recent matched URL, if any.
   */
  #findLastMatchedUrl(): string | undefined {
    return [...this.#requestRecords].reverse().find((record) => record.matched)
      ?.url;
  }
}

/**
 * Gets the route manager for a browser context.
 *
 * @param browserContext - Browser context that owns route handlers.
 * @returns A stable manager for the browser context.
 */
export function getNetworkMockManager(
  browserContext: BrowserContext,
): NetworkMockRouteManager {
  let manager = networkMockManagers.get(browserContext);
  if (!manager) {
    manager = new NetworkMockRouteManager(browserContext);
    networkMockManagers.set(browserContext, manager);
  }
  return manager;
}

/**
 * Finds the newest matching rule for a Playwright request.
 *
 * @param rules - Rules to match against.
 * @param request - The Playwright request to match.
 * @returns The matching route rule, if any.
 */
export function findMatchingRule(
  rules: NetworkMockRouteRule[],
  request: Pick<PlaywrightRequest, 'method' | 'url'>,
): NetworkMockRouteRule | undefined {
  const requestMethod = request.method().toUpperCase();
  const requestUrl = request.url();

  return [...rules]
    .reverse()
    .find(
      (rule) =>
        rule.method.toUpperCase() === requestMethod &&
        matchesUrlPattern(rule.url, requestUrl),
    );
}

/**
 * Returns the Playwright route pattern for the origin of a mock rule URL.
 *
 * @param urlPattern - Absolute http(s) URL or URL glob.
 * @returns A host-scoped Playwright glob pattern.
 */
export function getOriginRoutePattern(urlPattern: string): string {
  const url = new URL(urlPattern);
  return `${url.origin}/**`;
}

/**
 * Checks whether a concrete request URL matches a rule URL pattern.
 * Supports exact URLs and simple glob wildcards (`*` and `**`).
 *
 * @param pattern - The rule URL pattern.
 * @param url - The concrete request URL.
 * @returns True if the URL matches the pattern.
 */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === url;
  }

  return globToRegExp(pattern).test(url);
}

/**
 * Converts a simple URL glob to a regular expression.
 *
 * @param pattern - The URL glob to convert.
 * @returns Regular expression matching the glob.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const nextChar = pattern[index + 1];

    if (char === '*' && nextChar === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`, 'u');
}

/**
 * Escapes a string for use in a RegExp source.
 *
 * @param value - The literal string to escape.
 * @returns The escaped string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}

/**
 * Builds response headers for a rule.
 *
 * @param rule - The matched route rule.
 * @returns Headers for Playwright route fulfillment.
 */
function buildResponseHeaders(
  rule: NetworkMockRouteRule,
): Record<string, string> {
  const defaultHeaders = hasJsonResponse(rule)
    ? DEFAULT_JSON_HEADERS
    : DEFAULT_TEXT_HEADERS;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule.response.headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }

  return {
    ...defaultHeaders,
    ...normalized,
  };
}

/**
 * Builds a response body for a rule.
 *
 * @param rule - The matched route rule.
 * @returns Body for Playwright route fulfillment.
 */
function buildResponseBody(rule: NetworkMockRouteRule): string {
  if (hasJsonResponse(rule)) {
    return JSON.stringify(rule.response.json);
  }

  return rule.response.body ?? '';
}

/**
 * Checks whether a rule contains a JSON response payload.
 *
 * @param rule - The route rule to inspect.
 * @returns True if the response has a json property.
 */
function hasJsonResponse(rule: NetworkMockRouteRule): boolean {
  return Object.prototype.hasOwnProperty.call(rule.response, 'json');
}
