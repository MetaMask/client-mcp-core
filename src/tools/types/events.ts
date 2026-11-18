/**
 * Session event records: console messages (`mm logs`) and network requests
 * (`mm network`), kept in one buffer per session with a shared cursor.
 */

/** The record kinds of the session event buffer. */
export type EventKind = 'console' | 'network';

/** The target a record came from. */
export type EventRecordTarget = {
  /** `page` (tab, popup, side panel), `sw` (Extension service worker), or `hermes` (mobile, later). */
  kind: 'page' | 'sw' | 'hermes';
  /** The CDP target ID. Chrome can reuse a service worker's ID after a restart. */
  id: string;
  /** The target URL (redacted). */
  url: string;
};

/** Fields every record has. */
export type EventRecordBase = {
  /**
   * Position in the session, shared by every kind. Starts at 1 for each new
   * session and only grows.
   */
  seq: number;
  /** Time of the event (a request: its start), epoch ms. */
  t: number;
  target: EventRecordTarget;
};

/** Buffer state, returned with every read and by `mm events mark`. */
export type EventSummary = {
  /**
   * When this session's buffer started, epoch ms. It changes when the
   * session is relaunched; cursors from before are then meaningless.
   */
  startedAt: number;
  /** The newest `seq` given out. Use it as a cursor. */
  seq: number;
  /** Records kept now, by kind. */
  counts: Record<EventKind, number>;
  /** Records dropped because the buffer was full, by kind. */
  dropped: Record<EventKind, number>;
};

/** One page of records. */
export type EventPage<RecordType> = {
  /** Oldest first. */
  records: RecordType[];
  /** Pass as `cursor` to the next read to continue without duplicates. */
  cursor: number;
  /** More records match than `limit` allowed: read again with `cursor`. */
  hasMore: boolean;
  /**
   * Records after the given cursor (or `since`) were dropped, or the cursor
   * was from another session (above the newest `seq`).
   */
  gap: boolean;
  summary: EventSummary;
};

/** Console levels `mm logs` can record. */
export type ConsoleLevel = 'error' | 'warning' | 'info' | 'log' | 'debug';

/** A console message or uncaught exception (`mm logs`). */
export type ConsoleRecord = EventRecordBase & {
  /** `console.assert` is `error`; `dir`, `table`, `trace` are `log`. */
  level: ConsoleLevel;
  /** The message, redacted and cut at 2000 characters. */
  text: string;
  /** `url:line:column` (1-based) of the call or the throw, when known. */
  location?: string;
  /** An uncaught exception, not a console call. */
  uncaught?: true;
};

/** What the session records. Changed by `configure`, from then on. */
export type EventConfig = {
  /** Console levels to record. Default `['error']`. */
  consoleLevels: ConsoleLevel[];
  /** Read JSON-RPC response bodies for `rpcError`. Default false. */
  rpcErrors: boolean;
};

/** The JSON-RPC error of a response (`mm network configure --rpc-errors`). */
export type RpcError = {
  /** The JSON-RPC error code, when it is a number. */
  code?: number;
  /** The error message, redacted and cut at 300 characters. */
  message: string;
};

/**
 * One HTTP(S) request of a page or the Extension service worker
 * (`mm network`). Created when the request starts and updated in place as
 * it ends; it keeps its first `seq` and gets a `settledSeq` when it ends
 * (or its JSON-RPC error is read).
 */
export type NetworkRecord = EventRecordBase & {
  /**
   * Position of the request when it settled, that is, when no field of it
   * changed any more. Absent while pending. A filtered `mm network` read
   * returns settled records in this order.
   */
  settledSeq?: number;
  /** HTTP method. */
  method: string;
  /** The URL, redacted. */
  url: string;
  /** Lowercase CDP resource type, for example `fetch`, `xhr`, `document`. */
  type: string;
  /** HTTP status. Absent while pending and for a request that failed before a response. */
  status?: number;
  /** Duration from start to the end of the response or the failure. Absent while pending. */
  ms?: number;
  /** Failure text, for example `net::ERR_ABORTED`. */
  failure?: string;
  /** JSON-RPC methods of the request body (one for a single call, in order for a batch). */
  rpcMethods?: string[];
  /** JSON-RPC error of the response. Only with `mm network configure --rpc-errors`. */
  rpcError?: RpcError;
};

/** Counters of the network source, returned by `mm network`. */
export type NetworkStats = {
  /** Requests started and not finished yet. */
  pending: number;
  /** Requests not recorded because their URL is not http(s) (extension files, `data:`). */
  ignored: number;
  /** JSON-RPC responses not read for `rpcError` (too large, too many at once, timeout). */
  rpcErrorsSkipped: number;
};
