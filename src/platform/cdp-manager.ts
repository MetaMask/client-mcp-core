import type {
  BrowserContext,
  CDPSession,
  Page,
  Worker as PlaywrightWorker,
} from '@playwright/test';

import { ErrorCodes } from '../tools/types/errors.js';

/**
 * Target kinds a {@link CdpManager} can attach to. A string union so more
 * targets (for example a mobile `app`) can be added without changing the
 * manager interface.
 */
export type CdpTargetKind = 'page' | 'sw';

/**
 * A CDP target: a page, or the extension's service worker.
 */
export type CdpTarget = { kind: 'page'; page: Page } | { kind: 'sw' };

/**
 * The CDP session surface the manager exposes. A page target returns a
 * Playwright `CDPSession`; a service worker target returns a wrapper over
 * the browser session, because Playwright cannot open a CDP session on a
 * `Worker` (its `newCDPSession` accepts a page or a frame only).
 */
export type CdpSession = {
  /**
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @returns The raw CDP result.
   */
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Detaches the session. */
  detach(): Promise<void>;
};

/**
 * Payload of the `targetAttached` and `targetDetached` events.
 */
export type CdpTargetEvent = {
  kind: CdpTargetKind;
  /**
   * The CDP target ID. Always set for the Extension service worker; set for
   * a page once the manager resolved it (the first event from the page).
   */
  targetId?: string;
  /**
   * The page of a page target, or the worker of a service worker target when
   * Playwright reported one. The service worker is identified by its CDP
   * target, so a worker object may be missing or stale after a restart.
   */
  target?: Page | PlaywrightWorker;
};

/**
 * Options for attaching a CDP session.
 */
export type CdpAttachOptions = {
  /**
   * Bounded wait for the extension service worker to appear. Page targets
   * open at once and ignore it. Defaults to
   * {@link DEFAULT_SW_ATTACH_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Aborts the wait for a service worker target. */
  signal?: AbortSignal;
};

/**
 * Options for {@link CdpManager.send}.
 */
export type CdpSendOptions = CdpAttachOptions & {
  /**
   * Open a one-shot session for this command, then detach it, instead of
   * reusing the persistent session of the target (the `mm cdp --fresh`
   * behaviour).
   */
  fresh?: boolean;
};

/**
 * Events emitted by {@link CdpManager}.
 */
export type CdpManagerEvent = 'targetAttached' | 'targetDetached';

/**
 * Listener of a {@link CdpManagerEvent}.
 */
export type CdpManagerListener = (event: CdpTargetEvent) => void;

/**
 * The target a CDP event came from.
 */
export type CdpEventTarget = {
  kind: CdpTargetKind;
  /**
   * The CDP target ID. A page keeps its ID across navigations. Chrome can
   * reuse a service worker's ID after the worker stops and starts again, so
   * the ID does not tell worker runs apart.
   */
  targetId: string;
  /** The target URL when the event was delivered. */
  url: string;
};

/**
 * A CDP event delivered to a subscriber.
 *
 * `params` is the raw CDP payload and is not redacted. A consumer that
 * persists or prints it must redact it first: it can hold tokens, keys and
 * other secrets (URLs, request bodies, console text).
 */
export type CdpEvent = {
  target: CdpEventTarget;
  /** The CDP event name, for example `Network.requestWillBeSent`. */
  method: string;
  /** The raw, unredacted CDP event parameters. */
  params: Record<string, unknown>;
  /** Daemon wall-clock time (ms since epoch) when the event was delivered. */
  t: number;
};

/**
 * Options for {@link CdpManager.subscribe}.
 */
export type CdpSubscribeOptions = {
  /**
   * The CDP event names to deliver, for example
   * `['Network.requestWillBeSent', 'Runtime.consoleAPICalled']`. The domain
   * of each name (`Network`, `Runtime`) is enabled on every target.
   */
  events: readonly string[];
  /**
   * Parameters of `<Domain>.enable`, by domain, for example
   * `{ Network: { maxPostDataSize: 65536 } }`. The first subscriber to enable
   * a domain on a target sets them.
   */
  enable?: Readonly<Record<string, Record<string, unknown>>>;
  /** Called synchronously for each event, in the order of its target. */
  onEvent: (event: CdpEvent) => void;
  /**
   * Called when a target cannot be attached or enabled, or when `onEvent`
   * throws. Errors are dropped when it is missing.
   */
  onError?: (error: Error) => void;
};

/**
 * A live subscription returned by {@link CdpManager.subscribe}.
 */
export type CdpSubscription = {
  /**
   * Stops delivering events. Removes the event listeners and disables
   * domains that no other subscriber needs. Idempotent.
   */
  unsubscribe(): Promise<void>;
};

/** How long to wait for the extension service worker by default. */
export const DEFAULT_SW_ATTACH_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a stopped Extension service worker to come back before
 * failing fast. MV3 stops idle workers, and a stopped worker cannot be woken
 * from CDP: only Extension activity (an open or reloaded page) starts it.
 */
export const STOPPED_WORKER_WAIT_MS = 2_000;

/** How often to poll the browser target list while waiting for a worker. */
export const SW_TARGET_POLL_MS = 200;

/**
 * Error for a CDP command that needs the Extension service worker while it is
 * not running.
 */
export const STOPPED_WORKER_MESSAGE =
  'The Extension service worker is not running (MV3 workers stop when idle). ' +
  'Interact with the Extension (open or reload an Extension page) to start it, then retry.';

/**
 * Error for a `<Domain>.enable` or `<Domain>.disable` refused while an event
 * subscription holds that domain on the same target. A subscription owns the
 * domains it enabled: disabling one would silently stop the events, and a
 * second enable would not be counted, so its last unsubscribe would disable a
 * domain the user asked for.
 */
export class CdpDomainInUseError extends Error {
  /** The `MM_CDP_BLOCKED` tool error code. */
  readonly code: typeof ErrorCodes.MM_CDP_BLOCKED = ErrorCodes.MM_CDP_BLOCKED;

  /**
   * @param method - The refused CDP method.
   * @param domain - The CDP domain that a subscription holds.
   */
  constructor(method: string, domain: string) {
    super(
      `CDP method "${method}" is refused while an event subscription holds the ` +
        `${domain} domain on this target: it would change the events the ` +
        'subscription receives. Use --fresh to send it on a one-shot session.',
    );
    this.name = 'CdpDomainInUseError';
  }
}

const EXTENSION_URL = /^chrome-extension:\/\/([a-z]{32})\//u;

/**
 * Closed-session attach failures allowed for a live page before the manager
 * reports them once and stops re-attaching it.
 */
const MAX_PAGE_REATTACH_FAILURES = 3;

/** How close together (ms) page attach failures must be to count as a loop. */
const PAGE_REATTACH_WINDOW_MS = 30_000;

/**
 * Errors Playwright throws when a session, its page or its worker is gone.
 * There is no close event on `CDPSession` in the installed typings, so a
 * failed send is the only signal.
 */
const CLOSED_SESSION_ERROR =
  /(?:target|session|browser|page|worker)[^.]{0,60}\bclosed\b|session with given id not found/iu;

/**
 * Tells whether an error means the CDP session or its target is closed.
 *
 * @param error - The error thrown by a CDP call or by opening a session.
 * @returns True when the session or its target is gone.
 */
export function isClosedSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CLOSED_SESSION_ERROR.test(message);
}

/**
 * Errors Chrome returns when an attached target disappeared.
 */
const MISSING_TARGET_ERROR = /no target with given id|target.*not found/iu;

