import type {
  BrowserContext,
  Request as PlaywrightRequest,
  Route,
} from '@playwright/test';

import type {
  MockNetworkInput,
  MockNetworkResult,
  NetworkMockContext,
  NetworkMockCoverage,
  NetworkMockPendingContext,
  NetworkMockRecordedBody,
  NetworkMockRequestRecord,
  NetworkMockResponse,
  NetworkMockRouteRule,
  NetworkMockSummary,
} from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import type {
  CdpEventListener,
  CdpEventSession,
  CdpEventTarget,
  CdpManager,
  CdpSessionWatch,
  CdpWatchedSession,
} from '../platform/cdp-manager.js';
import { getCdpManager } from '../platform/cdp-manager.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { debugWarn } from '../utils/logger.js';

const DEFAULT_MAX_REQUEST_RECORDS = 500;
/**
 * Bounds each CDP `Fetch` command. Chrome never times out a paused request,
 * so a hung answer must not keep the handler waiting either.
 */
export const FETCH_COMMAND_TIMEOUT_MS = 5_000;
const PENDING_CONTEXTS: readonly NetworkMockPendingContext[] = [
  'offscreen',
  'iframe',
];
export const DEFAULT_MAX_RECORDED_BODY_BYTES = 64 * 1024;
export const MAX_RECORDED_BODY_BYTES = 512 * 1024;
export const REDACTED_VALUE = '[REDACTED]';
/**
 * How long a forwarded (non-mocked) request waits for its real response
 * before the record is left without a `status`. The wait never delays the
 * request itself.
 */
const FORWARDED_RESPONSE_TIMEOUT_MS = 5000;
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
]);
const SENSITIVE_HEADER_PATTERN = /token|secret|key|auth|session|password/u;
// Exact field names (compared lowercase, without `-` and `_`), so analytics
// properties such as `token_symbol` stay readable.
const SENSITIVE_BODY_FIELDS = new Set([
  'writekey',
  'password',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'privatekey',
  'mnemonic',
  'seedphrase',
  'secretrecoveryphrase',
]);
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
      ...manager.getCoverage(),
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
      requests: manager.getRequests(input.limit, {
        url: input.url,
        includeBodies: input.includeBodies,
      }),
      summary: manager.getSummary(),
    });
  }

  await manager.syncContexts();
  return createToolSuccess({
    action: 'list',
    rules: manager.listRules(),
    summary: manager.getSummary(),
    ...manager.getCoverage(),
  });
}

/** A request pattern of `Fetch.enable`. */
type FetchPattern = { urlPattern: string; requestStage: 'Request' };

/** An offscreen document or iframe session the `Fetch` router intercepts. */
type FetchSession = {
  kind: NetworkMockPendingContext;
  session: CdpEventSession;
  target: () => CdpEventTarget;
  listener: CdpEventListener;
  /** The patterns `Fetch.enable` last succeeded with. */
  enabledKey?: string;
};

/** The request of a `Fetch.requestPaused` event. */
type FetchRequest = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  postDataEntries?: { bytes?: string }[];
};

/** A request to record, from a Playwright route or a CDP `Fetch` pause. */
type InterceptedRequest = {
  method: string;
  url: string;
  context: NetworkMockContext;
  readHeaders: () => Record<string, string>;
  readBody: () => Buffer | null;
};

/**
 * Manages the interception of targeted network mocks.
 *
 * Pages and the Extension service worker are intercepted with Playwright
 * `route()`. Playwright does not see the MV3 offscreen document or its
 * iframes (the snaps iframes), so their requests are intercepted with CDP
 * `Fetch` on the sessions {@link CdpManager.watchSessions} hands over. `Fetch`
 * is never enabled on a page or the service worker: it would conflict with
 * `route()`.
 */
export class NetworkMockRouteManager {
  readonly #browserContext: BrowserContext;

  #rules: NetworkMockRouteRule[] = [];

  readonly #requestRecords: NetworkMockRequestRecord[] = [];

  readonly #routePatterns = new Set<string>();

  readonly #maxRequestRecords: number;

  readonly #fetchSessions = new Set<FetchSession>();

  /** The watch of the offscreen document and iframe sessions, while rules exist. */
  #watch:
    | { manager: CdpManager; watch: Promise<CdpSessionWatch | undefined> }
    | undefined;

  #fetchPatterns: FetchPattern[] = [];

