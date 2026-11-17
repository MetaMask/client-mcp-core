import type {
  BrowserContext,
  ConsoleMessage,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
  WebError,
} from '@playwright/test';

import {
  isSensitiveBodyField,
  isServiceWorkerRequest,
  matchesUrlFilter,
  REDACTED_VALUE,
} from './mock-network.js';
import type {
  NetworkLogConfig,
  NetworkLogConsoleLevel,
  NetworkLogConsoleRecord,
  NetworkLogInput,
  NetworkLogReadOptions,
  NetworkLogResult,
  NetworkLogRequestRecord,
  NetworkLogRpcError,
  NetworkLogSource,
  NetworkLogSummary,
} from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { debugWarn } from '../utils';

export const DEFAULT_MAX_NETWORK_RECORDS = 2000;
export const DEFAULT_MAX_CONSOLE_RECORDS = 1000;
export const DEFAULT_NETWORK_LOG_READ_LIMIT = 500;
export const MAX_NETWORK_LOG_READ_LIMIT = 2000;
export const MAX_CONSOLE_TEXT_LENGTH = 2000;
export const MAX_LOGGED_URL_LENGTH = 2048;
export const MAX_RPC_BODY_BYTES = 256 * 1024;
export const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
export const MAX_RPC_BATCH_METHODS = 20;
const MAX_RPC_ERROR_MESSAGE_LENGTH = 300;
const MAX_PENDING_RPC_RESPONSE_READS = 8;
const RPC_RESPONSE_READ_TIMEOUT_MS = 2000;
export const DEFAULT_CONSOLE_LEVELS: NetworkLogConsoleLevel[] = ['error'];
const RECORDED_PROTOCOLS = new Set(['http:', 'https:']);
// Query parameter names (compared lowercase, without `-` and `_`) whose
// values are secrets, in addition to the body field names from mock-network.
const SENSITIVE_QUERY_PARAMS = new Set([
  'key',
  'token',
  'auth',
  'authtoken',
  'sig',
  'signature',
  'jwt',
  'session',
  'sessionid',
  'sessiontoken',
  'projectid',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const URL_IN_TEXT_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`)]+/giu;
const networkLogs = new WeakMap<BrowserContext, NetworkLogRecorder>();

type PendingRequest = {
  startedAt: number;
  status?: number;
  response?: PlaywrightResponse;
};

/**
 * Reads the passive network and console log of the active browser session.
 *
 * @param input - The network-log action and options.
 * @param context - The tool execution context.
 * @returns The network-log action result.
 */
export async function networkLogTool(
  input: NetworkLogInput,
  context: ToolContext,
): Promise<ToolResponse<NetworkLogResult>> {
  const missingSession = requireActiveSession<NetworkLogResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const recorder = attachNetworkLog(context.sessionManager.getContext());

  if (input.action === 'requests') {
    return createToolSuccess({
      action: 'requests',
      ...recorder.readRequests(input),
      summary: recorder.getSummary(),
    });
  }

  if (input.action === 'console') {
    return createToolSuccess({
      action: 'console',
      ...recorder.readConsole(input),
      summary: recorder.getSummary(),
    });
  }

  if (input.action === 'clear') {
    recorder.clear();
    return createToolSuccess({
      action: 'clear',
      cleared: true,
      summary: recorder.getSummary(),
    });
  }

  if (input.action === 'configure') {
    recorder.configure(input);
    return createToolSuccess({
      action: 'configure',
      config: recorder.getConfig(),
      summary: recorder.getSummary(),
    });
  }

  return createToolSuccess({
    action: 'mark',
    cursor: recorder.getCursor(),
    t: Date.now(),
    summary: recorder.getSummary(),
  });
}

/**
 * Records the requests and console messages of a browser context, including
 * the extension's service worker, with listeners only. It never routes or
 * changes a request.
 */
export class NetworkLogRecorder {
  readonly #maxNetworkRecords: number;

  readonly #maxConsoleRecords: number;

  readonly #requests: NetworkLogRequestRecord[] = [];

  readonly #console: NetworkLogConsoleRecord[] = [];

  readonly #pending = new WeakMap<PlaywrightRequest, PendingRequest>();

  readonly #startedAt = Date.now();

  #seq = 0;

  #pendingCount = 0;

  #pendingRpcReads = 0;

  #requestsTotal = 0;

  #requestsDropped = 0;

  #requestsLastDroppedSeq = 0;

  #ignored = 0;

  #consoleTotal = 0;

  #consoleDropped = 0;

  #consoleLastDroppedSeq = 0;

  #rpcErrorsSkipped = 0;

  #config: NetworkLogConfig = {
    consoleLevels: [...DEFAULT_CONSOLE_LEVELS],
    rpcErrors: false,
  };

  /**
   * Attaches the listeners to a browser context.
   *
   * @param browserContext - The browser context to record.
   * @param options - Buffer sizes.
   * @param options.maxNetworkRecords - Network records to keep.
   * @param options.maxConsoleRecords - Console records to keep.
   */
  constructor(
    browserContext: BrowserContext,
    options: { maxNetworkRecords?: number; maxConsoleRecords?: number } = {},
  ) {
    this.#maxNetworkRecords =
      options.maxNetworkRecords ?? DEFAULT_MAX_NETWORK_RECORDS;
    this.#maxConsoleRecords =
      options.maxConsoleRecords ?? DEFAULT_MAX_CONSOLE_RECORDS;

    browserContext.on('request', (request) => this.#onRequest(request));
    browserContext.on('response', (response) => this.#onResponse(response));
    browserContext.on('requestfinished', (request) => {
      this.#onRequestDone(request, undefined).catch((error: unknown) =>
        debugWarn('network-log.requestfinished', error),
      );
    });
    browserContext.on('requestfailed', (request) => {
      this.#onRequestDone(
        request,
        request.failure()?.errorText ?? 'failed',
      ).catch((error: unknown) =>
        debugWarn('network-log.requestfailed', error),
      );
    });
    browserContext.on('console', (message) => this.#onConsole(message));
    browserContext.on('weberror', (webError) => this.#onWebError(webError));
  }

  /**
   * Changes what the recorder keeps from now on.
   *
   * @param options - The settings to change.
   * @param options.consoleLevels - Console levels to record.
   * @param options.rpcErrors - Whether to read JSON-RPC response bodies for
   * `error` objects.
   */
  configure(options: Partial<NetworkLogConfig>): void {
    this.#config = {
      consoleLevels: options.consoleLevels
        ? [...new Set(options.consoleLevels)]
        : this.#config.consoleLevels,
      rpcErrors: options.rpcErrors ?? this.#config.rpcErrors,
    };
  }

  /**
   * @returns The current settings.
   */
  getConfig(): NetworkLogConfig {
    return {
      consoleLevels: [...this.#config.consoleLevels],
      rpcErrors: this.#config.rpcErrors,
    };
  }

  /**
   * @returns The sequence number of the newest record. Pass it as `cursor`
   * to read only what comes after it.
   */
  getCursor(): number {
    return this.#seq;
  }

  /**
   * Drops all kept records. Sequence numbers keep counting, so old cursors
   * stay valid.
   */
  clear(): void {
    this.#requests.length = 0;
    this.#console.length = 0;
  }

  /**
   * Reads network records.
   *
   * @param options - Filter and paging options.
   * @returns The records, the cursor for the next read and paging flags.
   */
  readRequests(options: NetworkLogReadOptions): {
    requests: NetworkLogRequestRecord[];
    cursor: number;
    hasMore: boolean;
    gap?: boolean;
  } {
    const { records, cursor, hasMore, gap } = this.#read(
      this.#requests,
      this.#requestsLastDroppedSeq,
      options,
      (record) =>
        (!options.url || matchesUrlFilter(options.url, record.url)) &&
        (!options.errors || isErrorRequest(record)),
    );
    return { requests: records, cursor, hasMore, ...(gap ? { gap } : {}) };
  }

  /**
   * Reads console records.
   *
   * @param options - Filter and paging options.
   * @returns The records, the cursor for the next read and paging flags.
   */
  readConsole(options: NetworkLogReadOptions): {
    messages: NetworkLogConsoleRecord[];
    cursor: number;
    hasMore: boolean;
    gap?: boolean;
  } {
    const { records, cursor, hasMore, gap } = this.#read(
      this.#console,
      this.#consoleLastDroppedSeq,
      options,
      (record) =>
        (!options.url ||
          matchesUrlFilter(options.url, record.sourceUrl ?? '')) &&
        (!options.errors || record.level === 'error'),
    );
    return { messages: records, cursor, hasMore, ...(gap ? { gap } : {}) };
  }

  /**
   * @returns Counts, buffer state and settings.
   */
  getSummary(): NetworkLogSummary {
    return {
      startedAt: new Date(this.#startedAt).toISOString(),
      cursor: this.#seq,
      requests: {
        kept: this.#requests.length,
        total: this.#requestsTotal,
        dropped: this.#requestsDropped,
        pending: this.#pendingCount,
        ignored: this.#ignored,
        max: this.#maxNetworkRecords,
      },
      console: {
        kept: this.#console.length,
        total: this.#consoleTotal,
        dropped: this.#consoleDropped,
        max: this.#maxConsoleRecords,
      },
      ...(this.#rpcErrorsSkipped > 0
        ? { rpcErrorsSkipped: this.#rpcErrorsSkipped }
        : {}),
      config: this.getConfig(),
    };
  }

  /**
   * Shared read logic for both buffers.
   *
   * With `cursor` or `since`, returns the oldest matching records after it
   * (up to `limit`), so a caller can page with the returned cursor. Without
   * either, returns the newest `limit` records.
   *
   * @param buffer - The buffer to read.
   * @param lastDroppedSeq - Sequence number of the newest dropped record.
   * @param options - Read options.
   * @param matches - Filter for the records.
   * @returns The records, the next cursor and paging flags.
   */
  #read<RecordType extends { seq: number; t: number }>(
    buffer: RecordType[],
    lastDroppedSeq: number,
    options: NetworkLogReadOptions,
    matches: (record: RecordType) => boolean,
  ): { records: RecordType[]; cursor: number; hasMore: boolean; gap: boolean } {
    const limit = options.limit ?? DEFAULT_NETWORK_LOG_READ_LIMIT;
    const since = parseSince(options.since);
    const { cursor } = options;
    const incremental = cursor !== undefined || since !== undefined;
    const matching = buffer.filter(
      (record) =>
        (cursor === undefined || record.seq > cursor) &&
        (since === undefined || record.t >= since) &&
        matches(record),
    );

    let records: RecordType[];
    let hasMore = false;
    let nextCursor = this.#seq;
    if (incremental) {
      records = matching.slice(0, limit);
      hasMore = matching.length > limit;
      if (hasMore) {
        nextCursor = records.at(-1)?.seq ?? nextCursor;
      }
    } else {
      records = matching.slice(Math.max(matching.length - limit, 0));
      hasMore = matching.length > limit;
    }

    const gap = cursor !== undefined && lastDroppedSeq > cursor;

    if (options.clear && records.length > 0) {
      const returned = new Set(records);
      const kept = buffer.filter((record) => !returned.has(record));
      buffer.length = 0;
      buffer.push(...kept);
    }

    return { records, cursor: nextCursor, hasMore, gap };
  }

  /**
   * Notes the start time of a request.
   *
   * @param request - The Playwright request.
   */
  #onRequest(request: PlaywrightRequest): void {
    this.#pending.set(request, { startedAt: Date.now() });
    this.#pendingCount += 1;
  }

  /**
   * Notes the status of a response.
   *
   * @param response - The Playwright response.
   */
  #onResponse(response: PlaywrightResponse): void {
    const request = response.request();
    const pending = this.#pending.get(request);
    if (pending) {
      pending.status = response.status();
      pending.response = response;
    }
  }

  /**
   * Records a finished or failed request.
   *
   * @param request - The Playwright request.
   * @param failure - The failure text for a failed request.
   */
  async #onRequestDone(
    request: PlaywrightRequest,
    failure: string | undefined,
  ): Promise<void> {
    const pending = this.#pending.get(request);
    if (pending) {
      this.#pending.delete(request);
      this.#pendingCount = Math.max(this.#pendingCount - 1, 0);
    }

    const rawUrl = request.url();
    if (!isRecordedUrl(rawUrl)) {
      this.#ignored += 1;
      return;
    }

    const now = Date.now();
    const timing = readTiming(request);
    const startedAt =
      timing && timing.startTime > 0
        ? timing.startTime
        : (pending?.startedAt ?? now);
    const durationMs =
      timing && timing.startTime > 0 && timing.responseEnd >= 0
        ? timing.responseEnd
        : now - startedAt;
    const rpcMethod = readRpcMethod(request);
    const source = readRequestSource(request);

    const record: NetworkLogRequestRecord = {
      seq: 0,
      t: Math.round(startedAt),
      method: request.method(),
      url: redactUrl(rawUrl),
      type: request.resourceType(),
      ...(pending?.status === undefined ? {} : { status: pending.status }),
      ms: Math.max(Math.round(durationMs), 0),
      ...(failure === undefined ? {} : { failure }),
      ...rpcMethod,
      ...source,
    };

    if (
      failure === undefined &&
      rpcMethod !== undefined &&
      this.#config.rpcErrors &&
      pending?.response
    ) {
      const rpcError = await this.#readRpcError(pending.response);
      if (rpcError) {
        record.rpcError = rpcError;
      }
    }

    this.#pushRequest(record);
  }

  /**
   * Reads a JSON-RPC response body and returns its `error`, bounded in size
   * and in concurrent reads.
   *
   * @param response - The Playwright response.
   * @returns The JSON-RPC error, if the response has one.
   */
  async #readRpcError(
    response: PlaywrightResponse,
  ): Promise<NetworkLogRpcError | undefined> {
    const length = Number(response.headers()['content-length']);
    if (
      this.#pendingRpcReads >= MAX_PENDING_RPC_RESPONSE_READS ||
      (Number.isFinite(length) && length > MAX_RPC_RESPONSE_BYTES)
    ) {
      this.#rpcErrorsSkipped += 1;
      return undefined;
    }

    this.#pendingRpcReads += 1;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        response.body(),
        new Promise<undefined>((resolve) => {
          timeoutId = setTimeout(
            () => resolve(undefined),
            RPC_RESPONSE_READ_TIMEOUT_MS,
          );
        }),
      ]);
      if (!body || body.length > MAX_RPC_RESPONSE_BYTES) {
        this.#rpcErrorsSkipped += 1;
        return undefined;
      }
      return extractRpcError(JSON.parse(body.toString('utf8')));
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeoutId);
      this.#pendingRpcReads -= 1;
    }
  }

  /**
   * Records a console message at a recorded level.
   *
   * @param message - The Playwright console message.
   */
  #onConsole(message: ConsoleMessage): void {
    const level = normalizeConsoleLevel(message.type());
    if (!this.#config.consoleLevels.includes(level)) {
      return;
    }

    const location = readConsoleLocation(message);
    this.#pushConsole({
      seq: 0,
      t: Date.now(),
      level,
      text: truncateText(redactUrlsInText(message.text())),
      ...readConsoleSource(message),
      ...(location ? { location } : {}),
    });
  }

  /**
   * Records an uncaught page error as an `error` console record.
   *
   * @param webError - The Playwright web error.
   */
  #onWebError(webError: WebError): void {
    if (!this.#config.consoleLevels.includes('error')) {
      return;
    }

    const error = webError.error();
    const pageUrl = readPageUrl(webError.page());
    this.#pushConsole({
      seq: 0,
      t: Date.now(),
      level: 'error',
      text: truncateText(
        redactUrlsInText(`Uncaught ${error.name}: ${error.message}`),
      ),
      source: 'page',
      ...(pageUrl ? { sourceUrl: pageUrl } : {}),
      uncaught: true,
    });
  }

  /**
   * Appends a network record and drops the oldest past the limit.
   *
   * @param record - The record without its sequence number.
   */
  #pushRequest(record: NetworkLogRequestRecord): void {
    this.#seq += 1;
    record.seq = this.#seq;
    this.#requests.push(record);
    this.#requestsTotal += 1;
    while (this.#requests.length > this.#maxNetworkRecords) {
      const dropped = this.#requests.shift();
      this.#requestsDropped += 1;
      this.#requestsLastDroppedSeq =
        dropped?.seq ?? this.#requestsLastDroppedSeq;
    }
  }

  /**
   * Appends a console record and drops the oldest past the limit.
   *
   * @param record - The record without its sequence number.
   */
  #pushConsole(record: NetworkLogConsoleRecord): void {
    this.#seq += 1;
    record.seq = this.#seq;
    this.#console.push(record);
    this.#consoleTotal += 1;
    while (this.#console.length > this.#maxConsoleRecords) {
      const dropped = this.#console.shift();
      this.#consoleDropped += 1;
      this.#consoleLastDroppedSeq = dropped?.seq ?? this.#consoleLastDroppedSeq;
    }
  }
}

/**
 * Starts the passive log for a browser context, or returns the one that is
 * already running. Safe to call more than once. The daemon calls it after a
 * browser launch; a session manager can call it earlier, right after it
 * creates the context, to also record the launch.
 *
 * @param browserContext - The browser context to record.
 * @returns The recorder for the browser context.
 */
export function attachNetworkLog(
  browserContext: BrowserContext,
): NetworkLogRecorder {
  let recorder = networkLogs.get(browserContext);
  if (!recorder) {
    recorder = new NetworkLogRecorder(browserContext);
    networkLogs.set(browserContext, recorder);
  }
  return recorder;
}

/**
 * Checks whether a network record is an error: a failure, an HTTP status of
 * 400 or more, or a JSON-RPC error.
 *
 * @param record - The network record.
 * @returns True for error records.
 */
function isErrorRequest(record: NetworkLogRequestRecord): boolean {
  return (
    record.failure !== undefined ||
    (record.status !== undefined && record.status >= 400) ||
    record.rpcError !== undefined
  );
}

/**
 * Parses a `since` value: epoch milliseconds or an ISO date.
 *
 * @param since - The value from the input.
 * @returns Epoch milliseconds, or undefined.
 */
export function parseSince(
  since: number | string | undefined,
): number | undefined {
  if (since === undefined) {
    return undefined;
  }
  if (typeof since === 'number') {
    return since;
  }
  if (/^\d+$/u.test(since)) {
    return Number(since);
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Checks whether a URL is recorded. Only http(s) requests are; extension
 * files, `data:` and `blob:` URLs are counted as ignored.
 *
 * @param url - The request URL.
 * @returns True for http and https URLs.
 */
function isRecordedUrl(url: string): boolean {
  try {
    return RECORDED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Checks whether a URL segment looks like an API key: at least 24
 * characters of letters, digits, `-` or `_`, with both letters and digits.
 * Hex values with `0x` (addresses, hashes) and UUIDs are kept.
 *
 * @param segment - A path segment or host label.
 * @returns True if the segment must be redacted.
 */
export function isSecretUrlSegment(segment: string): boolean {
  return (
    segment.length >= 24 &&
    /^[A-Za-z0-9_-]+$/u.test(segment) &&
    /[0-9]/u.test(segment) &&
    /[A-Za-z]/u.test(segment) &&
    !/^0x[0-9a-f]+$/iu.test(segment) &&
    !UUID_PATTERN.test(segment)
  );
}

/**
 * Checks whether a query parameter holds a secret.
 *
 * @param name - The parameter name.
 * @returns True if the value must be redacted.
 */
function isSensitiveQueryParam(name: string): boolean {
  return (
    isSensitiveBodyField(name) ||
    SENSITIVE_QUERY_PARAMS.has(name.toLowerCase().replace(/[-_]/gu, ''))
  );
}

/**
 * Redacts secrets in a URL: credentials, key-like host labels and path
 * segments (for example an Infura project id) and sensitive query values.
 * The result is cut to {@link MAX_LOGGED_URL_LENGTH} characters.
 *
 * @param rawUrl - The URL.
 * @returns The URL safe to record.
 */
export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return truncateText(rawUrl, MAX_LOGGED_URL_LENGTH);
  }

  const host = url.host
    .split('.')
    .map((label) => (isSecretUrlSegment(label) ? REDACTED_VALUE : label))
    .join('.');
  const pathname = url.pathname
    .split('/')
    .map((segment) => (isSecretUrlSegment(segment) ? REDACTED_VALUE : segment))
    .join('/');
  const search = url.search
    ? `?${url.search
        .slice(1)
        .split('&')
        .map((pair) => {
          const separator = pair.indexOf('=');
          if (separator < 0) {
            return pair;
          }
          const name = decodeQueryName(pair.slice(0, separator));
          return isSensitiveQueryParam(name)
            ? `${pair.slice(0, separator)}=${REDACTED_VALUE}`
            : pair;
        })
        .join('&')}`
    : '';

  return truncateText(
    `${url.protocol}//${host}${pathname}${search}${url.hash}`,
    MAX_LOGGED_URL_LENGTH,
  );
}