/**
 * Tells whether an error means a CDP target disappeared.
 *
 * @param error - The error thrown by a CDP call.
 * @returns True when the target is gone.
 */
function isMissingTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_TARGET_ERROR.test(message);
}

/**
 * Extracts the extension ID from a `chrome-extension://` URL.
 *
 * @param url - The URL.
 * @returns The ID, or undefined for another URL.
 */
function extensionIdFromUrl(url: string): string | undefined {
  return EXTENSION_URL.exec(url)?.[1];
}

/**
 * Turns an aborted signal into an error.
 *
 * @param signal - The aborted signal.
 * @returns Its reason when it is an error, else a generic abort error.
 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('CDP target wait aborted');
}

/**
 * Creates the error used when the Extension service worker is not running.
 *
 * @returns The stopped-worker error.
 */
function stoppedWorkerError(): Error {
  return new Error(STOPPED_WORKER_MESSAGE);
}

type WorkerMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type CdpEventListener = (params: Record<string, unknown> | undefined) => void;

/**
 * A cached session that also emits the CDP events of its target, by event
 * name: a Playwright `CDPSession` for a page, or a
 * {@link ServiceWorkerCdpSession}.
 */
type EventCdpSession = CdpSession & {
  on(method: string, listener: CdpEventListener): unknown;
  off(method: string, listener: CdpEventListener): unknown;
};

type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * A CDP session on a service worker target.
 *
 * Playwright only opens CDP sessions on pages and frames. A worker target is
 * reached from the browser-level CDP session instead: attach with
 * `Target.attachToTarget` (not flattened, because the wrapper cannot send on
 * a flattened session) and tunnel commands through
 * `Target.sendMessageToTarget`. Chrome still supports that deprecated pair.
 * Tunneled messages without an `id` are CDP events; they are emitted by
 * name, like a Playwright `CDPSession` does.
 */
class ServiceWorkerCdpSession implements EventCdpSession {
  readonly #browserSession: CDPSession;

  readonly #sessionId: string;

  readonly #targetId: string;

  readonly #onClose: () => void;

  readonly #pending = new Map<number, PendingCommand>();

  readonly #eventListeners = new Map<string, Set<CdpEventListener>>();

  #nextId = 1;

  #closed = false;

  /**
   * @param browserSession - The browser-level CDP session.
   * @param sessionId - The attached service worker session ID.
   * @param targetId - The attached service worker target ID.
   * @param onClose - Called once when the attached target goes away.
   */
  constructor(
    browserSession: CDPSession,
    sessionId: string,
    targetId: string,
    onClose: () => void,
  ) {
    this.#browserSession = browserSession;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#onClose = onClose;
    browserSession.on('Target.receivedMessageFromTarget', this.#onMessage);
    browserSession.on('Target.detachedFromTarget', this.#onDetached);
    // Target discovery reports a destroyed target when the worker stops.
    browserSession.on('Target.targetDestroyed', this.#onTargetDestroyed);
  }

  /**
   * Sends one command to the service worker target.
   *
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @returns The raw CDP result.
   */
  async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.#throwIfClosed();
    const id = this.#nextId;
    this.#nextId += 1;
    const reply = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#browserSession.send('Target.sendMessageToTarget', {
        sessionId: this.#sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return reply;
  }

  /**
   * Listens for a CDP event of the service worker target.
   *
   * @param method - The CDP event name.
   * @param listener - Called with the event parameters.
   * @returns This session.
   */
  on(method: string, listener: CdpEventListener): this {
    let listeners = this.#eventListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(method, listeners);
    }
    listeners.add(listener);
    return this;
  }

  /**
   * Removes a CDP event listener.
   *
   * @param method - The CDP event name.
   * @param listener - The listener to remove.
   * @returns This session.
   */
  off(method: string, listener: CdpEventListener): this {
    this.#eventListeners.get(method)?.delete(listener);
    return this;
  }

  /**
   * Detaches this session and fails its pending commands.
   */
  async detach(): Promise<void> {
    if (!this.#markClosed()) {
      return;
    }
    await this.#browserSession
      .send('Target.detachFromTarget', { sessionId: this.#sessionId })
      .catch(() => undefined);
  }

  /**
   * Handles a message tunneled from the service worker.
   *
   * @param event - The `Target.receivedMessageFromTarget` payload.
   * @param event.sessionId - The session that sent the message.
   * @param event.message - The JSON-encoded CDP message.
   */
  readonly #onMessage = (event: {
    sessionId: string;
    message: string;
  }): void => {
    if (event.sessionId !== this.#sessionId) {
      return;
    }
    let message: WorkerMessage;
    try {
      message = JSON.parse(event.message) as WorkerMessage;
    } catch {
      return;
    }
    if (message.id === undefined) {
      if (message.method !== undefined) {
        for (const listener of this.#eventListeners.get(message.method) ?? []) {
          try {
            listener(message.params);
          } catch {
            // A failing listener must not break the others.
          }
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'CDP command failed'));
    } else {
      pending.resolve(message.result);
    }
  };

  /**
   * Marks the session closed when the target detaches (the worker stopped).
   *
   * @param event - The `Target.detachedFromTarget` payload.
   * @param event.sessionId - The session that detached.
   */
  readonly #onDetached = (event: { sessionId: string }): void => {
    if (event.sessionId === this.#sessionId) {
      this.#markClosed();
    }
  };

  /**
   * Marks the session closed when its target is destroyed (the worker
   * stopped). Requires `Target.setDiscoverTargets`.
   *
   * @param event - The `Target.targetDestroyed` payload.
   * @param event.targetId - The destroyed target.
   */
  readonly #onTargetDestroyed = (event: { targetId: string }): void => {
    if (event.targetId === this.#targetId) {
      this.#markClosed();
    }
  };

  /**
   * Fails every pending command and stops listening for worker messages.
   *
   * @returns False when the session was already closed.
   */
  #markClosed(): boolean {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    this.#browserSession.off(
      'Target.receivedMessageFromTarget',
      this.#onMessage,
    );
    this.#browserSession.off('Target.detachedFromTarget', this.#onDetached);
    this.#browserSession.off('Target.targetDestroyed', this.#onTargetDestroyed);
    this.#eventListeners.clear();
    for (const pending of this.#pending.values()) {
      pending.reject(this.#closedError());
    }
    this.#pending.clear();
    this.#onClose();
    return true;
  }

  /**
   * Throws when the session is closed.
   */
  #throwIfClosed(): void {
    if (this.#closed) {
      throw this.#closedError();
    }
  }

  /**
   * @returns The error used for commands on a closed session.
   */
  #closedError(): Error {
    return new Error('Session closed. The service worker target is gone.');
  }
}

type CdpEntryBase = {
  event: CdpTargetEvent;
  session?: EventCdpSession;
  opening?: Promise<EventCdpSession>;
  /** Set when the entry is dropped, so an in-flight open does not revive it. */
  dropped?: boolean;
};

type PageEntry = CdpEntryBase & {
  page: Page;
  /** The CDP target ID, once the manager resolved it. */
  targetId?: string;
};

type ServiceWorkerEntry = CdpEntryBase & {
  /** The CDP target ID; a restarted worker has a new one. */
  targetId: string;
  /** The worker script URL. */
  url: string;
  /**
   * The Playwright worker, when Playwright reported one. It is only used to
   * notice the worker stopping: the CDP target list decides liveness.
   */
  worker?: PlaywrightWorker;
};

type CdpEntry = PageEntry | ServiceWorkerEntry;