  #fetchPatternKey = '';

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
    await this.syncContexts();
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
    await this.#stopFetch();
  }

  /**
   * Brings the CDP `Fetch` interception of the offscreen document and its
   * iframes in line with the rules: watches their sessions while rules
   * exist, and enables `Fetch` with the current rule origins on each.
   * Never throws: a failure leaves the context in `pending`.
   */
  async syncContexts(): Promise<void> {
    if (this.#rules.length === 0) {
      await this.#stopFetch();
      return;
    }
    this.#fetchPatterns = getFetchPatterns(this.#rules);
    this.#fetchPatternKey = JSON.stringify(this.#fetchPatterns);
    const cdpManager = getFetchCdpManager(this.#browserContext);
    if (cdpManager === undefined) {
      return;
    }
    if (this.#watch?.manager !== cdpManager) {
      // A disposed manager (the browser was relaunched) took its sessions
      // with it; watch the current one.
      await this.#stopFetch();
      const watch = cdpManager
        .watchSessions({
          kinds: PENDING_CONTEXTS,
          onAttach: async (watched) => this.#onFetchAttach(watched),
          onDetach: (target) => this.#onFetchDetach(target),
          onError: (error) => debugWarn('mock-network.fetch', error),
        })
        .catch((error: unknown) => {
          debugWarn('mock-network.fetch', error);
          return undefined;
        });
      this.#watch = { manager: cdpManager, watch };
      if ((await watch) === undefined && this.#watch.watch === watch) {
        this.#watch = undefined;
      }
      return;
    }
    await this.#watch.watch;
    await Promise.all(
      [...this.#fetchSessions]
        .filter(
          (fetchSession) => fetchSession.enabledKey !== this.#fetchPatternKey,
        )
        .map(async (fetchSession) => this.#enableFetch(fetchSession)),
    );
  }

  /**
   * Tells which contexts the rules intercept now. Pages and the service
   * worker are covered by `route()`; the offscreen document and iframes only
   * while a live session has `Fetch` enabled with the current rules.
   *
   * @returns The covered and pending contexts; both empty without rules.
   */
  getCoverage(): NetworkMockCoverage {
    if (this.#rules.length === 0) {
      return { contexts: [], pending: [] };
    }
    const contexts: NetworkMockContext[] = ['page', 'sw'];
    const pending: NetworkMockPendingContext[] = [];
    for (const kind of PENDING_CONTEXTS) {
      const enabled = [...this.#fetchSessions].some(
        (fetchSession) =>
          fetchSession.kind === kind &&
          fetchSession.enabledKey === this.#fetchPatternKey,
      );
      (enabled ? contexts : pending).push(kind);
    }
    return { contexts, pending };
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
   * @param limit - Optional maximum number of newest records to return,
   * applied after the URL filter.
   * @param options - Filter and output options.
   * @param options.url - URL glob (`*`, `**`) or, without `*`, a substring
   * the request URL must contain.
   * @param options.includeBodies - Whether to include recorded request
   * headers and bodies. Defaults to false.
   * @returns Request records in chronological order.
   */
  getRequests(
    limit?: number,
    options: { url?: string; includeBodies?: boolean } = {},
  ): NetworkMockRequestRecord[] {
    const { url, includeBodies = false } = options;
    let records = url
      ? this.#requestRecords.filter((record) =>
          matchesUrlFilter(url, record.url),
        )
      : [...this.#requestRecords];

    if (limit !== undefined) {
      records = records.slice(Math.max(records.length - limit, 0));
    }

    if (includeBodies) {
      return records;
    }

    return records.map(({ body: _body, headers: _headers, ...rest }) => rest);
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
   * A rule with a `response` fulfills the request with the mocked response. A
   * rule with only `record` records the request and forwards it unchanged.
   *
   * @param route - The intercepted route.
   */
  async #handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const matchedRule = findMatchingRule(this.#rules, request);
    const intercepted = fromPlaywrightRequest(request);

    if (!matchedRule) {
      this.#recordRequest(intercepted, false);
      await route.continue();
      return;
    }

    const record = this.#recordRequest(intercepted, true, matchedRule);

    if (!matchedRule.response) {
      await route.continue();
      this.#recordForwardedStatus(request, record).catch(() => undefined);
      return;
    }

    await route.fulfill({
      status: matchedRule.response.status ?? 200,
      headers: buildResponseHeaders(matchedRule.response),
      body: buildResponseBody(matchedRule.response),
    });
  }

  /**
   * Starts intercepting an offscreen document or iframe session: listens for
   * paused requests, then enables `Fetch` for the rule origins.
   *
   * @param watched - The session handed over by the CDP manager.
   */
  async #onFetchAttach(watched: CdpWatchedSession): Promise<void> {
    const fetchSession: FetchSession = {
      kind: watched.target().kind as NetworkMockPendingContext,
      session: watched.session,
      target: watched.target,
      listener: (params) => {
        // eslint-disable-next-line no-void
        void this.#handlePaused(fetchSession, params);
      },
    };
    watched.session.on('Fetch.requestPaused', fetchSession.listener);
    this.#fetchSessions.add(fetchSession);
    await this.#enableFetch(fetchSession);
  }

  /**
   * Forgets the session of a target that went away. Its `Fetch` went with it.
   *
   * @param target - The detached target.
   */
  #onFetchDetach(target: CdpEventTarget): void {
    for (const fetchSession of [...this.#fetchSessions]) {
      if (
        fetchSession.kind === target.kind &&
        fetchSession.target().targetId === target.targetId
      ) {
        fetchSession.session.off('Fetch.requestPaused', fetchSession.listener);
        this.#fetchSessions.delete(fetchSession);
      }
    }
  }

  /**
   * Enables `Fetch` with the current rule origins on a session. On failure
   * the session keeps its listener (an enable that timed out may still land,
   * and every paused request must be answered) and stays pending.
   *
   * @param fetchSession - The session.
   */
  async #enableFetch(fetchSession: FetchSession): Promise<void> {
    const key = this.#fetchPatternKey;
    try {
      await withFetchTimeout(
        fetchSession.session.send('Fetch.enable', {
          patterns: this.#fetchPatterns,
        }),
        'Fetch.enable',
      );
      // The key names the patterns this enable sent; a later enable with
      // other patterns records its own key.
      // eslint-disable-next-line require-atomic-updates
      fetchSession.enabledKey = key;
    } catch (error) {
      debugWarn('mock-network.fetch', error);
    }
  }

  /**
   * Stops the CDP `Fetch` interception: ends the watch, then disables
   * `Fetch` and removes the listener on each session.
   */
  async #stopFetch(): Promise<void> {
    const current = this.#watch;
    this.#watch = undefined;
    const sessions = [...this.#fetchSessions];
    this.#fetchSessions.clear();
    await (await current?.watch)?.unwatch();
    await Promise.all(
      sessions.map(async (fetchSession) => {
        // The listener stays until `Fetch` is off, so a request paused
        // meanwhile is still answered.
        await withFetchTimeout(
          fetchSession.session.send('Fetch.disable', {}),
          'Fetch.disable',
        ).catch(() => undefined);
        fetchSession.session.off('Fetch.requestPaused', fetchSession.listener);
      }),
    );
  }

  /**
   * Answers a request paused by CDP `Fetch` on an offscreen document or
   * iframe session, like {@link #handleRoute} does for a Playwright route.
   * Every paused request is answered: Chrome never resumes it by itself.
   *
   * A CORS preflight is not recorded, as with `route()`. A snaps iframe has
   * an opaque origin, so its JSON `POST` is preflighted: the preflight of a
   * mocked request is fulfilled, see {@link buildPreflightResponse}.
   *
   * @param fetchSession - The session the request was paused on.
   * @param params - The `Fetch.requestPaused` payload.
   * @returns Once the request is answered. Never rejects.
   */
  async #handlePaused(
    fetchSession: FetchSession,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string') {
      return;
    }
    let answered = false;
    const answer = async (
      method: 'Fetch.continueRequest' | 'Fetch.fulfillRequest',
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      await withFetchTimeout(
        fetchSession.session.send(method, { requestId, ...extra }),
        method,
      );
      answered = true;
    };
    try {
      const request = (params?.request ?? {}) as FetchRequest;
      const method = request.method ?? 'GET';
      const url = request.url ?? '';
      const headers = lowercaseHeaders(request.headers);
      if (this.#rules.length === 0) {
        await answer('Fetch.continueRequest');
        return;
      }

      const matchedRule = findMatchingRule(this.#rules, {
        method: () => method,
        url: () => url,
      });
      if (!matchedRule && isCorsPreflight(method, headers)) {
        const preflight = buildPreflightResponse(this.#rules, url, headers);
        await (preflight
          ? answer('Fetch.fulfillRequest', preflight)
          : answer('Fetch.continueRequest'));
        return;
      }
      this.#recordRequest(
        {
          method,
          url,
          context: fetchSession.kind,
          readHeaders: () => headers,
          readBody: () => readFetchPostData(request),
        },
        matchedRule !== undefined,
        matchedRule,
      );
      if (!matchedRule?.response) {
        await answer('Fetch.continueRequest');
        return;
      }
      await answer('Fetch.fulfillRequest', {
        responseCode: matchedRule.response.status ?? 200,
        responseHeaders: toHeaderEntries(
          buildResponseHeaders(matchedRule.response),
        ),
        body: Buffer.from(
          buildResponseBody(matchedRule.response),
          'utf8',
        ).toString('base64'),
      });
    } catch (error) {
      debugWarn('mock-network.fetch', error);
    } finally {
      if (!answered) {
        await withFetchTimeout(
          fetchSession.session.send('Fetch.continueRequest', { requestId }),
          'Fetch.continueRequest',
        ).catch(() => undefined);
      }
    }
  }

  /**
   * Records the real status of a forwarded request once its response arrives.
   *
   * Best effort: this never delays the request, and the record keeps no
   * `status` when the response is not received in time or the request fails.
   *
   * @param request - The forwarded Playwright request.
   * @param record - The request record to update.
   */
  async #recordForwardedStatus(
    request: PlaywrightRequest,
    record: NetworkMockRequestRecord,
  ): Promise<void> {
    const status = await readResponseStatus(request);
    if (status !== undefined) {
      record.status = status;
    }
  }

  /**
   * Records a hit or miss for an intercepted request.
   *
   * Headers and the body are stored only when the matched rule opts in via
   * `record`.
   *
   * @param request - The intercepted request.
   * @param matched - Whether a rule matched.
   * @param rule - The matched rule, if any.
   * @returns The record that was stored.
   */
  #recordRequest(
    request: InterceptedRequest,
    matched: boolean,
    rule?: NetworkMockRouteRule,
  ): NetworkMockRequestRecord {
    const ruleId = rule?.id;
    const status = rule?.response?.status;
    const recordOptions = rule?.record;
    const headers =
      recordOptions?.headers || recordOptions?.body
        ? request.readHeaders()
        : {};

    const record: NetworkMockRequestRecord = {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      matched,
      ...(ruleId ? { ruleId } : {}),
      ...(status ? { status } : {}),
      context: request.context,
      ...(request.context === 'sw' ? { serviceWorker: true } : {}),
      ...(recordOptions?.headers ? { headers: redactHeaders(headers) } : {}),
      ...(recordOptions?.body
        ? {
            body: recordRequestBody(
              request.readBody(),
              headers['content-type'],
              recordOptions.maxBodyBytes,
            ),
          }
        : {}),
    };
    this.#requestRecords.push(record);

    if (this.#requestRecords.length > this.#maxRequestRecords) {
      this.#requestRecords.splice(
        0,
        this.#requestRecords.length - this.#maxRequestRecords,
      );
    }

    return record;
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
 * Returns the CDP `Fetch.enable` patterns for the origins of the rules, in
 * rule order. Never a catch-all `*`: pausing every request of the offscreen
 * document would stall it on any slow answer.
 *
 * @param rules - The mock rules.
 * @returns One request-stage pattern per rule origin.
 */