/**
 * Decodes a query parameter name without throwing.
 *
 * @param name - The encoded name.
 * @returns The decoded name, or the input when it is not valid encoding.
 */
function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/gu, ' '));
  } catch {
    return name;
  }
}

/**
 * Redacts every URL found in a text.
 *
 * @param text - The text.
 * @returns The text with redacted URLs.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_PATTERN, (match) => redactUrl(match));
}

/**
 * Cuts a text to a maximum length and marks the cut.
 *
 * @param text - The text.
 * @param maxLength - The maximum length.
 * @returns The text, at most `maxLength` characters plus the marker.
 */
function truncateText(
  text: string,
  maxLength = MAX_CONSOLE_TEXT_LENGTH,
): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Reads the JSON-RPC method(s) from a request body. A batch gives the
 * methods in order (at most {@link MAX_RPC_BATCH_METHODS}) and its size.
 *
 * @param request - The Playwright request.
 * @returns `rpcMethod` (and `rpcBatchSize` for a batch), or undefined.
 */
export function readRpcMethod(
  request: Pick<PlaywrightRequest, 'method' | 'postDataBuffer'>,
):
  | { rpcMethod: string }
  | { rpcMethod: string[]; rpcBatchSize: number }
  | undefined {
  if (request.method() !== 'POST') {
    return undefined;
  }

  let buffer: Buffer | null;
  try {
    buffer = request.postDataBuffer();
  } catch {
    return undefined;
  }
  if (!buffer || buffer.length === 0 || buffer.length > MAX_RPC_BODY_BYTES) {
    return undefined;
  }

  const text = buffer.toString('utf8').trimStart();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return undefined;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (Array.isArray(body)) {
    const methods = body
      .map(getRpcCallMethod)
      .filter((method): method is string => method !== undefined);
    if (methods.length === 0) {
      return undefined;
    }
    return {
      rpcMethod: methods.slice(0, MAX_RPC_BATCH_METHODS),
      rpcBatchSize: body.length,
    };
  }

  const method = getRpcCallMethod(body);
  return method === undefined ? undefined : { rpcMethod: method };
}

