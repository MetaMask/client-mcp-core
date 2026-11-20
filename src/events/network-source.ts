import {
  MAX_RPC_REQUEST_BYTES,
  parseRpcError,
  parseRpcMethods,
} from './json-rpc.js';
import { toRecordTarget } from './read-options.js';
import { redactText, redactUrl } from './redact.js';
import type { SessionEventSource, SessionEvents } from './session-events.js';
import type {
  CdpEvent,
  CdpEventTarget,
  CdpManager,
  CdpSubscription,
  CdpTargetLifecycleEvent,
} from '../platform/cdp-manager.js';
import type { NetworkRecord } from '../tools/types/events.js';
import { debugWarn } from '../utils';

export const NETWORK_EVENTS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
] as const;

/** JSON-RPC response bodies larger than this are not read for `rpcError`. */
export const MAX_RPC_RESPONSE_BYTES = 64 * 1024;

/** Response bodies read at the same time for `rpcError`. */
export const MAX_CONCURRENT_RPC_READS = 8;

/** How long one response body read may take. */
export const RPC_RESPONSE_READ_TIMEOUT_MS = 2_000;

/**
 * Per-response network buffer, in bytes. Twice the largest JSON-RPC body that
 * is read, so headers and framing fit too.
 */
export const MAX_RESOURCE_BUFFER_BYTES = MAX_RPC_RESPONSE_BYTES * 2;

/**
 * Total network buffer, in bytes: room for the concurrent JSON-RPC body
 * reads. No bodies are kept otherwise.
 */
export const MAX_TOTAL_BUFFER_BYTES =
  MAX_RESOURCE_BUFFER_BYTES * MAX_CONCURRENT_RPC_READS;

/**
 * Requests remembered while they run. Requests that never end (a worker
 * that stopped mid-request, a stream) are forgotten oldest first past it;
 * their record is settled as it stands, so a filtered read sees it once.
 */
export const MAX_PENDING_REQUESTS = 2_000;

const RECORDED_PROTOCOLS = /^https?:/iu;

type CdpRequest = {
  url?: string;
  method?: string;
  postData?: string;
  postDataEntries?: { bytes?: string }[];
};

type RequestWillBeSentParams = {
  requestId?: string;
  request?: CdpRequest;
  timestamp?: number;
  wallTime?: number;
  type?: string;
  redirectResponse?: { status?: number };
};

type ResponseReceivedParams = {
  requestId?: string;
  response?: { status?: number };
};

type LoadingFinishedParams = {
  requestId?: string;
  timestamp?: number;
  encodedDataLength?: number;
};

type DataReceivedParams = {
  requestId?: string;
  dataLength?: number;
};

type LoadingFailedParams = {
  requestId?: string;
  timestamp?: number;
  errorText?: string;
  blockedReason?: string;
  corsErrorStatus?: { corsError?: string; failedParameter?: string };
};

type PendingRequest = {
  record: NetworkRecord;
  target: CdpEventTarget;
  requestId: string;
  /** CDP monotonic time of the start, in seconds. */
  startedAt?: number;
  /**
   * Body bytes received before decoding (`Network.dataReceived` lengths),
   * undefined when Chrome sent no data event.
   */
  decodedBytes?: number;
};

/**
 * Reads the request body of a `Network.requestWillBeSent` request.
 *
 * @param request - The CDP request.
 * @returns The body text, or undefined when Chrome sent none.
 */
function readPostData(request: CdpRequest): string | undefined {
  if (request.postData !== undefined) {
    return request.postData;
  }
  if (!request.postDataEntries?.length) {
    return undefined;
  }
  const chunks = request.postDataEntries.map((entry) =>
    Buffer.from(entry.bytes ?? '', 'base64'),
  );
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  return size > MAX_RPC_REQUEST_BYTES
    ? undefined
    : Buffer.concat(chunks).toString('utf8');
}