/** A live `service_worker` target found in the browser target list. */
type ServiceWorkerTarget = {
  extensionId: string;
  targetId: string;
  url: string;
};

/** A `Target.TargetInfo` as reported by the browser session. */
type TargetInfo = { type: string; url: string; targetId: string };

/** One active {@link CdpManager.subscribe} call. */
type Subscription = {
  options: CdpSubscribeOptions;
  /** `options.events` without duplicates. */
  events: string[];
  /** The domains of `options.events`, in first-seen order. */
  domains: string[];
  /** What this subscription added to each session it reached. */
  records: Map<EventCdpSession, SubscriptionRecord>;
  active: boolean;
};

/** What one subscription added to one session. */
type SubscriptionRecord = {
  /** Settles when the listeners are on and the domains are enabled. */
  ready: Promise<void>;
  /** Event names this subscription listens to on the session. */
  methods: string[];
  /** Domains this subscription holds enabled on the session. */
  domains: string[];
};

/**
 * Shared subscription state of one session: one CDP listener per event name
 * (dispatching to every subscriber) and one reference count per enabled
 * domain, so subscribers share the session and its enables.
 */
type SessionSubscriptionState = {
  targetId?: Promise<string>;
  methods: Map<
    string,
    { listener: CdpEventListener; subscriptions: Set<Subscription> }
  >;
  domains: Map<string, { count: number; enabled: Promise<void> }>;
};

/**
 * Reads an Extension service worker target from a target info.
 *
 * @param info - The target info.
 * @returns The target, or undefined for another kind of target.
 */
function toServiceWorkerTarget(
  info: TargetInfo,
): ServiceWorkerTarget | undefined {
  if (info.type !== 'service_worker') {
    return undefined;
  }
  const extensionId = extensionIdFromUrl(info.url);
  return extensionId === undefined
    ? undefined
    : { extensionId, targetId: info.targetId, url: info.url };
}

/**
 * Converts a thrown value to an error.
 *
 * @param error - The thrown value.
 * @returns The value when it is an error, else an error with its text.
 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Tells whether a target is gone: its page is closed, or its entry was
 * dropped after the target went away.
 *
 * @param entry - The target entry.
 * @returns True when nothing can be attached to it any more.
 */
function isTargetGone(entry: CdpEntry): boolean {
  return entry.dropped === true || ('page' in entry && entry.page.isClosed());
}

/**
 * Persistent CDP sessions for one browser session.
 *
 * Opens and caches one session per target (a page, or the extension service
 * worker), shared by every caller of the same target. Concurrent callers
 * share the one in-flight open. A session that turns out to be closed is
 * dropped, and the next call attaches again.
 *
 * `send` never re-sends a command that may have run: on a closed-session
 * error after the command was sent it drops the session and rethrows, so the
 * caller decides whether the command is safe to repeat. A failure to open
 * the session (the command was never sent) is retried once.
 *
 * One instance is shared per `BrowserContext` through {@link getCdpManager}.
 */
export class CdpManager {
  readonly #context: BrowserContext;

  readonly #pageEntries = new WeakMap<Page, PageEntry>();

  readonly #workerEntries = new Map<string, ServiceWorkerEntry>();

  /** Workers already watched for a `close` event. */
  readonly #observedWorkers = new WeakSet<PlaywrightWorker>();

  readonly #entries = new Set<CdpEntry>();

  readonly #listeners = new Map<CdpManagerEvent, Set<CdpManagerListener>>();

  readonly #subscriptions = new Set<Subscription>();

  /**
   * Closed-session attach failures per live page: the manager re-attaches a
   * page whose session died, and a page that keeps failing would otherwise be
   * dropped and re-attached forever, silently. `reported` marks a page over
   * budget, which `#detach` no longer re-attaches.
   */
  readonly #pageAttachFailures = new WeakMap<
    Page,
    { count: number; since: number; reported: boolean }
  >();

  readonly #sessionStates = new WeakMap<
    EventCdpSession,
    SessionSubscriptionState
  >();

  /** The browser session watched for new service worker targets. */
  #watchedBrowserSession: CDPSession | undefined;

  #browserSession: Promise<CDPSession> | undefined;

  /** Whether an Extension service worker was seen during this manager's life. */
  #extensionWorkerSeen = false;

  #disposed = false;

  /**
   * @param context - The browser context whose pages and service workers are
   * targeted. The manager listens for new service workers while it lives.
   */
  constructor(context: BrowserContext) {
    this.#context = context;
    context.on('serviceworker', this.#onServiceWorker);
  }

  /**
   * Returns the persistent session of a target, opening it on first use.
   *
   * @param target - The page, or the extension service worker.
   * @param options - Bounded wait for a service worker target.
   * @returns The target's session.
   */
  async getSession(
    target: CdpTarget,
    options: CdpAttachOptions = {},
  ): Promise<CdpSession> {
    this.#assertLive();
    const { entry, open } = await this.#acquireTarget(target, options);
    return this.#openEntry(entry, open);
  }

  /**
   * Sends one command on a target's persistent session. With `fresh`, opens
   * a one-shot session and detaches it after the command.
   *
   * A command that may have reached the target is never re-sent. Only a
   * failure to open the session is retried once.
   *
   * A `<Domain>.enable` or `<Domain>.disable` is refused with
   * {@link CdpDomainInUseError} while a subscription holds that domain on
   * the target (see {@link subscribe}): the subscription enabled the domain
   * and would disable it on its last unsubscribe. `fresh` commands are not
   * refused, because they run on a session of their own.
   *
   * @param target - The page, or the extension service worker.
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @param options - Timeout, abort signal, and the one-shot `fresh` flag.
   * @returns The raw CDP result.
   */
  async send(
    target: CdpTarget,
    method: string,
    params: Record<string, unknown> = {},
    options: CdpSendOptions = {},
  ): Promise<unknown> {
    this.#assertLive();
    if (options.fresh === true) {
      return this.#sendFresh(target, method, params, options);
    }

    let acquired: { entry: CdpEntry; session: EventCdpSession };
    try {
      acquired = await this.#acquireSession(target, options);
    } catch (error) {
      if (!isClosedSessionError(error)) {
        throw error;
      }
      // Opening failed and the command was never sent: try once more.
      acquired = await this.#acquireSession(target, options);
    }

    this.#assertDomainFree(acquired.session, method);
    try {
      return await this.#race(
        acquired.session.send(method, params),
        method,
        options,
      );
    } catch (error) {
      if (isClosedSessionError(error)) {
        this.#drop(acquired.entry);
      }
      throw error;
    }
  }

  /**
   * Refuses a `<Domain>.enable` or `<Domain>.disable` while a subscription
   * holds that domain on the session.
   *
   * @param session - The session the command would run on.
   * @param method - The CDP method.
   */
  #assertDomainFree(session: EventCdpSession, method: string): void {
    const match = /^([^.]+)\.(?:enable|disable)$/u.exec(method);
    const domain = match?.[1];
    if (domain === undefined) {
      return;
    }
    if (
      (this.#sessionStates.get(session)?.domains.get(domain)?.count ?? 0) > 0
    ) {
      throw new CdpDomainInUseError(method, domain);
    }
  }