export function getFetchPatterns(
  rules: NetworkMockRouteRule[],
): FetchPattern[] {
  const origins = new Set(rules.map((rule) => new URL(rule.url).origin));
  return [...origins].map((origin) => ({
    urlPattern: `${origin}/*`,
    requestStage: 'Request',
  }));
}

/**
 * Checks whether a request is a browser CORS preflight.
 *
 * @param method - The request method.
 * @param headers - The request headers, with lowercase names.
 * @returns True for `OPTIONS` with `access-control-request-method`.
 */
export function isCorsPreflight(
  method: string,
  headers: Record<string, string>,
): boolean {
  return (
    method.toUpperCase() === 'OPTIONS' &&
    Boolean(headers['access-control-request-method'])
  );
}

/**
 * Builds the answer to a CORS preflight for a mocked request, as Playwright
 * does for `route()`: 204 with headers allowing the requested method and
 * headers. A forwarded request gets none, so it keeps the real server's
 * CORS answer.
 *
 * @param rules - The mock rules.
 * @param url - The request URL.
 * @param headers - The preflight headers, with lowercase names.
 * @returns The `Fetch.fulfillRequest` parameters, or undefined when no rule
 * with a `response` matches the requested method.
 */
export function buildPreflightResponse(
  rules: NetworkMockRouteRule[],
  url: string,
  headers: Record<string, string>,
):
  | { responseCode: number; responseHeaders: { name: string; value: string }[] }
  | undefined {
  const requestedMethod = headers['access-control-request-method'] ?? '';
  const rule = findMatchingRule(rules, {
    method: () => requestedMethod,
    url: () => url,
  });
  if (!rule?.response) {
    return undefined;
  }
  const { origin } = headers;
  const concreteOrigin = origin !== undefined && origin !== 'null';
  return {
    responseCode: 204,
    responseHeaders: toHeaderEntries({
      'access-control-allow-origin': concreteOrigin ? origin : '*',
      'access-control-allow-methods': requestedMethod,
      'access-control-allow-headers':
        headers['access-control-request-headers'] ?? '*',
      ...(concreteOrigin ? { 'access-control-allow-credentials': 'true' } : {}),
    }),
  };
}

