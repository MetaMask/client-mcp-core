import type {
  BrowserContext,
  Request as PlaywrightRequest,
  Route,
} from '@playwright/test';

import type {
  MockNetworkInput,
  MockNetworkResult,
  NetworkMockRecordedBody,
  NetworkMockRequestRecord,
  NetworkMockRouteRule,
  NetworkMockSummary,
} from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

const DEFAULT_MAX_REQUEST_RECORDS = 500;
export const DEFAULT_MAX_RECORDED_BODY_BYTES = 64 * 1024;
export const MAX_RECORDED_BODY_BYTES = 512 * 1024;
export const REDACTED_VALUE = '[REDACTED]';
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
// Matches `"field": "value"` pairs. The closing quote is optional so a value
// cut off by truncation is still redacted.
const JSON_STRING_FIELD_PATTERN =
  /"([^"\\]{1,64})"(\s*:\s*)"(?:[^"\\]|\\.)*(?:"|\\?$)/gu;
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
      requests: manager.getRequests(input.limit, {
        url: input.url,
        includeBodies: input.includeBodies,
      }),
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

    this.#recordRequest(request, true, matchedRule);
    await route.fulfill({
      status: matchedRule.response.status ?? 200,
      headers: buildResponseHeaders(matchedRule),
      body: buildResponseBody(matchedRule),
    });
  }

  /**
   * Records a hit or miss for an intercepted request.
   *
   * Headers and the body are stored only when the matched rule opts in via
   * `record`.
   *
   * @param request - The intercepted Playwright request.
   * @param matched - Whether a rule matched.
   * @param rule - The matched rule, if any.
   */
  #recordRequest(
    request: PlaywrightRequest,
    matched: boolean,
    rule?: NetworkMockRouteRule,
  ): void {
    const ruleId = rule?.id;
    const status = rule?.response.status;
    const recordOptions = rule?.record;
    const headers =
      recordOptions?.headers || recordOptions?.body
        ? readRequestHeaders(request)
        : {};

    this.#requestRecords.push({
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      matched,
      ...(ruleId ? { ruleId } : {}),
      ...(status ? { status } : {}),
      ...(isServiceWorkerRequest(request) ? { serviceWorker: true } : {}),
      ...(recordOptions?.headers ? { headers: redactHeaders(headers) } : {}),
      ...(recordOptions?.body
        ? {
            body: recordRequestBody(
              readPostDataBuffer(request),
              headers['content-type'],
              recordOptions.maxBodyBytes,
            ),
          }
        : {}),
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
function isSensitiveBodyField(name: string): boolean {
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
 * Replaces the values of sensitive `"field": "value"` pairs in JSON-like
 * text that could not be parsed (for example a truncated body).
 *
 * @param text - The body text.
 * @returns The text with sensitive string values redacted.
 */
function redactJsonText(text: string): string {
  return text.replace(
    JSON_STRING_FIELD_PATTERN,
    (match, key: string, separator: string) =>
      isSensitiveBodyField(key)
        ? `"${key}"${separator}"${REDACTED_VALUE}"`
        : match,
  );
}

/**
 * Converts a captured request body to a bounded, redacted record.
 *
 * - JSON bodies (JSON content type, or text that parses as JSON) are parsed
 * and sensitive fields such as `writeKey` are redacted.
 * - Other UTF-8 text is kept as text.
 * - Binary bodies are not stored; only the type and size are recorded.
 * - Bodies larger than `maxBytes` are cut to `maxBytes` and kept as text
 * with `truncated: true`.
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

  if (!truncated && jsonLike) {
    try {
      return {
        type: 'json',
        size,
        value: redactJsonValue(JSON.parse(text)),
      };
    } catch {
      // Not valid JSON; keep it as text below.
    }
  }

  return {
    type: 'text',
    size,
    ...(truncated ? { truncated: true } : {}),
    value: redactBodyText(text, contentType, jsonLike),
  };
}

/**
 * Redacts sensitive values in a text body.
 *
 * @param text - The body text.
 * @param contentType - The request content type, if known.
 * @param jsonLike - Whether the text is JSON or looks like JSON.
 * @returns The text with sensitive values redacted.
 */
function redactBodyText(
  text: string,
  contentType: string | undefined,
  jsonLike: boolean,
): string {
  if (jsonLike) {
    return redactJsonText(text);
  }

  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mediaType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text);
    for (const key of new Set(params.keys())) {
      if (isSensitiveBodyField(key)) {
        params.set(key, REDACTED_VALUE);
      }
    }
    return params.toString();
  }

  return text;
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