/**
 * Returns the method of a JSON-RPC call object.
 *
 * @param call - A parsed JSON value.
 * @returns The method, or undefined when the value is not a JSON-RPC call.
 */
function getRpcCallMethod(call: unknown): string | undefined {
  if (typeof call !== 'object' || call === null) {
    return undefined;
  }
  const { method } = call as { method?: unknown };
  if (
    typeof method !== 'string' ||
    !('jsonrpc' in call || 'id' in call || 'params' in call)
  ) {
    return undefined;
  }
  return method;
}

/**
 * Returns the JSON-RPC error of a parsed response: the `error` of a single
 * response, or the first error of a batch with the count of errors.
 *
 * @param body - The parsed response body.
 * @returns The error, or undefined.
 */
export function extractRpcError(body: unknown): NetworkLogRpcError | undefined {
  const responses = Array.isArray(body) ? body : [body];
  const errors = responses
    .map((response) =>
      typeof response === 'object' && response !== null
        ? (response as { error?: unknown }).error
        : undefined,
    )
    .filter(
      (error): error is { code?: unknown; message?: unknown } =>
        typeof error === 'object' && error !== null,
    );
  const [first] = errors;
  if (!first) {
    return undefined;
  }

  return {
    ...(typeof first.code === 'number' ? { code: first.code } : {}),
    message: truncateText(
      redactUrlsInText(
        typeof first.message === 'string' ? first.message : 'unknown error',
      ),
      MAX_RPC_ERROR_MESSAGE_LENGTH,
    ),
    ...(errors.length > 1 ? { count: errors.length } : {}),
  };
}