/**
 * Converts headers to the CDP `Fetch` header list.
 *
 * @param headers - Headers by name.
 * @returns The `{ name, value }` entries.
 */
function toHeaderEntries(
  headers: Record<string, string>,
): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/**
 * Returns headers with lowercase names.
 *
 * @param headers - The headers, if any.
 * @returns The headers with lowercase names.
 */
function lowercaseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const lowercase: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    lowercase[name.toLowerCase()] = value;
  }
  return lowercase;
}

/**
 * Reads the body of a request paused by CDP `Fetch`.
 *
 * @param request - The paused request.
 * @returns The body bytes, or null when the event carries none.
 */
function readFetchPostData(request: FetchRequest): Buffer | null {
  const entries = request.postDataEntries ?? [];
  if (entries.length > 0) {
    return Buffer.concat(
      entries.map((entry) => Buffer.from(entry.bytes ?? '', 'base64')),
    );
  }
  return typeof request.postData === 'string'
    ? Buffer.from(request.postData, 'utf8')
    : null;
}

/**
 * Bounds a CDP `Fetch` command by {@link FETCH_COMMAND_TIMEOUT_MS}.
 *
 * @param operation - The CDP send.
 * @param method - The CDP method, used in the timeout error.
 * @returns The CDP result.
 */
async function withFetchTimeout(
  operation: Promise<unknown>,
  method: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A send still pending after the timeout settles later; ignore it.
  operation.catch(() => undefined);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `CDP call "${method}" timed out after ${FETCH_COMMAND_TIMEOUT_MS}ms`,
              ),
            ),
          FETCH_COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the CDP manager of a Chromium browser context, which watches the
 * offscreen document and its iframes.
 *
 * @param browserContext - The browser context.
 * @returns The manager, or undefined without a browser to attach to.
 */