/**
 * Milliseconds between two CDP monotonic times (seconds).
 *
 * @param start - The start time.
 * @param end - The end time.
 * @returns The rounded duration, or undefined when a time is missing.
 */
function elapsedMs(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return Math.max(Math.round((end - start) * 1000), 0);
}

/**
 * Records the HTTP(S) requests of every page and the Extension service
 * worker: one record per request, created when it starts and updated in
 * place when it gets a response and when it ends. A redirect ends the
 * record of the hop with the redirect status and starts a new record for
 * the next URL, as DevTools shows it. Every record is settled when no field
 * of it can change any more, so a filtered `mm network` read returns it
 * once, after it ended.
 */
export class NetworkSource implements SessionEventSource {
  readonly #pending = new Map<string, PendingRequest>();

  #rpcReads = 0;

  /**
   * @param manager - The session's CDP manager.
   * @param events - The session's events.
   * @returns The subscription.
   */
  async start(
    manager: CdpManager,
    events: SessionEvents,
  ): Promise<CdpSubscription> {
    // A request still pending when the source starts again (the CDP manager
    // was replaced) can never finish: settle its record as it stands, so a
    // filtered read can see it.
    for (const pending of this.#pending.values()) {
      pending.record.failure = 'target closed';
      events.buffer.settle('network', pending.record);
    }
    this.#pending.clear();
    events.networkStats.pending = 0;
    const subscription = await manager.subscribe({
      events: NETWORK_EVENTS,
      enable: {
        Network: {
          maxPostDataSize: MAX_RPC_REQUEST_BYTES,
          maxResourceBufferSize: MAX_RESOURCE_BUFFER_BYTES,
          maxTotalBufferSize: MAX_TOTAL_BUFFER_BYTES,
        },
      },
      onEvent: (event) => this.#onEvent(event, manager, events),
    });
    const onDetached = (event: CdpTargetLifecycleEvent): void =>
      this.#onTargetDetached(event, events);
    manager.on('targetDetached', onDetached);
    return {
      unsubscribe: async (): Promise<void> => {
        manager.off('targetDetached', onDetached);
        await subscription.unsubscribe();
      },
    };
  }