/**
 * Reads request timing without throwing.
 *
 * @param request - The Playwright request.
 * @returns The timing, or undefined.
 */
function readTiming(
  request: PlaywrightRequest,
): ReturnType<PlaywrightRequest['timing']> | undefined {
  try {
    return request.timing();
  } catch {
    return undefined;
  }
}

/**
 * Returns where a request came from: the service worker, or a page with its
 * URL (and the frame URL for a request from an iframe).
 *
 * @param request - The Playwright request.
 * @returns The source fields of a network record.
 */
function readRequestSource(request: PlaywrightRequest): {
  source: NetworkLogSource;
  pageUrl?: string;
  frameUrl?: string;
} {
  if (isServiceWorkerRequest(request)) {
    return { source: 'service-worker' };
  }

  try {
    const frame = request.frame();
    const page = frame.page();
    const pageUrl = page.url();
    const frameUrl = frame === page.mainFrame() ? undefined : frame.url();
    return {
      source: 'page',
      ...(pageUrl ? { pageUrl: redactUrl(pageUrl) } : {}),
      ...(frameUrl ? { frameUrl: redactUrl(frameUrl) } : {}),
    };
  } catch {
    return { source: 'page' };
  }
}

/**
 * Maps a Playwright console type to a recorded level.
 *
 * @param type - The console message type.
 * @returns The level.
 */