function getFetchCdpManager(
  browserContext: BrowserContext,
): CdpManager | undefined {
  try {
    if (
      typeof browserContext.browser !== 'function' ||
      browserContext.browser() === null
    ) {
      return undefined;
    }
    return getCdpManager(browserContext);
  } catch (error) {
    debugWarn('mock-network.fetch', error);
    return undefined;
  }
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
 * Builds response headers for a mocked response.
 *
 * @param response - The mocked response.
 * @returns Headers for Playwright route fulfillment.
 */
function buildResponseHeaders(
  response: NetworkMockResponse,
): Record<string, string> {
  const defaultHeaders = hasJsonResponse(response)
    ? DEFAULT_JSON_HEADERS
    : DEFAULT_TEXT_HEADERS;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }

  return {
    ...defaultHeaders,
    ...normalized,
  };
}

/**
 * Builds a response body for a mocked response.
 *
 * @param response - The mocked response.
 * @returns Body for Playwright route fulfillment.
 */
function buildResponseBody(response: NetworkMockResponse): string {
  if (hasJsonResponse(response)) {
    return JSON.stringify(response.json);
  }

  return response.body ?? '';
}

/**
 * Checks whether a mocked response contains a JSON payload.
 *
 * @param response - The mocked response to inspect.
 * @returns True if the response has a json property.
 */