  /**
   * Sends one command to the target a subscribed event came from, on its
   * persistent session (for example `Network.getResponseBody` for a
   * request). Only targets that are attached now are reached: a closed page
   * or a stopped worker fails at once instead of being attached again.
   *
   * @param target - The target of a delivered {@link CdpEvent}.
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @param options - Timeout and abort signal.
   * @returns The raw CDP result.
   */
  async sendToEventTarget(
    target: CdpEventTarget,
    method: string,
    params: Record<string, unknown> = {},
    options: CdpAttachOptions = {},
  ): Promise<unknown> {
    this.#assertLive();
    // The timeout covers the target lookup too: a hanging target-info call
    // must not hold the caller longer than the timeout.
    return this.#race(
      this.#sendToAttachedTarget(target, method, params),
      method,
      options,
    );
  }

  /**
   * Finds the attached session of an event target and sends one command on
   * it.
   *
   * @param target - The target of a delivered {@link CdpEvent}.
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @returns The raw CDP result.
   */
  async #sendToAttachedTarget(
    target: CdpEventTarget,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    let session: EventCdpSession | undefined;
    if (target.kind === 'sw') {
      session = this.#workerEntries.get(target.targetId)?.session;
    } else {
      for (const entry of this.#entries) {
        if (!('page' in entry) || !entry.session) {
          continue;
        }
        const targetId = await this.#sessionStates
          .get(entry.session)
          ?.targetId?.catch(() => undefined);
        if (targetId === target.targetId) {
          session = entry.session;
          break;
        }
      }
    }
    if (!session) {
      throw new Error(`CDP target ${target.targetId} is not attached`);
    }
    return session.send(method, params);
  }

  /**
   * Subscribes to a target event.
   *
   * @param event - The event name.
   * @param listener - Called when the event fires.
   * @returns This manager.
   */
  on(event: CdpManagerEvent, listener: CdpManagerListener): this {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  /**
   * Removes a target event listener.
   *
   * @param event - The event name.
   * @param listener - The listener to remove.
   * @returns This manager.
   */
  off(event: CdpManagerEvent, listener: CdpManagerListener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * Delivers CDP events from every page and the Extension service worker.
   *
   * Attaches at once to every open page and to the running service worker,
   * then to each new page (tab, popup) and each new or restarted worker as
   * it appears. On each target it enables the domains of `events` once and
   * shares the target's persistent session with `send` and other
   * subscribers. A worker that restarts as a new target gets a new session,
   * so its domains are enabled again.
   *
   * Network traffic sent before a target is attached is not delivered.
   * `Runtime.enable` replays the console messages Chrome kept for the target,
   * so a late subscriber can receive older console events.
   *
   * The subscription owns the domains of `events` on each target it reaches:
   * while it is active, {@link send} refuses `<Domain>.enable` and
   * `<Domain>.disable` for those domains, and its last unsubscribe disables
   * them. A domain the user enabled by hand before subscribing is not
   * tracked separately.
   *
   * Only pages and the Extension service worker are covered: out-of-process
   * iframes and MV3 offscreen documents are not attached.
   *
   * `onEvent` receives the raw CDP `params`, which are not redacted; a
   * consumer that stores or prints them must redact them first.
   *
   * @param options - The event names, enable parameters and callbacks.
   * @returns The subscription, once the targets open now are attached.
   */
  async subscribe(options: CdpSubscribeOptions): Promise<CdpSubscription> {
    this.#assertLive();
    const domains: string[] = [];
    for (const method of options.events) {
      const dot = method.indexOf('.');
      if (dot <= 0 || dot === method.length - 1) {
        throw new Error(
          `Invalid CDP event name "${method}". Use <Domain>.<event>.`,
        );
      }
      const domain = method.slice(0, dot);
      if (!domains.includes(domain)) {
        domains.push(domain);
      }
    }
    if (domains.length === 0) {
      throw new Error('Subscribe to at least one CDP event');
    }

    const subscription: Subscription = {
      options,
      events: [...new Set(options.events)],
      domains,
      records: new Map(),
      active: true,
    };
    if (this.#subscriptions.size === 0) {
      this.#context.on('page', this.#onPage);
    }
    this.#subscriptions.add(subscription);

    await Promise.all([
      ...this.#context
        .pages()
        .map(async (page) =>
          this.#attachPageForSubscribers(page, [subscription]),
        ),
      this.#attachWorkerForSubscribers([subscription]),
    ]);

    return {
      unsubscribe: async (): Promise<void> => this.#unsubscribe(subscription),
    };
  }

  /**
   * Detaches every cached session and stops listening for service workers.
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#context.off('serviceworker', this.#onServiceWorker);
    for (const subscription of this.#subscriptions) {
      subscription.active = false;
    }
    if (this.#subscriptions.size > 0) {
      this.#context.off('page', this.#onPage);
    }
    this.#subscriptions.clear();
    this.#unwatchTargets();
    const entries = [...this.#entries];
    const browserSession = this.#browserSession;
    this.#browserSession = undefined;
    this.#entries.clear();
    this.#workerEntries.clear();
    await Promise.all([
      ...entries.map(async (entry) => this.#detach(entry)),
      browserSession
        ?.then(async (session) => session.detach())
        .catch(() => undefined),
    ]);
  }

  /**
   * Marks the Extension as seen and watches a newly reported service worker
   * for its `close` event. A restarted worker can reuse the same Playwright
   * object, so liveness is decided by the CDP target list instead.
   *
   * @param worker - The service worker reported by the context.
   */
  readonly #onServiceWorker = (worker: PlaywrightWorker): void => {
    const extensionId = extensionIdFromUrl(worker.url());
    if (extensionId === undefined) {
      return;
    }
    this.#extensionWorkerSeen = true;
    this.#observeWorker(worker);
    if (this.#subscriptions.size > 0) {
      // A backup for `Target.targetCreated`; the target list decides.
      // eslint-disable-next-line no-void
      void this.#attachWorkerForSubscribers([...this.#subscriptions]);
    }
  };

  /**
   * Attaches subscribers to a new page (tab, popup, dapp page).
   *
   * @param page - The new page.
   */
  readonly #onPage = (page: Page): void => {
    // eslint-disable-next-line no-void
    void this.#attachPageForSubscribers(page, [...this.#subscriptions]);
  };

  /**
   * Attaches subscribers to a new Extension service worker target, such as
   * a worker that restarted after MV3 stopped it.
   *
   * @param event - The `Target.targetCreated` payload.
   * @param event.targetInfo - The new target.
   */
  readonly #onTargetCreated = (event: { targetInfo: TargetInfo }): void => {
    const target = toServiceWorkerTarget(event.targetInfo);
    const knownExtensionId = this.#extensionId();
    if (
      target === undefined ||
      (knownExtensionId !== undefined &&
        target.extensionId !== knownExtensionId)
    ) {
      return;
    }
    const subscriptions = [...this.#subscriptions];
    this.#attachWorkerTarget(target, subscriptions).catch((error: unknown) =>
      this.#reportAttachError(subscriptions, error, false),
    );
  };

  /**
   * Starts watching the browser session for new service worker targets,
   * once per browser session.
   */
  async #watchTargets(): Promise<void> {
    const browserSession = await this.#getBrowserSession();
    if (
      this.#disposed ||
      this.#subscriptions.size === 0 ||
      this.#watchedBrowserSession === browserSession
    ) {
      return;
    }
    this.#unwatchTargets();
    browserSession.on('Target.targetCreated', this.#onTargetCreated);
    this.#watchedBrowserSession = browserSession;
  }

  /**
   * Stops watching the browser session for new targets.
   */
  #unwatchTargets(): void {
    this.#watchedBrowserSession?.off(
      'Target.targetCreated',
      this.#onTargetCreated,
    );
    this.#watchedBrowserSession = undefined;
  }

  /**
   * Attaches subscribers to a page. Failures go to their `onError`.
   *
   * @param page - The page.
   * @param subscriptions - The subscribers to attach.
   * @param retry - Whether this is the re-attach after a failure (it counts
   * against the page's budget) rather than a new trigger.
   */
  async #attachPageForSubscribers(
    page: Page,
    subscriptions: Subscription[],
    retry = false,
  ): Promise<void> {
    if (!retry) {
      // A new trigger (a subscription, a new page) gets a fresh budget; only
      // the re-attach after a failure counts against it.
      this.#pageAttachFailures.delete(page);
    }
    try {
      const { entry, session } = await this.#acquireSession(
        { kind: 'page', page },
        {},
      );
      await Promise.all(
        subscriptions.map(async (subscription) =>
          this.#addToSession(subscription, entry, session),
        ),
      );
    } catch (error) {
      this.#reportAttachError(
        subscriptions,
        error,
        page.isClosed?.(),
        undefined,
        page,
      );
    }
  }

  /**
   * Watches for new worker targets and attaches subscribers to the running
   * Extension service worker, if any. Does not wait for a stopped worker: a
   * new worker is attached when its target is created. Failures go to the
   * subscribers' `onError`.
   *
   * @param subscriptions - The subscribers to attach.
   */
  async #attachWorkerForSubscribers(
    subscriptions: Subscription[],
  ): Promise<void> {
    try {
      await this.#watchTargets();
      if (this.#disposed) {
        return;
      }
      const knownExtensionId = this.#extensionId();
      const targets = (await this.#serviceWorkerTargets()).filter(
        (candidate) =>
          knownExtensionId === undefined ||
          candidate.extensionId === knownExtensionId,
      );
      // While a worker restarts, the list can briefly hold the old and the
      // new target. Keep the worker already attached (a newer one is
      // attached by `Target.targetCreated`) rather than switching back.
      const target =
        targets.find((candidate) =>
          this.#workerEntries.has(candidate.targetId),
        ) ?? targets[0];
      if (target !== undefined) {
        await this.#attachWorkerTarget(target, subscriptions);
      }
    } catch (error) {
      this.#reportAttachError(subscriptions, error, false);
    }
  }

  /**
   * Reports a failure to attach subscribers. Target loss is not an error: a
   * page that closed, or an MV3 worker that stopped and will be attached
   * again when it restarts, fails routine attaches (for example
   * `<Domain>.enable` on a session that just closed). A dead session on a
   * live target is not an error either: the entry is dropped so `#detach`
   * attaches the subscribers to the live target again.
   *
   * @param subscriptions - The subscribers.
   * @param error - The error.
   * @param targetGone - Whether the target itself is gone.
   * @param entry - The target entry, when the failure has one.
   * @param page - The page, when the failure happens before an entry exists.
   */
  #reportAttachError(
    subscriptions: Subscription[],
    error: unknown,
    targetGone: boolean,
    entry?: CdpEntry,
    page?: Page,
  ): void {
    if (isClosedSessionError(error)) {
      if (!targetGone) {
        this.#notePageAttachFailure(
          subscriptions,
          error,
          page ??
            (entry !== undefined && 'page' in entry ? entry.page : undefined),
        );
      }
      if (entry !== undefined) {
        // The target outlives its session: drop the entry so `#detach`
        // attaches the subscribers again on a fresh session.
        this.#drop(entry);
      }
      return;
    }
    if (targetGone || toError(error).message === STOPPED_WORKER_MESSAGE) {
      return;
    }
    this.#report(subscriptions, error);
  }

  /**
   * Counts a closed-session attach failure for a live page. After
   * {@link MAX_PAGE_REATTACH_FAILURES} failures in
   * {@link PAGE_REATTACH_WINDOW_MS}, it reports once and marks the page so
   * `#detach` stops re-attaching it; a new trigger clears the budget.
   *
   * @param subscriptions - The subscribers of the failed attach.
   * @param error - The closed-session error.
   * @param page - The live page, when known.
   */
  #notePageAttachFailure(
    subscriptions: Subscription[],
    error: unknown,
    page: Page | undefined,
  ): void {
    if (page === undefined) {
      return;
    }
    const now = Date.now();
    const previous = this.#pageAttachFailures.get(page);
    const inWindow =
      previous !== undefined && now - previous.since <= PAGE_REATTACH_WINDOW_MS;
    const state = {
      count: inWindow ? previous.count + 1 : 1,
      since: inWindow ? previous.since : now,
      reported: inWindow && previous.reported,
    };
    if (state.count >= MAX_PAGE_REATTACH_FAILURES) {
      // Report once, then stay quiet: the subscribers hear about the page
      // once and the manager stops trying until a new trigger.
      if (!state.reported) {
        this.#report(subscriptions, error);
      }
      state.reported = true;
    }
    this.#pageAttachFailures.set(page, state);
  }

  /**
   * Opens (or reuses) the session of a live service worker target and adds
   * subscribers to it.
   *
   * @param target - The live service worker target.
   * @param subscriptions - The subscribers to attach.
   */
  async #attachWorkerTarget(
    target: ServiceWorkerTarget,
    subscriptions: Subscription[],
  ): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const entry = this.#workerEntryFor(target);
    const session = await this.#openEntry(entry, async () =>
      this.#openWorkerSession(entry.targetId, () => this.#drop(entry)),
    );
    await Promise.all(
      subscriptions.map(async (subscription) =>
        this.#addToSession(subscription, entry, session),
      ),
    );
  }

  /**
   * Adds a subscriber to a session once: listens for its events and enables
   * its domains, sharing both with the other subscribers of the session.
   *
   * @param subscription - The subscriber.
   * @param entry - The target entry of the session.
   * @param session - The session.
   * @returns Settles when the subscriber is ready on the session. Never
   * rejects: failures go to the subscriber's `onError`.
   */
  async #addToSession(
    subscription: Subscription,
    entry: CdpEntry,
    session: EventCdpSession,
  ): Promise<void> {
    const existing = subscription.records.get(session);
    if (existing) {
      return existing.ready;
    }
    if (!subscription.active) {
      return undefined;
    }
    const record: SubscriptionRecord = {
      ready: Promise.resolve(),
      methods: [],
      domains: [],
    };
    subscription.records.set(session, record);
    record.ready = this.#fillRecord(subscription, entry, session, record);
    return record.ready;
  }

  /**
   * Registers the event listeners and domain enables of one subscriber on a
   * session.
   *
   * @param subscription - The subscriber.
   * @param entry - The target entry of the session.
   * @param session - The session.
   * @param record - Where to note what was added.
   */
  async #fillRecord(
    subscription: Subscription,
    entry: CdpEntry,
    session: EventCdpSession,
    record: SubscriptionRecord,
  ): Promise<void> {
    const state = this.#sessionState(session);
    let describe: () => CdpEventTarget;
    try {
      describe = await this.#describeTarget(entry, session, state);
    } catch (error) {
      // A record only guards a successful attach: delete it so a later
      // attach trigger retries instead of reusing `record.ready`.
      if (subscription.records.get(session) === record) {
        subscription.records.delete(session);
      }
      this.#reportAttachError(
        [subscription],
        error,
        isTargetGone(entry),
        entry,
      );
      return;
    }
    if (!subscription.active || subscription.records.get(session) !== record) {
      return;
    }

    for (const method of subscription.events) {
      let handler = state.methods.get(method);
      if (!handler) {
        const subscriptions = new Set<Subscription>();
        const listener: CdpEventListener = (params) => {
          const event: CdpEvent = {
            target: describe(),
            method,
            params: params ?? {},
            t: Date.now(),
          };
          for (const subscriber of [...subscriptions]) {
            this.#deliver(subscriber, event);
          }
        };
        handler = { listener, subscriptions };
        state.methods.set(method, handler);
        session.on(method, listener);
      }
      handler.subscriptions.add(subscription);
      record.methods.push(method);
    }

    const results = await Promise.allSettled(
      subscription.domains.map(async (domain) =>
        this.#enableDomain(subscription, session, state, record, domain),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.#reportAttachError(
          [subscription],
          result.reason,
          isTargetGone(entry),
          entry,
        );
      }
    }
    if (
      results.every((result) => result.status === 'fulfilled') &&
      'page' in entry
    ) {
      // The domains are on: the page's attach failures, if any, are over.
      this.#pageAttachFailures.delete(entry.page);
    }
  }

  /**
   * Enables a domain on a session for one subscriber. The first subscriber
   * sends `<Domain>.enable`; later ones share it.
   *
   * @param subscription - The subscriber.
   * @param session - The session.
   * @param state - The session's shared subscription state.
   * @param record - Where to note the enabled domain.
   * @param domain - The CDP domain.
   */
  async #enableDomain(
    subscription: Subscription,
    session: EventCdpSession,
    state: SessionSubscriptionState,
    record: SubscriptionRecord,
    domain: string,
  ): Promise<void> {
    let enabled = state.domains.get(domain);
    if (!enabled) {
      enabled = {
        count: 0,
        enabled: session
          .send(`${domain}.enable`, subscription.options.enable?.[domain] ?? {})
          .then(() => undefined),
      };
      state.domains.set(domain, enabled);
    }
    enabled.count += 1;
    record.domains.push(domain);
    try {
      await enabled.enabled;
    } catch (error) {
      record.domains.splice(record.domains.indexOf(domain), 1);
      enabled.count -= 1;
      if (enabled.count === 0) {
        // Let a later attach try again.
        state.domains.delete(domain);
      }
      throw error;
    }
  }

  /**
   * Returns the shared subscription state of a session.
   *
   * @param session - The session.
   * @returns Its state, created on first use.
   */
  #sessionState(session: EventCdpSession): SessionSubscriptionState {
    let state = this.#sessionStates.get(session);
    if (!state) {
      state = { methods: new Map(), domains: new Map() };
      this.#sessionStates.set(session, state);
    }
    return state;
  }

  /**
   * Resolves how to tag the events of a session's target.
   *
   * @param entry - The target entry.
   * @param session - The target session.
   * @param state - The session's shared subscription state.
   * @returns A function returning the current target tag.
   */
  async #describeTarget(
    entry: CdpEntry,
    session: EventCdpSession,
    state: SessionSubscriptionState,
  ): Promise<() => CdpEventTarget> {
    if (!('page' in entry)) {
      const target: CdpEventTarget = {
        kind: 'sw',
        targetId: entry.targetId,
        url: entry.url,
      };
      return () => target;
    }
    if (state.targetId === undefined) {
      const lookup = session
        .send('Target.getTargetInfo', {})
        .then(
          (result) =>
            (result as { targetInfo?: { targetId?: string } } | undefined)
              ?.targetInfo?.targetId ?? '',
        );
      state.targetId = lookup;
      // A failed lookup is not the target's ID: let a later attach retry.
      lookup.catch(() => {
        if (state.targetId === lookup) {
          state.targetId = undefined;
        }
      });
    }
    const targetId = await state.targetId;
    const { page } = entry;
    entry.targetId = targetId;
    entry.event.targetId = targetId;
    return () => ({ kind: 'page', targetId, url: page.url() });
  }

  /**
   * Removes one subscriber from a session, and disables the domains that no
   * other subscriber needs.
   *
   * @param subscription - The subscriber.
   * @param session - The session.
   * @param record - What the subscriber added to the session.
   */
  async #release(
    subscription: Subscription,
    session: EventCdpSession,
    record: SubscriptionRecord,
  ): Promise<void> {
    const state = this.#sessionStates.get(session);
    if (!state) {
      // The session was detached while attaching; its listeners and domains
      // went with it.
      return;
    }
    for (const method of record.methods) {
      const handler = state.methods.get(method);
      handler?.subscriptions.delete(subscription);
      if (handler?.subscriptions.size === 0) {
        session.off(method, handler.listener);
        state.methods.delete(method);
      }
    }
    const disables: Promise<unknown>[] = [];
    for (const domain of record.domains) {
      const enabled = state.domains.get(domain);
      if (enabled) {
        enabled.count -= 1;
        if (enabled.count === 0) {
          state.domains.delete(domain);
          disables.push(
            session.send(`${domain}.disable`, {}).catch(() => undefined),
          );
        }
      }
    }
    await Promise.all(disables);
  }

  /**
   * Ends a subscription. Idempotent.
   *
   * @param subscription - The subscription.
   */
  async #unsubscribe(subscription: Subscription): Promise<void> {
    if (!subscription.active) {
      return;
    }
    subscription.active = false;
    this.#subscriptions.delete(subscription);
    if (this.#subscriptions.size === 0) {
      this.#context.off('page', this.#onPage);
      this.#unwatchTargets();
    }
    const records = [...subscription.records];
    await Promise.all(
      records.map(async ([session, record]) => {
        await record.ready;
        subscription.records.delete(session);
        await this.#release(subscription, session, record);
      }),
    );
  }

  /**
   * Delivers an event to one subscriber.
   *
   * @param subscription - The subscriber.
   * @param event - The event.
   */
  #deliver(subscription: Subscription, event: CdpEvent): void {
    if (!subscription.active) {
      return;
    }
    try {
      subscription.options.onEvent(event);
    } catch (error) {
      this.#report([subscription], error);
    }
  }

  /**
   * Reports an error to subscribers that have `onError`.
   *
   * @param subscriptions - The subscribers.
   * @param error - The error.
   */
  #report(subscriptions: Subscription[], error: unknown): void {
    for (const subscription of subscriptions) {
      if (!subscription.active) {
        continue;
      }
      try {
        subscription.options.onError?.(toError(error));
      } catch {
        // A failing error handler must not break the other subscribers.
      }
    }
  }

  /**
   * Watches a service worker once for its `close` event. MV3 workers stop
   * when idle, and Playwright's `close` event is a signal to forget the
   * cached entry. The browser target list stays the source of truth: a
   * restarted worker can reuse the same Playwright `Worker` object.
   *
   * @param worker - The service worker to watch.
   */
  #observeWorker(worker: PlaywrightWorker): void {
    if (this.#observedWorkers.has(worker)) {
      return;
    }
    this.#observedWorkers.add(worker);
    worker.once?.('close', () => {
      for (const entry of [...this.#workerEntries.values()]) {
        if (entry.worker === worker) {
          this.#drop(entry);
        }
      }
    });
  }

  /**
   * Resolves the target's entry and its session opener, waiting for a
   * service worker when needed.
   *
   * @param target - The target.
   * @param options - Bounded wait for a service worker target.
   * @returns The entry and a function that opens its session.
   */
  async #acquireTarget(
    target: CdpTarget,
    options: CdpAttachOptions,
  ): Promise<{ entry: CdpEntry; open: () => Promise<EventCdpSession> }> {
    if (target.kind === 'page') {
      const entry = this.#pageEntry(target.page);
      return {
        entry,
        open: async (): Promise<EventCdpSession> =>
          this.#openPageSession(target.page),
      };
    }
    const entry = await this.#workerEntry(options);
    return {
      entry,
      open: async (): Promise<EventCdpSession> =>
        this.#openWorkerSession(entry.targetId, () => this.#drop(entry)),
    };
  }

  /**
   * Resolves the target and opens its session.
   *
   * @param target - The target.
   * @param options - Bounded wait for a service worker target.
   * @returns The entry and its session.
   */
  async #acquireSession(
    target: CdpTarget,
    options: CdpAttachOptions,
  ): Promise<{ entry: CdpEntry; session: EventCdpSession }> {
    const { entry, open } = await this.#acquireTarget(target, options);
    return { entry, session: await this.#openEntry(entry, open) };
  }

  /**
   * Returns the cached entry of a page, creating it on first use.
   *
   * @param page - The page.
   * @returns Its entry.
   */
  #pageEntry(page: Page): PageEntry {
    const cached = this.#pageEntries.get(page);
    if (cached) {
      return cached;
    }
    const entry: PageEntry = {
      page,
      event: { kind: 'page', target: page },
    };
    this.#pageEntries.set(page, entry);
    this.#entries.add(entry);
    // A closed page's session is dead: forget it so closed tabs do not pile up.
    page.once?.('close', () => this.#drop(entry));
    return entry;
  }

  /**
   * Returns the cached entry of the extension service worker target, waiting
   * for a live CDP target when the worker is not running. The entry is keyed
   * by CDP target ID: a restarted worker has a new target ID, so it gets a
   * new entry and session even when Playwright keeps the same `Worker`
   * object (or emits no new `serviceworker` event).
   *
   * @param options - Bounded wait for the worker.
   * @returns Its entry.
   */
  async #workerEntry(options: CdpAttachOptions): Promise<ServiceWorkerEntry> {
    const knownExtensionId = this.#extensionId();
    const target = await this.#findServiceWorkerTarget(
      knownExtensionId,
      options,
    );
    return this.#workerEntryFor(target);
  }

  /**
   * Returns the cached entry of a live service worker target, creating it on
   * first use and dropping the entry of any previous worker.
   *
   * @param target - The live service worker target.
   * @returns Its entry.
   */
  #workerEntryFor(target: ServiceWorkerTarget): ServiceWorkerEntry {
    this.#extensionWorkerSeen = true;
    const cached = this.#workerEntries.get(target.targetId);
    if (cached) {
      return cached;
    }
    // A different target ID is a different worker: its old session is dead.
    // The manager tracks one Extension service worker at a time.
    for (const entry of [...this.#workerEntries.values()]) {
      this.#drop(entry);
    }
    const worker = this.#workerFor(target.url);
    if (worker !== undefined) {
      this.#observeWorker(worker);
    }
    const entry: ServiceWorkerEntry = {
      targetId: target.targetId,
      url: target.url,
      worker,
      event: { kind: 'sw', targetId: target.targetId, target: worker },
    };
    this.#workerEntries.set(target.targetId, entry);
    this.#entries.add(entry);
    return entry;
  }

  /**
   * Returns the Playwright worker reported for a URL, when there is one.
   *
   * @param url - The service worker URL.
   * @returns The worker, or undefined when Playwright has not reported it.
   */
  #workerFor(url: string): PlaywrightWorker | undefined {
    return this.#context
      .serviceWorkers()
      .find((worker) => worker.url() === url);
  }

  /**
   * Lists the live extension service worker targets. Playwright's
   * `context.serviceWorkers()` is not authoritative: after an MV3 worker
   * restart it can keep returning a stale `Worker` (sometimes the same object
   * with the same URL), so the browser target list decides.
   *
   * @returns The live extension service worker targets.
   */
  async #serviceWorkerTargets(): Promise<ServiceWorkerTarget[]> {
    const browserSession = await this.#getBrowserSession();
    const { targetInfos } = await browserSession.send('Target.getTargets');
    return (targetInfos as TargetInfo[]).flatMap((info) => {
      const target = toServiceWorkerTarget(info);
      return target === undefined ? [] : [target];
    });
  }

  /**
   * Finds a live extension service worker target, polling the browser target
   * list while the worker is not running. A stopped MV3 worker cannot be
   * started from CDP: only Extension activity starts it, so once the
   * Extension is known the wait is short and fails with an actionable error.
   *
   * @param knownExtensionId - The extension ID to filter on, when known.
   * @param options - Bounded wait for the worker.
   * @returns The live target.
   */
  async #findServiceWorkerTarget(
    knownExtensionId: string | undefined,
    options: CdpAttachOptions,
  ): Promise<ServiceWorkerTarget> {
    const find = async (): Promise<ServiceWorkerTarget | undefined> => {
      const targets = (await this.#serviceWorkerTargets()).filter(
        (target) =>
          knownExtensionId === undefined ||
          target.extensionId === knownExtensionId,
      );
      // While a worker restarts, the list can briefly hold the old and the
      // new target. Keep the worker already attached, like
      // `#attachWorkerForSubscribers` does, rather than switching back.
      return (
        targets.find((target) => this.#workerEntries.has(target.targetId)) ??
        targets[0]
      );
    };

    const existing = await find();
    if (existing) {
      return existing;
    }

    const extensionKnown =
      knownExtensionId !== undefined || this.#extensionWorkerSeen;
    const requestedMs = options.timeoutMs ?? DEFAULT_SW_ATTACH_TIMEOUT_MS;
    const timeoutMs = extensionKnown
      ? Math.min(requestedMs, STOPPED_WORKER_WAIT_MS)
      : requestedMs;
    const { signal } = options;
    if (signal?.aborted === true) {
      throw abortError(signal);
    }

    return new Promise<ServiceWorkerTarget>((resolve, reject) => {
      const handles: {
        timer?: ReturnType<typeof setTimeout>;
        poll?: ReturnType<typeof setInterval>;
      } = {};

      /**
       * Stops waiting and runs the settling action.
       *
       * @param action - Resolves or rejects the wait.
       */
      function finish(action: () => void): void {
        clearTimeout(handles.timer);
        clearInterval(handles.poll);
        signal?.removeEventListener('abort', onAbort);
        action();
      }
      /**
       * Settles when a live target appears, or fails the wait.
       */
      async function check(): Promise<void> {
        const target = await find();
        if (target) {
          finish(() => resolve(target));
        }
      }
      /**
       * Settles the wait when the signal aborts.
       */
      function onAbort(): void {
        finish(() => reject(abortError(signal as AbortSignal)));
      }

      handles.timer = setTimeout(() => {
        finish(() =>
          reject(
            extensionKnown
              ? stoppedWorkerError()
              : new Error(
                  `Timed out after ${timeoutMs}ms waiting for the extension service worker`,
                ),
          ),
        );
      }, timeoutMs);
      handles.poll = setInterval(() => {
        check().catch((error: unknown) => finish(() => reject(error)));
      }, SW_TARGET_POLL_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Opens a CDP session on a page.
   *
   * @param page - The page.
   * @returns Its session.
   */
  async #openPageSession(page: Page): Promise<EventCdpSession> {
    // A Playwright CDPSession has this send/detach/on/off surface.
    return (await this.#context.newCDPSession(
      page,
    )) as unknown as EventCdpSession;
  }

  /**
   * Opens a session on the service worker target through the browser-level
   * CDP session, because Playwright cannot open one on a `Worker`.
   *
   * @param targetId - The CDP target ID of the worker.
   * @param onClose - Called once when the attached target goes away.
   * @returns Its session.
   */
  async #openWorkerSession(
    targetId: string,
    onClose: () => void,
  ): Promise<EventCdpSession> {
    const browserSession = await this.#getBrowserSession();
    let sessionId: string;
    try {
      ({ sessionId } = await browserSession.send('Target.attachToTarget', {
        targetId,
        flatten: false,
      }));
    } catch (error) {
      // The target can disappear between the target list and the attach.
      if (isClosedSessionError(error) || isMissingTargetError(error)) {
        throw stoppedWorkerError();
      }
      throw error;
    }
    return new ServiceWorkerCdpSession(
      browserSession,
      sessionId,
      targetId,
      onClose,
    );
  }

  /**
   * Returns the browser-level CDP session, opening it on first use.
   *
   * @returns The browser session.
   */
  async #getBrowserSession(): Promise<CDPSession> {
    this.#browserSession ??= (async (): Promise<CDPSession> => {
      const browser = this.#context.browser();
      if (!browser) {
        throw new Error(
          'CDP service worker targets need a Chromium browser session',
        );
      }
      const session = await browser.newBrowserCDPSession();
      // Once per browser session: report target destruction, so a stopped
      // worker closes its CDP session instead of leaving commands pending.
      await session.send('Target.setDiscoverTargets', { discover: true });
      return session;
    })().catch((error: unknown) => {
      this.#browserSession = undefined;
      throw error;
    });
    return this.#browserSession;
  }

  /**
   * Opens and caches the session of an entry, sharing one in-flight open
   * between concurrent callers.
   *
   * @param entry - The target entry.
   * @param open - Opens a new session for the entry's target.
   * @returns The cached session.
   */
  async #openEntry(
    entry: CdpEntry,
    open: () => Promise<EventCdpSession>,
  ): Promise<EventCdpSession> {
    if (entry.session) {
      return entry.session;
    }
    entry.opening ??= (async (): Promise<EventCdpSession> => {
      const session = await open();
      if (this.#disposed) {
        await session.detach().catch(() => undefined);
        throw new Error('CDP manager is disposed');
      }
      if (entry.dropped === true) {
        // The target went away while the session was opening: never hand
        // callers a session on a dead target, they would hang.
        await session.detach().catch(() => undefined);
        throw 'worker' in entry
          ? stoppedWorkerError()
          : new Error('CDP target closed while attaching');
      }
      entry.session = session;
      this.#emit('targetAttached', entry.event);
      return session;
    })().finally(() => {
      entry.opening = undefined;
    });
    return entry.opening;
  }

  /**
   * Sends a command on a one-shot session and detaches it afterwards.
   *
   * @param target - The target.
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @param options - Timeout, abort signal and `fresh`.
   * @returns The raw CDP result.
   */
  async #sendFresh(
    target: CdpTarget,
    method: string,
    params: Record<string, unknown>,
    options: CdpSendOptions,
  ): Promise<unknown> {
    let session: CdpSession | undefined;
    try {
      session =
        target.kind === 'page'
          ? await this.#openPageSession(target.page)
          : await this.#openFreshWorkerSession(options);
      return await this.#race(session.send(method, params), method, options);
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  /**
   * Opens a one-shot session on the extension service worker.
   *
   * @param options - Bounded wait for the worker.
   * @returns The new session.
   */
  async #openFreshWorkerSession(
    options: CdpAttachOptions,
  ): Promise<CdpSession> {
    const target = await this.#findServiceWorkerTarget(
      this.#extensionId(),
      options,
    );
    return this.#openWorkerSession(target.targetId, () => undefined);
  }

  /**
   * Races an operation against the timeout and the abort signal.
   *
   * @param operation - The CDP send.
   * @param method - The method name, used in the timeout error.
   * @param options - Timeout and abort signal.
   * @returns The operation result.
   */
  async #race(
    operation: Promise<unknown>,
    method: string,
    options: CdpAttachOptions,
  ): Promise<unknown> {
    const { timeoutMs, signal } = options;
    if (signal?.aborted === true) {
      throw abortError(signal);
    }
    const promises: Promise<unknown>[] = [operation];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    if (timeoutMs !== undefined) {
      promises.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `CDP call "${method}" timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        }),
      );
    }
    if (signal) {
      promises.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = (): void => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    // A send still pending after the race settles later; ignore it.
    operation.catch(() => undefined);
    try {
      return await Promise.race(promises);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * Detaches the session of an entry and emits `targetDetached`.
   *
   * @param entry - The entry to detach.
   */
  async #detach(entry: CdpEntry): Promise<void> {
    const { session } = entry;
    entry.session = undefined;
    if (!session) {
      return;
    }
    // The session's listeners and enabled domains go with it.
    this.#sessionStates.delete(session);
    for (const subscription of this.#subscriptions) {
      subscription.records.delete(session);
    }
    this.#emit('targetDetached', entry.event);
    await session.detach().catch(() => undefined);
    if (this.#disposed || this.#subscriptions.size === 0) {
      return;
    }
    // Subscribers keep their events when the target outlives its session:
    // a page whose session failed, or a worker whose Playwright `close`
    // fired while its CDP target is still live. A stopped worker is attached
    // again by `Target.targetCreated` when it restarts.
    if (!('page' in entry)) {
      await this.#attachWorkerForSubscribers([...this.#subscriptions]);
    } else if (
      !entry.page.isClosed() &&
      !this.#pageAttachFailures.get(entry.page)?.reported
    ) {
      await this.#attachPageForSubscribers(
        entry.page,
        [...this.#subscriptions],
        true,
      );
    }
  }

  /**
   * Drops an entry and detaches its session.
   *
   * @param entry - The entry to drop.
   */
  #drop(entry: CdpEntry): void {
    if (!this.#entries.delete(entry)) {
      return;
    }
    entry.dropped = true;
    if ('page' in entry) {
      this.#pageEntries.delete(entry.page);
    } else {
      this.#workerEntries.delete(entry.targetId);
    }
    // Fire-and-forget: callers are synchronous event handlers.
    // eslint-disable-next-line no-void
    void this.#detach(entry);
  }

  /**
   * Emits a target event.
   *
   * @param event - The event name.
   * @param payload - The target payload.
   */
  #emit(event: CdpManagerEvent, payload: CdpTargetEvent): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  /**
   * Reads the extension ID of this context from its pages, then its
   * service workers.
   *
   * @returns The extension ID, or undefined when the context has no
   * extension page or worker yet.
   */
  #extensionId(): string | undefined {
    for (const page of this.#context.pages()) {
      const extensionId = extensionIdFromUrl(page.url());
      if (extensionId !== undefined) {
        return extensionId;
      }
    }
    for (const worker of this.#context.serviceWorkers()) {
      const extensionId = extensionIdFromUrl(worker.url());
      if (extensionId !== undefined) {
        return extensionId;
      }
    }
    return undefined;
  }

  /**
   * Throws when the manager was disposed.
   */
  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('CDP manager is disposed');
    }
  }
}

const managers = new WeakMap<BrowserContext, CdpManager>();

/**
 * Returns the CDP manager of a browser context, creating it on first use.
 * Every caller of the same context shares one manager, so sessions persist
 * across tool calls.
 *
 * @param context - The browser context.
 * @returns Its manager.
 */
export function getCdpManager(context: BrowserContext): CdpManager {
  let manager = managers.get(context);
  if (!manager) {
    manager = new CdpManager(context);
    managers.set(context, manager);
  }
  return manager;
}

/**
 * Disposes the CDP manager of a browser context, if one was created, and
 * forgets it so a later call starts a new manager.
 *
 * @param context - The browser context.
 */
export async function disposeCdpManager(
  context: BrowserContext,
): Promise<void> {
  const manager = managers.get(context);
  managers.delete(context);
  await manager?.dispose();
}