  /**
   * Dispatches one CDP event.
   *
   * @param event - The CDP event.
   * @param manager - The session's CDP manager.
   * @param events - The session's events.
   */
  #onEvent(event: CdpEvent, manager: CdpManager, events: SessionEvents): void {
    const { requestId } = event.params as { requestId?: unknown };
    if (typeof requestId !== 'string') {
      return;
    }
    const key = `${event.target.kind}\u0000${event.target.targetId}\u0000${requestId}`;
    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.#onRequest(
          key,
          requestId,
          event,
          event.params as RequestWillBeSentParams,
          events,
        );
        break;
      case 'Network.responseReceived': {
        const pending = this.#pending.get(key);
        const status = (event.params as ResponseReceivedParams).response
          ?.status;
        if (pending && typeof status === 'number') {
          pending.record.status = status;
        }
        break;
      }
      case 'Network.dataReceived': {
        const pending = this.#pending.get(key);
        const length = (event.params as DataReceivedParams).dataLength;
        if (pending && typeof length === 'number' && length > 0) {
          pending.decodedBytes = (pending.decodedBytes ?? 0) + length;
        }
        break;
      }
      case 'Network.loadingFinished':
        this.#onFinished(
          key,
          event.params as LoadingFinishedParams,
          manager,
          events,
        );
        break;
      case 'Network.loadingFailed':
        this.#onFailed(key, event.params as LoadingFailedParams, events);
        break;
      default:
        break;
    }
  }

  /**
   * Starts the record of a request (or of the next hop of a redirect).
   *
   * @param key - The request key (target kind, target ID, request ID).
   * @param requestId - The CDP request ID.
   * @param event - The CDP event.
   * @param params - Its parameters.
   * @param events - The session's events.
   */
  #onRequest(
    key: string,
    requestId: string,
    event: CdpEvent,
    params: RequestWillBeSentParams,
    events: SessionEvents,
  ): void {
    const previous = this.#pending.get(key);
    if (previous && params.redirectResponse) {
      if (typeof params.redirectResponse.status === 'number') {
        previous.record.status = params.redirectResponse.status;
      }
      const ms = elapsedMs(previous.startedAt, params.timestamp);
      if (ms !== undefined) {
        previous.record.ms = ms;
      }
    }
    // A new request with the same ID is not a leftover of a detached target:
    // `CdpManager.#detach` emits `targetDetached`, which settles and forgets
    // the target's pending requests, before it re-attaches. So this is a
    // redirect hop, or an ID Chrome reused on a live target.
    this.#forget(key, events);

    const request = params.request ?? {};
    const url = request.url ?? '';
    if (!RECORDED_PROTOCOLS.test(url)) {
      events.networkStats.ignored += 1;
      return;
    }
    const method = request.method ?? 'GET';
    const rpcMethods =
      method === 'POST' ? parseRpcMethods(readPostData(request)) : undefined;
    const record = events.buffer.append<NetworkRecord>('network', {
      t:
        typeof params.wallTime === 'number'
          ? Math.round(params.wallTime * 1000)
          : event.t,
      target: toRecordTarget(event.target),
      method,
      url: redactUrl(url),
      type: (params.type ?? 'other').toLowerCase(),
      ...(rpcMethods === undefined ? {} : { rpcMethods }),
    });
    this.#pending.set(key, {
      record,
      target: event.target,
      requestId,
      startedAt: params.timestamp,
    });
    events.networkStats.pending = this.#pending.size;
    if (this.#pending.size > MAX_PENDING_REQUESTS) {
      const [oldest] = this.#pending.keys();
      const abandoned = this.#pending.get(oldest);
      if (abandoned) {
        // The request never ends here: say so instead of looking pending.
        abandoned.record.failure = 'abandoned';
      }
      this.#forget(oldest, events);
    }
  }

  /**
   * Ends a request that finished loading, and reads its JSON-RPC error when
   * the session asks for it.
   *
   * @param key - The request key.
   * @param params - The `Network.loadingFinished` parameters.
   * @param manager - The session's CDP manager.
   * @param events - The session's events.
   */
  #onFinished(
    key: string,
    params: LoadingFinishedParams,
    manager: CdpManager,
    events: SessionEvents,
  ): void {
    const known = this.#pending.get(key);
    const readError =
      known !== undefined &&
      events.config.rpcErrors &&
      known.record.rpcMethods !== undefined;
    // Keep the record unsettled while its rpcError is read, so a filtered
    // read returns it with the final rpcError.
    const pending = this.#forget(key, events, readError);
    if (!pending) {
      return;
    }
    const ms = elapsedMs(pending.startedAt, params.timestamp);
    if (ms !== undefined) {
      pending.record.ms = ms;
    }
    if (readError) {
      this.#readRpcError(pending, params, manager, events).catch(
        (error: unknown) => debugWarn('network-source.rpc-error', error),
      );
    }
  }

  /**
   * Ends a request that failed.
   *
   * @param key - The request key.
   * @param params - The `Network.loadingFailed` parameters.
   * @param events - The session's events.
   */
  #onFailed(
    key: string,
    params: LoadingFailedParams,
    events: SessionEvents,
  ): void {
    const pending = this.#forget(key, events);
    if (!pending) {
      return;
    }
    const ms = elapsedMs(pending.startedAt, params.timestamp);
    if (ms !== undefined) {
      pending.record.ms = ms;
    }
    const reasons: string[] = [];
    if (params.blockedReason) {
      reasons.push(`blocked: ${params.blockedReason}`);
    }
    if (params.corsErrorStatus?.corsError) {
      reasons.push(`cors: ${params.corsErrorStatus.corsError}`);
    }
    const reason = reasons.length === 0 ? '' : ` (${reasons.join('; ')})`;
    pending.record.failure = redactText(
      `${params.errorText ?? 'failed'}${reason}`,
    );
  }

  /**
   * Reads a JSON-RPC response body and records its error, bounded in size,
   * time and concurrent reads. Skipped reads are counted.
   *
   * The size bound uses the decoded body bytes reported by
   * `Network.dataReceived` when Chrome sent them; without those events it
   * falls back to `encodedDataLength`, which is the compressed size and can
   * undercount. The body text is checked again by UTF-8 byte length.
   *
   * The record stays unsettled until the read settles (or is skipped), so a
   * filtered read returns it once, with its final `rpcError`.
   *
   * @param pending - The finished request.
   * @param params - The `Network.loadingFinished` parameters.
   * @param manager - The session's CDP manager.
   * @param events - The session's events.
   */
  async #readRpcError(
    pending: PendingRequest,
    params: LoadingFinishedParams,
    manager: CdpManager,
    events: SessionEvents,
  ): Promise<void> {
    try {
      const received = pending.decodedBytes ?? params.encodedDataLength ?? 0;
      if (
        this.#rpcReads >= MAX_CONCURRENT_RPC_READS ||
        received > MAX_RPC_RESPONSE_BYTES
      ) {
        events.networkStats.rpcErrorsSkipped += 1;
        return;
      }
      this.#rpcReads += 1;
      try {
        const { body, base64Encoded } = (await manager.sendToEventTarget(
          pending.target,
          'Network.getResponseBody',
          { requestId: pending.requestId },
          { timeoutMs: RPC_RESPONSE_READ_TIMEOUT_MS },
        )) as { body?: string; base64Encoded?: boolean };
        const text = base64Encoded
          ? Buffer.from(body ?? '', 'base64').toString('utf8')
          : (body ?? '');
        if (Buffer.byteLength(text, 'utf8') > MAX_RPC_RESPONSE_BYTES) {
          events.networkStats.rpcErrorsSkipped += 1;
          return;
        }
        const rpcError = parseRpcError(text);
        if (rpcError) {
          // The record object is created once and only its fields change; the
          // pending entry may be gone, but the buffered record is the same.
          // eslint-disable-next-line require-atomic-updates
          pending.record.rpcError = rpcError;
        }
      } catch {
        events.networkStats.rpcErrorsSkipped += 1;
      } finally {
        this.#rpcReads -= 1;
      }
    } finally {
      // Whether the body was read, skipped or failed, the record is final.
      events.buffer.settle('network', pending.record);
    }
  }

  /**
   * Ends the requests of a target that detached (a page closed, the worker
   * stopped, its session was lost): they can never finish, so they stop
   * counting as pending and carry a `target closed` failure.
   *
   * @param event - The detached target.
   * @param events - The session's events.
   */
  #onTargetDetached(
    event: CdpTargetLifecycleEvent,
    events: SessionEvents,
  ): void {
    const { targetId } = event;
    if (targetId === undefined) {
      return;
    }
    for (const [key, pending] of this.#pending) {
      if (
        pending.target.kind === event.kind &&
        pending.target.targetId === targetId
      ) {
        pending.record.failure = 'target closed';
        this.#forget(key, events);
      }
    }
  }

  /**
   * Stops tracking a request and settles its record, unless the caller keeps
   * it open for a JSON-RPC error read.
   *
   * @param key - The request key.
   * @param events - The session's events.
   * @param keepOpen - Whether the record may still change (an `rpcError`
   * read follows).
   * @returns The request, when it was tracked.
   */
  #forget(
    key: string,
    events: SessionEvents,
    keepOpen = false,
  ): PendingRequest | undefined {
    const pending = this.#pending.get(key);
    this.#pending.delete(key);
    if (pending && !keepOpen) {
      events.buffer.settle('network', pending.record);
    }
    events.networkStats.pending = this.#pending.size;
    return pending;
  }
}