function hasJsonResponse(response: NetworkMockResponse): boolean {
  return Object.prototype.hasOwnProperty.call(response, 'json');
}

/**
 * Checks whether a request URL matches a `requests --url` filter. A filter
 * with `*` is a URL glob; any other filter is a substring match.
 *
 * @param filter - URL glob or substring.
 * @param url - The recorded request URL.
 * @returns True if the URL matches the filter.
 */
export function matchesUrlFilter(filter: string, url: string): boolean {
  if (filter.includes('*')) {
    return matchesUrlPattern(filter, url);
  }
  return url.includes(filter);
}

/**
 * Checks whether a request header name is sensitive and must be redacted.
 *
 * @param name - The header name.
 * @returns True if the header value must not be recorded.
 */
export function isSensitiveHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(lowerName) ||
    SENSITIVE_HEADER_PATTERN.test(lowerName)
  );
}

/**
 * Returns request headers with lowercase names and sensitive values
 * redacted.
 *
 * @param headers - The request headers.
 * @returns The headers safe to record.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name.toLowerCase()] = isSensitiveHeader(name)
      ? REDACTED_VALUE
      : value;
  }
  return redacted;
}

/**
 * Checks whether a body field name holds a secret.
 *
 * @param name - The JSON field name.
 * @returns True if the field value must be redacted.
 */
export function isSensitiveBodyField(name: string): boolean {
  return SENSITIVE_BODY_FIELDS.has(name.toLowerCase().replace(/[-_]/gu, ''));
}

/**
 * Replaces the values of sensitive fields in a parsed JSON value.
 *
 * @param value - The parsed JSON value.
 * @returns A copy with sensitive field values redacted.
 */
export function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }

  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      redacted[key] = isSensitiveBodyField(key)
        ? REDACTED_VALUE
        : redactJsonValue(fieldValue);
    }
    return redacted;
  }

  return value;
}

/**
 * Converts a captured request body to a bounded, redacted record.
 *
 * - JSON bodies (JSON content type, or text that parses as JSON) are parsed
 *   and sensitive fields such as `writeKey` are redacted, whatever the value
 *   type.
 * - A JSON body cut by `maxBytes` is recorded as `{ type: 'json', size,
 *   truncated: true }` with no value: the kept prefix does not parse, so a
 *   value of any type cannot be redacted reliably. Raise `maxBodyBytes` to
 *   get the value.
 * - JSON-like text that does not parse is recorded as `{ type: 'text', size,
 *   redacted: true }` with no value, for the same reason.
 * - Other UTF-8 text is kept as text. Sensitive form fields are redacted.
 * - Binary bodies are not stored; only the type and size are recorded.
 *
 * @param buffer - The raw request body, or null if there is none.
 * @param contentType - The request content type, if known.
 * @param maxBytes - Maximum number of body bytes to keep.
 * @returns The recorded body.
 */
export function recordRequestBody(
  buffer: Buffer | null,
  contentType?: string,
  maxBytes = DEFAULT_MAX_RECORDED_BODY_BYTES,
): NetworkMockRecordedBody {
  if (!buffer || buffer.length === 0) {
    return { type: 'empty', size: 0 };
  }

  const size = buffer.length;
  const limit = Math.min(Math.max(maxBytes, 1), MAX_RECORDED_BODY_BYTES);
  const truncated = size > limit;
  const kept = truncated
    ? trimToUtf8Boundary(buffer.subarray(0, limit))
    : buffer;

  if (isBinaryContentType(contentType) || !isProbablyText(kept)) {
    return { type: 'binary', size };
  }

  const text = kept.toString('utf8');
  const jsonLike = isJsonContentType(contentType) || looksLikeJson(text);

  if (jsonLike && truncated) {
    // A truncated JSON body cannot be parsed, and text redaction cannot cover
    // non-string values (arrays, objects, numbers), so no value is kept.
    return { type: 'json', size, truncated: true };
  }

  if (jsonLike) {
    try {
      return {
        type: 'json',
        size,
        value: redactJsonValue(JSON.parse(text)),
      };
    } catch {
      // JSON-like text that does not parse cannot be redacted reliably, so
      // the value is withheld instead of being recorded unredacted.
      return { type: 'text', size, redacted: true };
    }
  }

  return {
    type: 'text',
    size,
    ...(truncated ? { truncated: true } : {}),
    value: redactFormBody(text, contentType),
  };
}