function normalizeConsoleLevel(type: string): NetworkLogConsoleLevel {
  if (
    type === 'error' ||
    type === 'warning' ||
    type === 'info' ||
    type === 'debug'
  ) {
    return type;
  }
  if (type === 'assert') {
    return 'error';
  }
  return 'log';
}

/**
 * Returns where a console message came from.
 *
 * @param message - The Playwright console message.
 * @returns The source fields of a console record.
 */
function readConsoleSource(message: ConsoleMessage): {
  source: NetworkLogSource;
  sourceUrl?: string;
} {
  try {
    // `worker()` exists from Playwright 1.57; older versions only have page().
    const worker =
      typeof message.worker === 'function' ? message.worker() : null;
    if (worker) {
      return { source: 'service-worker', sourceUrl: redactUrl(worker.url()) };
    }
  } catch {
    // Fall back to the page below.
  }
  const pageUrl = readPageUrl(message.page());
  return { source: 'page', ...(pageUrl ? { sourceUrl: pageUrl } : {}) };
}

/**
 * Reads a page URL without throwing.
 *
 * @param page - The page, or null.
 * @param page.url - Returns the page URL.
 * @returns The redacted page URL, or undefined.
 */
function readPageUrl(page: { url: () => string } | null): string | undefined {
  try {
    const url = page?.url();
    return url ? redactUrl(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns `url:line:column` for a console message.
 *
 * @param message - The Playwright console message.
 * @returns The location, or undefined when Playwright has none.
 */
function readConsoleLocation(message: ConsoleMessage): string | undefined {
  try {
    const { url, lineNumber, columnNumber } = message.location();
    if (!url) {
      return undefined;
    }
    return `${redactUrl(url)}:${lineNumber}:${columnNumber}`;
  } catch {
    return undefined;
  }
}