/**
 * Redacts sensitive values in a form-encoded text body.
 *
 * @param text - The body text.
 * @param contentType - The request content type, if known.
 * @returns The text with sensitive form field values redacted.
 */
function redactFormBody(text: string, contentType?: string): string {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return text;
  }

  const params = new URLSearchParams(text);
  for (const key of new Set(params.keys())) {
    if (isSensitiveBodyField(key)) {
      params.set(key, REDACTED_VALUE);
    }
  }
  return params.toString();
}

/**
 * Checks whether a content type is JSON.
 *
 * @param contentType - The content type header value.
 * @returns True for `application/json` and `+json` types.
 */
function isJsonContentType(contentType?: string): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * Checks whether a content type is known to be binary.
 *
 * @param contentType - The content type header value.
 * @returns True for image, audio, video, font, octet-stream, protobuf and
 * multipart bodies.
 */
function isBinaryContentType(contentType?: string): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    /^(?:image|audio|video|font)\//u.test(mediaType) ||
    mediaType === 'application/octet-stream' ||
    mediaType.includes('protobuf') ||
    mediaType.startsWith('multipart/')
  );
}

/**
 * Checks whether text starts like a JSON object or array.
 *
 * @param text - The body text.
 * @returns True if the first non-space character is `{` or `[`.
 */
function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

/**
 * Checks whether a buffer is probably UTF-8 text. A NUL byte, or a body that
 * does not decode as valid UTF-8, is treated as binary.
 *
 * @param buffer - The body bytes.
 * @returns True if the bytes look like text.
 */
function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops a multi-byte UTF-8 character that was cut off at the end of a
 * truncated buffer.
 *
 * @param buffer - The truncated body bytes.
 * @returns The buffer, ending on a UTF-8 character boundary.
 */
function trimToUtf8Boundary(buffer: Buffer): Buffer {
  // A UTF-8 character is at most 4 bytes, so at most 3 bytes can dangle.
  for (let drop = 0; drop <= 3 && drop < buffer.length; drop++) {
    const candidate = buffer.subarray(0, buffer.length - drop);
    if (isProbablyText(candidate)) {
      return candidate;
    }
  }
  return buffer;
}

/**
 * Wraps a Playwright request for recording.
 *
 * @param request - The intercepted Playwright request.
 * @returns The request to record.
 */
function fromPlaywrightRequest(request: PlaywrightRequest): InterceptedRequest {
  return {
    method: request.method(),
    url: request.url(),
    context: isServiceWorkerRequest(request) ? 'sw' : 'page',
    readHeaders: () => readRequestHeaders(request),
    readBody: () => readPostDataBuffer(request),
  };
}

/**
 * Reads request headers with lowercase names, without throwing.
 *
 * @param request - The intercepted Playwright request.
 * @returns The request headers, or an empty object.
 */
function readRequestHeaders(
  request: PlaywrightRequest,
): Record<string, string> {
  try {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers())) {
      headers[name.toLowerCase()] = value;
    }
    return headers;
  } catch {
    return {};
  }
}

/**
 * Reads the request body without throwing.
 *
 * @param request - The intercepted Playwright request.
 * @returns The request body bytes, or null.
 */
function readPostDataBuffer(request: PlaywrightRequest): Buffer | null {
  try {
    return request.postDataBuffer();
  } catch {
    return null;
  }
}

/**
 * Reads the real status of a forwarded request, without throwing.
 *
 * The wait is bounded by {@link FORWARDED_RESPONSE_TIMEOUT_MS} so an
 * unanswered request cannot leak a pending promise.
 *
 * @param request - The forwarded Playwright request.
 * @returns The response status, or undefined if it is not available.
 */
async function readResponseStatus(
  request: PlaywrightRequest,
): Promise<number | undefined> {
  try {
    const statusPromise = request
      .response()
      .then((response) => response?.status())
      .catch(() => undefined);

    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(
        () => resolve(undefined),
        FORWARDED_RESPONSE_TIMEOUT_MS,
      );
      timer.unref();
    });

    return await Promise.race([statusPromise, timeout]);
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a request was sent by a service worker.
 *
 * @param request - The intercepted Playwright request.
 * @returns True if Playwright reports a service worker for the request.
 */
function isServiceWorkerRequest(request: PlaywrightRequest): boolean {
  try {
    return Boolean(request.serviceWorker());
  } catch {
    return false;
  }
}
