import type {
  BrowserContext,
  CDPSession,
  Page,
  Worker as PlaywrightWorker,
} from '@playwright/test';

import { ErrorCodes } from '../tools/types/errors.js';
import { debugWarn } from '../utils/logger.js';

/**
 * Target kinds a {@link CdpManager} can attach to: a page, the Extension
 * service worker, the MV3 offscreen document (`offscreen.html`), and an
 * out-of-process iframe of the offscreen document (`snaps/index.html`, one
 * per snap job). A string union so more targets (for example a mobile `app`)
 * can be added without changing the manager interface.
 */
export type CdpTargetKind = 'page' | 'sw' | 'offscreen' | 'iframe';

/** The target kinds that Playwright does not track, see {@link CdpManager.watchSessions}. */
export type CdpChildTargetKind = 'offscreen' | 'iframe';

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
export type CdpTargetLifecycleEvent = {
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
export type CdpManagerListener = (event: CdpTargetLifecycleEvent) => void;

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
   * a domain on a target sets them. Parameters are not merged: a later
   * subscriber that passes other parameters for a domain already enabled on
   * a target gets the first subscriber's, and an error through `onError`
   * that names the target and the domain.
   */
  enable?: Readonly<Record<string, Record<string, unknown>>>;
  /** Called synchronously for each event, in the order of its target. */
  onEvent: (event: CdpEvent) => void;
  /**
   * Called when a target cannot be attached or enabled in time, when the
   * `enable` parameters conflict with another subscriber's, or when
   * `onEvent` throws. Without it, errors go to the debug log
   * (`DEBUG=true`). It must not throw; an error it throws is ignored.
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

/** Listener of one CDP event of a session, called with its parameters. */
export type CdpEventListener = (
  params: Record<string, unknown> | undefined,
) => void;

/** A CDP session that also emits the CDP events of its target, by name. */
export type CdpEventSession = CdpSession & {
  on(method: string, listener: CdpEventListener): unknown;
  off(method: string, listener: CdpEventListener): unknown;
};

/** A target session handed to a {@link CdpManager.watchSessions} watcher. */
export type CdpWatchedSession = {
  /** The target now. Its URL can change after the attach. */
  target: () => CdpEventTarget;
  /** The shared persistent session of the target. Do not detach it. */
  session: CdpEventSession;
};

/**
 * Options for {@link CdpManager.watchSessions}.
 */
export type CdpWatchSessionsOptions = {
  /** The target kinds to watch. */
  kinds: readonly CdpChildTargetKind[];
  /**
   * Called once per target session. A new snaps iframe is paused until it
   * settles (at most {@link CDP_ATTACH_STEP_TIMEOUT_MS}), so a command sent
   * here (for example `Fetch.enable`) applies before the iframe's first
   * request.
   */
  onAttach: (watched: CdpWatchedSession) => Promise<void> | void;
  /** Called when a watched session is gone: its target closed or detached. */
  onDetach?: (target: CdpEventTarget) => void;
  /** Called for a failure; without it, errors go to the debug log. */
  onError?: (error: Error) => void;
};

/**
 * A live watch returned by {@link CdpManager.watchSessions}.
 */
export type CdpSessionWatch = {
  /**
   * Stops calling the watcher. The sessions stay attached: they are shared.
   * Idempotent.
   */
  unwatch(): Promise<void>;
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
 * How long each step of attaching a subscription to a target may take:
 * opening the target's session, reading its target info, and each
 * `<Domain>.enable`. The same bound applies to each `<Domain>.disable` and to
 * the wait for an attach in progress when a subscription ends. A target that
 * does not answer (paused in the debugger, frozen) then costs one bound, not
 * a hang.
 */
export const CDP_ATTACH_STEP_TIMEOUT_MS = 5_000;

/**
 * Error for a CDP command that needs the Extension service worker while it is
 * not running.
 */
export const STOPPED_WORKER_MESSAGE =
  'The Extension service worker is not running (MV3 workers stop when idle). ' +
  'Interact with the Extension (open or reload an Extension page) to start it, then retry.';

/**
 * Error for a `<Domain>.disable`, or a `<Domain>.enable` with other
 * parameters, refused while an event subscription holds that domain on the
 * same target. A subscription owns the domains it enabled: disabling one
 * would silently stop the events, and an enable with other parameters would
 * change them (Chrome applies the last `Network.enable`), or be ignored.
 */
export class CdpDomainInUseError extends Error {
  /** The `MM_CDP_BLOCKED` tool error code. */
  readonly code: typeof ErrorCodes.MM_CDP_BLOCKED = ErrorCodes.MM_CDP_BLOCKED;

  /**
   * @param method - The refused CDP method.
   * @param domain - The CDP domain that a subscription holds.
   */
  constructor(method: string, domain: string) {
    const reason = method.endsWith('.disable')
      ? 'it would stop the events the subscription receives.'
      : 'the domain is already enabled, with parameters this call would ' +
        'change. Send it without parameters (it then succeeds without ' +
        'sending anything).';
    super(
      `CDP method "${method}" is refused while an event subscription holds the ` +
        `${domain} domain on this target: ${reason} Use --fresh to send it on ` +
        'a one-shot session.',
    );
    this.name = 'CdpDomainInUseError';
  }
}

/**
 * Error of a CDP step that did not finish in time.
 */
class CdpTimeoutError extends Error {
  /**
   * @param message - What timed out.
   */
  constructor(message: string) {
    super(message);
    this.name = 'CdpTimeoutError';
  }
}

/**
 * Serializes CDP parameters with sorted object keys, so equal parameters
 * compare equal whatever their key order.
 *
 * @param value - The parameters.
 * @returns A stable JSON text.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Tells whether two sets of `<Domain>.enable` parameters are the same.
 *
 * @param left - The first parameters.
 * @param right - The second parameters.
 * @returns True when they are equal.
 */
function sameParams(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return stableJson(left) === stableJson(right);
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

/**
 * A cached session that also emits the CDP events of its target, by event
 * name: a Playwright `CDPSession` for a page, or a
 * {@link TunneledCdpSession}.
 */
type EventCdpSession = CdpEventSession;

type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type TunnelOptions = {
  /** Names the target in the closed-session error. */
  label: string;
  /**
   * The browser-level session, which reports `Target.targetDestroyed` with
   * target discovery on. The session closes when its target is destroyed.
   */
  browserSession?: EventCdpSession;
};

/**
 * A CDP session on a target that Playwright does not open sessions on: the
 * service worker, the offscreen document, and its out-of-process iframes.
 *
 * The target is attached from a parent session (the browser-level session,
 * or the offscreen document session for an iframe it auto-attached) without
 * flattening, because Playwright cannot send on a flattened session it did
 * not create, and commands are tunneled through `Target.sendMessageToTarget`.
 * Chrome still supports that deprecated pair. Tunneled messages without an
 * `id` are CDP events; they are emitted by name, like a Playwright
 * `CDPSession` does.
 */
class TunneledCdpSession implements EventCdpSession {
  readonly #parent: EventCdpSession;

  readonly #browserSession: EventCdpSession | undefined;

  readonly #sessionId: string;

  readonly #targetId: string;

  readonly #label: string;

  readonly #onClose: () => void;

  readonly #pending = new Map<number, PendingCommand>();

  readonly #eventListeners = new Map<string, Set<CdpEventListener>>();

  #nextId = 1;

  #closed = false;

  /**
   * @param parent - The session the target was attached from.
   * @param sessionId - The attached session ID.
   * @param targetId - The attached target ID.
   * @param onClose - Called once when the attached target goes away.
   * @param options - The target label and the browser-level session.
   */
  constructor(
    parent: EventCdpSession,
    sessionId: string,
    targetId: string,
    onClose: () => void,
    options: TunnelOptions,
  ) {
    this.#parent = parent;
    this.#browserSession = options.browserSession;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#label = options.label;
    this.#onClose = onClose;
    parent.on('Target.receivedMessageFromTarget', this.#onMessage);
    parent.on('Target.detachedFromTarget', this.#onDetached);
    this.#browserSession?.on('Target.targetDestroyed', this.#onTargetDestroyed);
  }

  /**
   * Sends one command to the attached target.
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
      await this.#parent.send('Target.sendMessageToTarget', {
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
   * Listens for a CDP event of the attached target.
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
    await this.#parent
      .send('Target.detachFromTarget', { sessionId: this.#sessionId })
      .catch(() => undefined);
  }

  /**
   * Handles a message tunneled from the attached target.
   *
   * @param event - The `Target.receivedMessageFromTarget` payload: the
   * `sessionId` that sent it and the JSON-encoded CDP `message`.
   */
  readonly #onMessage = (event: Record<string, unknown> | undefined): void => {
    if (
      event?.sessionId !== this.#sessionId ||
      typeof event.message !== 'string'
    ) {
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
   * Marks the session closed when the target detaches (it stopped, or the
   * iframe was removed).
   *
   * @param event - The `Target.detachedFromTarget` payload, with the
   * `sessionId` that detached.
   */
  readonly #onDetached = (event: Record<string, unknown> | undefined): void => {
    if (event?.sessionId === this.#sessionId) {
      this.#markClosed();
    }
  };

  /**
   * Marks the session closed when its target is destroyed. Requires
   * `Target.setDiscoverTargets`.
   *
   * @param event - The `Target.targetDestroyed` payload, with the destroyed
   * `targetId`.
   */
  readonly #onTargetDestroyed = (
    event: Record<string, unknown> | undefined,
  ): void => {
    if (event?.targetId === this.#targetId) {
      this.#markClosed();
    }
  };

  /**
   * Fails every pending command and stops listening for target messages.
   *
   * @returns False when the session was already closed.
   */
  #markClosed(): boolean {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    this.#parent.off('Target.receivedMessageFromTarget', this.#onMessage);
    this.#parent.off('Target.detachedFromTarget', this.#onDetached);
    this.#browserSession?.off(
      'Target.targetDestroyed',
      this.#onTargetDestroyed,
    );
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
    return new Error(`Session closed. The ${this.#label} target is gone.`);
  }
}

type CdpEntryBase = {
  event: CdpTargetLifecycleEvent;
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

/** The offscreen document, or an out-of-process iframe it auto-attached. */
type ChildEntry = CdpEntryBase & {
  kind: CdpChildTargetKind;
  /** The CDP target ID; a recreated offscreen document has a new one. */
  targetId: string;
  /** The target URL. Empty until the target commits its first navigation. */
  url: string;
  /** For an iframe, the offscreen document target it was attached through. */
  parentTargetId?: string;
};

type CdpEntry = PageEntry | ServiceWorkerEntry | ChildEntry;

/**
 * Tells whether an entry is the offscreen document or one of its iframes.
 *
 * @param entry - The target entry.
 * @returns True for an offscreen document or iframe entry.
 */
function isChildEntry(entry: CdpEntry): entry is ChildEntry {
  return 'kind' in entry;
}

/** A live Extension target found in the browser target list. */
type ExtensionTarget = {
  extensionId: string;
  targetId: string;
  url: string;
};

type ServiceWorkerTarget = ExtensionTarget;

/** One active {@link CdpManager.watchSessions} call. */
type SessionWatch = {
  options: CdpWatchSessionsOptions;
  kinds: ReadonlySet<CdpChildTargetKind>;
  /** The sessions handed to `onAttach`. */
  sessions: Set<EventCdpSession>;
  active: boolean;
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
  domains: Map<string, HeldDomain>;
};

/** A domain that subscribers hold enabled on one session. */
type HeldDomain = {
  /** Subscribers holding it. */
  count: number;
  /** The bounded `<Domain>.enable`, settled with its CDP result. */
  enabled: Promise<unknown>;
  /** The parameters of that enable (the first subscriber's). */
  params: Record<string, unknown>;
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

/** The URL of the MV3 offscreen document, capturing the Extension ID. */
const OFFSCREEN_URL =
  /^chrome-extension:\/\/([a-z]{32})\/offscreen\.html(?:[?#]|$)/u;

/**
 * Target types an offscreen document is never reported as. A tab that
 * loads `offscreen.html` is a page, which Playwright owns.
 */
const NON_OFFSCREEN_TYPES = new Set([
  'page',
  'tab',
  'iframe',
  'service_worker',
  'shared_worker',
  'worker',
  'browser',
]);

/**
 * Reads the Extension offscreen document target from a target info. Chrome
 * reports it as a `background_page`, or briefly as `other` with an empty URL
 * while it starts; the URL is what identifies it.
 *
 * @param info - The target info.
 * @returns The target, or undefined for another kind of target.
 */
function toOffscreenTarget(info: TargetInfo): ExtensionTarget | undefined {
  if (NON_OFFSCREEN_TYPES.has(info.type)) {
    return undefined;
  }
  const extensionId = OFFSCREEN_URL.exec(info.url)?.[1];
  return extensionId === undefined
    ? undefined
    : { extensionId, targetId: info.targetId, url: info.url };
}

/** Message of the error for an offscreen document that is gone. */
const OFFSCREEN_GONE_MESSAGE =
  'Session closed. The offscreen document target is gone.';

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
 * Waits for a promise to settle, at most for a time.
 *
 * @param promise - The promise. It must not reject.
 * @param timeoutMs - The longest wait.
 */
async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Names a target in an error message. A page is named by its URL without
 * the query and the fragment, which can hold tokens.
 *
 * @param entry - The target entry.
 * @returns The target name.
 */
function describeEntry(entry: CdpEntry): string {
  if (isChildEntry(entry)) {
    return entry.kind === 'offscreen'
      ? `the Extension offscreen document (target ${entry.targetId})`
      : `an offscreen document iframe (target ${entry.targetId})`;
  }
  if (!('page' in entry)) {
    return `the Extension service worker (target ${entry.targetId})`;
  }
  return `page ${entry.page.url().split(/[?#]/u)[0]}`;
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
 * Opens and caches one session per target (a page, the extension service
 * worker, the offscreen document or one of its iframes), shared by every
 * caller of the same target. Concurrent callers
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

  readonly #offscreenEntries = new Map<string, ChildEntry>();

  readonly #iframeEntries = new Map<string, ChildEntry>();

  readonly #watches = new Set<SessionWatch>();

  /** Auto-attached iframes whose subscribers and watchers are being added. */
  readonly #childAttaches = new Set<Promise<void>>();

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

  /** The in-flight `Target.getTargets`, see {@link #targetInfos}. */
  #targetList: Promise<TargetInfo[]> | undefined;

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
   * While a subscription holds a domain on the target (see
   * {@link subscribe}), a `<Domain>.enable` with no parameters, or with the
   * parameters the subscription enabled it with, sends nothing: the domain
   * is already enabled, and the call returns the result of the
   * subscription's enable. A `<Domain>.enable` with other parameters and a
   * `<Domain>.disable` are refused with {@link CdpDomainInUseError}: they
   * would change or stop the subscription's events. `fresh` commands are
   * never refused or skipped, because they run on a session of their own.
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

    const held = this.#heldDomainEnable(acquired.session, method, params);
    try {
      return await this.#race(
        held ?? acquired.session.send(method, params),
        `CDP call "${method}"`,
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
   * Checks a `<Domain>.enable` or `<Domain>.disable` against the domains
   * that subscriptions hold on the session.
   *
   * @param session - The session the command would run on.
   * @param method - The CDP method.
   * @param params - The CDP method parameters.
   * @returns The subscription's enable, when the command is a held
   * `<Domain>.enable` with no or the same parameters (nothing is sent);
   * undefined when the command must be sent.
   * @throws {CdpDomainInUseError} For a held `<Domain>.disable`, or a held
   * `<Domain>.enable` with other parameters.
   */
  #heldDomainEnable(
    session: EventCdpSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> | undefined {
    const match = /^(?<domain>[^.]+)\.(?<action>enable|disable)$/u.exec(method);
    const { domain, action } = match?.groups ?? {};
    if (domain === undefined) {
      return undefined;
    }
    const held = this.#sessionStates.get(session)?.domains.get(domain);
    if (held === undefined || held.count === 0) {
      return undefined;
    }
    if (
      action === 'enable' &&
      (Object.keys(params).length === 0 || sameParams(params, held.params))
    ) {
      return held.enabled;
    }
    throw new CdpDomainInUseError(method, domain);
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
      `CDP call "${method}"`,
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
    } else if (target.kind === 'offscreen') {
      session = this.#offscreenEntries.get(target.targetId)?.session;
    } else if (target.kind === 'iframe') {
      session = this.#iframeEntries.get(target.targetId)?.session;
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
   * Delivers CDP events from every page, the Extension service worker, the
   * MV3 offscreen document and its out-of-process iframes (the snaps
   * iframes).
   *
   * Attaches at once to every open page, the running service worker and the
   * offscreen document, then to each new page (tab, popup), each new or
   * restarted worker, each recreated offscreen document and each new snaps
   * iframe as it appears. On each target it enables the domains of `events` once and
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
   * Out-of-process iframes of pages are not attached.
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
      this.#attachOffscreenForSubscribers([subscription], []),
    ]);

    return {
      unsubscribe: async (): Promise<void> => this.#unsubscribe(subscription),
    };
  }

  /**
   * Hands every session of the given target kinds to a watcher: the MV3
   * offscreen document and its out-of-process iframes (the snaps iframes),
   * which Playwright does not track. Attaches to the ones live now, then to
   * each recreated offscreen document and each new iframe.
   *
   * A new iframe is paused until every watcher's `onAttach` settles (or
   * {@link CDP_ATTACH_STEP_TIMEOUT_MS} passes), so a command the watcher
   * sends there, such as `Fetch.enable`, applies before the iframe's first
   * request. The sessions are shared with subscribers: a watcher must not
   * detach them, and must undo what it enabled when it stops.
   *
   * @param options - The target kinds and callbacks.
   * @returns The watch, once the targets live now were handed over.
   */
  async watchSessions(
    options: CdpWatchSessionsOptions,
  ): Promise<CdpSessionWatch> {
    this.#assertLive();
    const watch: SessionWatch = {
      options,
      kinds: new Set(options.kinds),
      sessions: new Set(),
      active: true,
    };
    this.#watches.add(watch);
    await this.#attachOffscreenForSubscribers([], [watch]);
    await settleWithin(
      Promise.all(this.#childAttaches).then(() => undefined),
      CDP_ATTACH_STEP_TIMEOUT_MS,
    );
    return {
      unwatch: async (): Promise<void> => this.#unwatch(watch),
    };
  }

  /**
   * Stops a watch.
   *
   * @param watch - The watch to stop.
   */
  async #unwatch(watch: SessionWatch): Promise<void> {
    if (!watch.active) {
      return;
    }
    watch.active = false;
    watch.sessions.clear();
    this.#watches.delete(watch);
    if (!this.#listening()) {
      this.#unwatchTargets();
    }
  }

  /**
   * @returns Whether a subscription or a watch needs new targets.
   */
  #listening(): boolean {
    return this.#subscriptions.size > 0 || this.#watches.size > 0;
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
    for (const watch of this.#watches) {
      watch.active = false;
      watch.sessions.clear();
    }
    this.#watches.clear();
    this.#unwatchTargets();
    const entries = [...this.#entries];
    const browserSession = this.#browserSession;
    this.#browserSession = undefined;
    this.#entries.clear();
    this.#workerEntries.clear();
    this.#offscreenEntries.clear();
    this.#iframeEntries.clear();
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
   * a worker that restarted after MV3 stopped it, and to a new offscreen
   * document.
   *
   * @param event - The `Target.targetCreated` payload.
   * @param event.targetInfo - The new target.
   */
  readonly #onTargetCreated = (event: { targetInfo: TargetInfo }): void => {
    this.#onTargetInfo(event.targetInfo, true);
  };

  /**
   * Attaches to an offscreen document once it has its URL (it starts as an
   * `other` target with an empty URL), and keeps child target URLs current.
   *
   * @param event - The `Target.targetInfoChanged` payload.
   * @param event.targetInfo - The changed target.
   */
  readonly #onTargetInfoChanged = (event: { targetInfo: TargetInfo }): void => {
    this.#onTargetInfo(event.targetInfo, false);
  };

  /**
   * Handles a new or changed browser target.
   *
   * @param info - The target info.
   * @param created - Whether the target is new.
   */
  #onTargetInfo(info: TargetInfo, created: boolean): void {
    const child =
      this.#iframeEntries.get(info.targetId) ??
      this.#offscreenEntries.get(info.targetId);
    if (child) {
      if (info.url !== '') {
        child.url = info.url;
      }
      return;
    }
    const knownExtensionId = this.#extensionId();
    const offscreen = toOffscreenTarget(info);
    if (offscreen) {
      if (
        knownExtensionId !== undefined &&
        offscreen.extensionId !== knownExtensionId
      ) {
        return;
      }
      const subscriptions = [...this.#subscriptions];
      const watches = [...this.#watches];
      this.#attachOffscreenTarget(offscreen, subscriptions, watches).catch(
        (error: unknown) => {
          this.#reportAttachError(subscriptions, error, false);
          this.#reportWatches(watches, error);
        },
      );
      return;
    }
    const target = created ? toServiceWorkerTarget(info) : undefined;
    if (
      target === undefined ||
      this.#subscriptions.size === 0 ||
      (knownExtensionId !== undefined &&
        target.extensionId !== knownExtensionId)
    ) {
      return;
    }
    const subscriptions = [...this.#subscriptions];
    this.#attachWorkerTarget(target, subscriptions).catch((error: unknown) =>
      this.#reportAttachError(subscriptions, error, false),
    );
  }

  /**
   * Starts watching the browser session for new and changed targets, once
   * per browser session.
   */
  async #watchTargets(): Promise<void> {
    const browserSession = await this.#getBrowserSession();
    if (
      this.#disposed ||
      !this.#listening() ||
      this.#watchedBrowserSession === browserSession
    ) {
      return;
    }
    this.#unwatchTargets();
    browserSession.on('Target.targetCreated', this.#onTargetCreated);
    browserSession.on('Target.targetInfoChanged', this.#onTargetInfoChanged);
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
    this.#watchedBrowserSession?.off(
      'Target.targetInfoChanged',
      this.#onTargetInfoChanged,
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
      const entry = this.#pageEntry(page);
      const session = await this.#openForSubscribers(entry, async () =>
        this.#openPageSession(page),
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
      const listed = await this.#race(
        (async (): Promise<ServiceWorkerTarget[] | undefined> => {
          await this.#watchTargets();
          return this.#disposed ? undefined : this.#serviceWorkerTargets();
        })(),
        'Listing the Extension service worker targets',
        { timeoutMs: CDP_ATTACH_STEP_TIMEOUT_MS },
      );
      if (listed === undefined || this.#disposed) {
        return;
      }
      const knownExtensionId = this.#extensionId();
      const targets = (listed as ServiceWorkerTarget[]).filter(
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
    const session = await this.#openForSubscribers(entry, async () =>
      this.#openWorkerSession(entry.targetId, () => this.#drop(entry)),
    );
    await Promise.all(
      subscriptions.map(async (subscription) =>
        this.#addToSession(subscription, entry, session),
      ),
    );
  }

  /**
   * Watches for new targets and attaches subscribers and watchers to the
   * live offscreen document, if any, and to the iframes it already
   * auto-attached. A missing offscreen document is not an error: it is
   * attached when its target appears. Failures go to `onError`.
   *
   * @param subscriptions - The subscribers to attach.
   * @param watches - The watchers to hand the sessions to.
   */
  async #attachOffscreenForSubscribers(
    subscriptions: Subscription[],
    watches: SessionWatch[],
  ): Promise<void> {
    try {
      const listed = await this.#race(
        (async (): Promise<ExtensionTarget[] | undefined> => {
          await this.#watchTargets();
          return this.#disposed ? undefined : this.#offscreenTargets();
        })(),
        'Listing the Extension offscreen document targets',
        { timeoutMs: CDP_ATTACH_STEP_TIMEOUT_MS },
      );
      if (listed === undefined || this.#disposed) {
        return;
      }
      const targets = listed as ExtensionTarget[];
      // The list can briefly hold the old and the recreated document. Keep
      // the attached one; a newer one is attached by its target events.
      const target =
        targets.find((candidate) =>
          this.#offscreenEntries.has(candidate.targetId),
        ) ?? targets[0];
      if (target !== undefined) {
        await this.#attachOffscreenTarget(target, subscriptions, watches);
      }
      await Promise.all(
        [...this.#iframeEntries.values()].map(async (entry) =>
          this.#addChildTo(entry, subscriptions, watches),
        ),
      );
    } catch (error) {
      this.#reportAttachError(subscriptions, error, false);
      this.#reportWatches(watches, error);
    }
  }

  /**
   * Lists the live offscreen document targets of the Extension.
   *
   * @returns The offscreen document targets.
   */
  async #offscreenTargets(): Promise<ExtensionTarget[]> {
    const targetInfos = await this.#targetInfos();
    const knownExtensionId = this.#extensionId();
    return targetInfos.flatMap((info) => {
      const target = toOffscreenTarget(info);
      return target !== undefined &&
        (knownExtensionId === undefined ||
          target.extensionId === knownExtensionId)
        ? [target]
        : [];
    });
  }

  /**
   * Opens (or reuses) the session of the live offscreen document and adds
   * subscribers and watchers to it. Opening it turns on auto-attach for its
   * iframes, see {@link #onChildAttached}.
   *
   * @param target - The live offscreen document target.
   * @param subscriptions - The subscribers to attach.
   * @param watches - The watchers to hand the session to.
   */
  async #attachOffscreenTarget(
    target: ExtensionTarget,
    subscriptions: Subscription[],
    watches: SessionWatch[],
  ): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const entry = this.#offscreenEntryFor(target);
    let session: EventCdpSession;
    try {
      session = await this.#openForSubscribers(entry, async () =>
        this.#openOffscreenSession(entry),
      );
    } catch (error) {
      if (isClosedSessionError(error)) {
        this.#drop(entry);
      }
      throw error;
    }
    await this.#addChildTo(entry, subscriptions, watches, session);
  }

  /**
   * Adds subscribers and watchers to an offscreen document or iframe
   * session. Never rejects.
   *
   * @param entry - The child target entry.
   * @param subscriptions - The subscribers to attach.
   * @param watches - The watchers to hand the session to.
   * @param session - The entry's session; defaults to the attached one.
   */
  async #addChildTo(
    entry: ChildEntry,
    subscriptions: Subscription[],
    watches: SessionWatch[],
    session = entry.session,
  ): Promise<void> {
    if (session === undefined) {
      return;
    }
    await Promise.all([
      ...subscriptions.map(async (subscription) =>
        this.#addToSession(subscription, entry, session),
      ),
      ...watches.map(async (watch) => this.#addToWatch(watch, entry, session)),
    ]);
  }

  /**
   * Returns the entry of a live offscreen document. A new target ID means
   * the document was recreated (the service worker restarted): the old
   * entry is dropped with its iframes.
   *
   * @param target - The live offscreen document target.
   * @returns The entry.
   */
  #offscreenEntryFor(target: ExtensionTarget): ChildEntry {
    const cached = this.#offscreenEntries.get(target.targetId);
    if (cached) {
      cached.url = target.url;
      return cached;
    }
    for (const previous of [...this.#offscreenEntries.values()]) {
      this.#drop(previous);
    }
    const entry: ChildEntry = {
      kind: 'offscreen',
      targetId: target.targetId,
      url: target.url,
      event: { kind: 'offscreen', targetId: target.targetId },
    };
    this.#offscreenEntries.set(target.targetId, entry);
    this.#entries.add(entry);
    return entry;
  }

  /**
   * Opens a session on the offscreen document and turns on auto-attach for
   * its iframes only (without the filter Chrome also attaches the service
   * worker). New iframes wait for the debugger, so subscribers and watchers
   * are added before their first request.
   *
   * @param entry - The offscreen document entry.
   * @returns The session.
   */
  async #openOffscreenSession(entry: ChildEntry): Promise<EventCdpSession> {
    const browserSession = await this.#getBrowserSession();
    let sessionId: string;
    try {
      ({ sessionId } = (await browserSession.send('Target.attachToTarget', {
        targetId: entry.targetId,
        flatten: false,
      })) as { sessionId: string });
    } catch (error) {
      if (isClosedSessionError(error) || isMissingTargetError(error)) {
        throw new Error(OFFSCREEN_GONE_MESSAGE);
      }
      throw error;
    }
    const transport = browserSession as unknown as EventCdpSession;
    const session = new TunneledCdpSession(
      transport,
      sessionId,
      entry.targetId,
      () => this.#drop(entry),
      { label: 'offscreen document', browserSession: transport },
    );
    session.on('Target.attachedToTarget', (params) =>
      this.#onChildAttached(entry, session, params),
    );
    try {
      await session.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
        filter: [{ type: 'iframe', exclude: false }],
      });
    } catch (error) {
      await session.detach();
      throw error;
    }
    return session;
  }

  /**
   * Takes an iframe the offscreen document auto-attached: adds subscribers
   * and watchers to it, then lets it run. Anything else (an iframe already
   * attached, or one that arrives after the offscreen document or the
   * manager went away) is resumed and detached.
   *
   * @param parent - The offscreen document entry.
   * @param parentSession - The offscreen document session.
   * @param params - The `Target.attachedToTarget` payload.
   */
  #onChildAttached(
    parent: ChildEntry,
    parentSession: EventCdpSession,
    params: Record<string, unknown> | undefined,
  ): void {
    const sessionId = params?.sessionId;
    const info = params?.targetInfo as TargetInfo | undefined;
    const waiting = params?.waitingForDebugger === true;
    if (typeof sessionId !== 'string' || info === undefined) {
      return;
    }
    if (
      info.type !== 'iframe' ||
      this.#disposed ||
      parent.dropped === true ||
      this.#iframeEntries.has(info.targetId)
    ) {
      this.#releaseChild(parentSession, sessionId, waiting).catch(
        () => undefined,
      );
      return;
    }
    const entry: ChildEntry = {
      kind: 'iframe',
      targetId: info.targetId,
      url: info.url,
      parentTargetId: parent.targetId,
      event: { kind: 'iframe', targetId: info.targetId },
    };
    const session = new TunneledCdpSession(
      parentSession,
      sessionId,
      info.targetId,
      () => this.#drop(entry),
      { label: 'iframe' },
    );
    entry.session = session;
    this.#entries.add(entry);
    this.#iframeEntries.set(info.targetId, entry);
    this.#emit('targetAttached', entry.event);

    const ready = (async (): Promise<void> => {
      try {
        await settleWithin(
          this.#addChildTo(
            entry,
            [...this.#subscriptions],
            [...this.#watches],
            session,
          ),
          CDP_ATTACH_STEP_TIMEOUT_MS,
        );
      } finally {
        if (waiting) {
          await this.#race(
            session.send('Runtime.runIfWaitingForDebugger', {}),
            'Resuming an offscreen document iframe',
            { timeoutMs: CDP_ATTACH_STEP_TIMEOUT_MS },
          ).catch(() => undefined);
        }
      }
    })();
    this.#childAttaches.add(ready);
    ready
      .finally(() => this.#childAttaches.delete(ready))
      .catch(() => undefined);
  }

  /**
   * Resumes and detaches an auto-attached target the manager does not keep.
   *
   * @param parentSession - The session that auto-attached it.
   * @param sessionId - The auto-attached session ID.
   * @param waiting - Whether the target waits for the debugger.
   */
  async #releaseChild(
    parentSession: EventCdpSession,
    sessionId: string,
    waiting: boolean,
  ): Promise<void> {
    if (waiting) {
      await parentSession
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({
            id: 1,
            method: 'Runtime.runIfWaitingForDebugger',
            params: {},
          }),
        })
        .catch(() => undefined);
    }
    await parentSession.send('Target.detachFromTarget', { sessionId });
  }

  /**
   * Hands a child target session to a watcher, once. Never rejects: a
   * failing `onAttach` goes to the watcher's `onError`.
   *
   * @param watch - The watcher.
   * @param entry - The child target entry.
   * @param session - The entry's session.
   */
  async #addToWatch(
    watch: SessionWatch,
    entry: ChildEntry,
    session: EventCdpSession,
  ): Promise<void> {
    if (
      !watch.active ||
      !watch.kinds.has(entry.kind) ||
      watch.sessions.has(session)
    ) {
      return;
    }
    watch.sessions.add(session);
    try {
      await this.#bound(
        (async (): Promise<void> =>
          watch.options.onAttach({
            target: () => this.#childTarget(entry),
            session,
          }))(),
        'Preparing a session watcher',
        entry,
      );
    } catch (error) {
      this.#reportWatches([watch], error);
    }
  }

  /**
   * Reports a watcher failure. A target that went away is not an error.
   *
   * @param watches - The watchers.
   * @param error - The error.
   */
  #reportWatches(watches: SessionWatch[], error: unknown): void {
    if (isClosedSessionError(error)) {
      return;
    }
    for (const watch of watches) {
      if (!watch.active) {
        continue;
      }
      try {
        if (watch.options.onError) {
          watch.options.onError(toError(error));
        } else {
          debugWarn('cdp-manager.watchSessions', error);
        }
      } catch {
        // A failing error callback must not break the others.
      }
    }
  }

  /**
   * Describes an offscreen document or iframe target.
   *
   * @param entry - The child target entry.
   * @returns The target now.
   */
  #childTarget(entry: ChildEntry): CdpEventTarget {
    return { kind: entry.kind, targetId: entry.targetId, url: entry.url };
  }

  /**
   * Opens (or reuses) the session of a target for subscribers, bounded by
   * {@link CDP_ATTACH_STEP_TIMEOUT_MS}. On a timeout the entry is dropped: a
   * session that opens later is detached, and a later attach trigger opens
   * a new one.
   *
   * @param entry - The target entry.
   * @param open - Opens a new session for the entry's target.
   * @returns The session.
   */
  async #openForSubscribers(
    entry: CdpEntry,
    open: () => Promise<EventCdpSession>,
  ): Promise<EventCdpSession> {
    try {
      return await this.#bound(
        this.#openEntry(entry, open),
        'Opening a CDP session',
        entry,
      );
    } catch (error) {
      if (error instanceof CdpTimeoutError) {
        this.#drop(entry);
      }
      throw error;
    }
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
   * Each step (the target info, each `<Domain>.enable`) is bounded by
   * {@link CDP_ATTACH_STEP_TIMEOUT_MS}. A step that times out is reported,
   * and the subscriber is removed from this session again (its listeners and
   * domains are released) so a later attach trigger can retry it; the
   * subscription stays live on its other targets. Another enable failure is
   * a definite answer: it is reported, and the subscriber keeps its other
   * domains on the session.
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
        this.#enableDomain(subscription, entry, session, state, record, domain),
      ),
    );
    const timedOut: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }
      if (result.reason instanceof CdpTimeoutError) {
        timedOut.push(subscription.domains[index]);
      }
      this.#reportAttachError(
        [subscription],
        result.reason,
        isTargetGone(entry),
        entry,
      );
    });
    if (timedOut.length > 0) {
      if (subscription.records.get(session) === record) {
        subscription.records.delete(session);
        // Not awaited: the target is slow. Never rejects.
        // eslint-disable-next-line no-void
        void this.#release(subscription, session, record, timedOut);
      }
      return;
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
   * sends `<Domain>.enable`, bounded by {@link CDP_ATTACH_STEP_TIMEOUT_MS};
   * later ones share it. A later subscriber that asks for other parameters
   * gets the first ones, and an error through `onError`.
   *
   * @param subscription - The subscriber.
   * @param entry - The target entry of the session.
   * @param session - The session.
   * @param state - The session's shared subscription state.
   * @param record - Where to note the enabled domain.
   * @param domain - The CDP domain.
   */
  async #enableDomain(
    subscription: Subscription,
    entry: CdpEntry,
    session: EventCdpSession,
    state: SessionSubscriptionState,
    record: SubscriptionRecord,
    domain: string,
  ): Promise<void> {
    const params = subscription.options.enable?.[domain] ?? {};
    let held = state.domains.get(domain);
    if (held) {
      if (Object.keys(params).length > 0 && !sameParams(params, held.params)) {
        this.#report(
          [subscription],
          new Error(
            `${domain}.enable parameters ${stableJson(params)} were not ` +
              `applied on ${describeEntry(entry)}: another subscription ` +
              `enabled ${domain} there with ${stableJson(held.params)}, ` +
              'which stay in effect.',
          ),
        );
      }
    } else {
      held = {
        count: 0,
        enabled: this.#bound(
          session.send(`${domain}.enable`, params),
          `${domain}.enable`,
          entry,
        ),
        params,
      };
      state.domains.set(domain, held);
    }
    held.count += 1;
    record.domains.push(domain);
    try {
      await held.enabled;
    } catch (error) {
      const index = record.domains.indexOf(domain);
      // The record may have been released meanwhile (unsubscribe).
      if (index !== -1) {
        record.domains.splice(index, 1);
        held.count -= 1;
        if (held.count === 0 && state.domains.get(domain) === held) {
          // Let a later attach try again.
          state.domains.delete(domain);
        }
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
    if (isChildEntry(entry)) {
      return () => this.#childTarget(entry);
    }
    if (!('page' in entry)) {
      const target: CdpEventTarget = {
        kind: 'sw',
        targetId: entry.targetId,
        url: entry.url,
      };
      return () => target;
    }
    if (state.targetId === undefined) {
      const lookup = this.#bound(
        session.send('Target.getTargetInfo', {}),
        'Target.getTargetInfo',
        entry,
      ).then(
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
   * other subscriber needs. Each disable is bounded by
   * {@link CDP_ATTACH_STEP_TIMEOUT_MS} and its failure is ignored.
   *
   * @param subscription - The subscriber.
   * @param session - The session.
   * @param record - What the subscriber added to the session.
   * @param timedOut - Domains whose enable timed out: the enable may still
   * land, so each one no subscriber holds is disabled too.
   */
  async #release(
    subscription: Subscription,
    session: EventCdpSession,
    record: SubscriptionRecord,
    timedOut: readonly string[] = [],
  ): Promise<void> {
    const state = this.#sessionStates.get(session);
    const { methods, domains } = record;
    record.methods = [];
    record.domains = [];
    if (!state) {
      // The session was detached while attaching; its listeners and domains
      // went with it.
      return;
    }
    for (const method of methods) {
      const handler = state.methods.get(method);
      handler?.subscriptions.delete(subscription);
      if (handler?.subscriptions.size === 0) {
        session.off(method, handler.listener);
        state.methods.delete(method);
      }
    }
    const disable = new Set<string>(
      timedOut.filter((domain) => !state.domains.has(domain)),
    );
    for (const domain of domains) {
      const held = state.domains.get(domain);
      if (held) {
        held.count -= 1;
        if (held.count === 0) {
          state.domains.delete(domain);
          disable.add(domain);
        }
      }
    }
    await Promise.all(
      [...disable].map(async (domain) =>
        this.#race(
          session.send(`${domain}.disable`, {}),
          `CDP call "${domain}.disable"`,
          { timeoutMs: CDP_ATTACH_STEP_TIMEOUT_MS },
        ).catch(() => undefined),
      ),
    );
  }

  /**
   * Ends a subscription. Idempotent. Waits for an attach in progress at
   * most {@link CDP_ATTACH_STEP_TIMEOUT_MS} per target before releasing it.
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
    }
    if (!this.#listening()) {
      this.#unwatchTargets();
    }
    const records = [...subscription.records];
    await Promise.all(
      records.map(async ([session, record]) => {
        await settleWithin(record.ready, CDP_ATTACH_STEP_TIMEOUT_MS);
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
   * Reports an error to subscribers: to their `onError`, or to the debug
   * log for a subscriber without one. Never throws.
   *
   * @param subscriptions - The subscribers.
   * @param error - The error.
   */
  #report(subscriptions: Subscription[], error: unknown): void {
    for (const subscription of subscriptions) {
      if (!subscription.active) {
        continue;
      }
      const { onError } = subscription.options;
      if (onError === undefined) {
        debugWarn('cdp-manager.subscribe', error);
        continue;
      }
      try {
        onError(toError(error));
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
    return (await this.#targetInfos()).flatMap((info) => {
      const target = toServiceWorkerTarget(info);
      return target === undefined ? [] : [target];
    });
  }

  /**
   * Lists the browser targets. Concurrent callers (the worker and the
   * offscreen document attach of one subscription) share one
   * `Target.getTargets`.
   *
   * @returns The browser target infos.
   */
  async #targetInfos(): Promise<TargetInfo[]> {
    this.#targetList ??= (async (): Promise<TargetInfo[]> => {
      const browserSession = await this.#getBrowserSession();
      const { targetInfos } = await browserSession.send('Target.getTargets');
      return targetInfos as TargetInfo[];
    })().finally(() => {
      this.#targetList = undefined;
    });
    return this.#targetList;
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
    const transport = browserSession as unknown as EventCdpSession;
    return new TunneledCdpSession(transport, sessionId, targetId, onClose, {
      label: 'service worker',
      browserSession: transport,
    });
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
      return await this.#race(
        session.send(method, params),
        `CDP call "${method}"`,
        options,
      );
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
   * Bounds one step of attaching a subscription to a target (or of ending
   * it) by {@link CDP_ATTACH_STEP_TIMEOUT_MS}.
   *
   * @param operation - The step.
   * @param what - What the step does, used in the timeout error.
   * @param entry - The target, named in the timeout error.
   * @returns The step result.
   */
  async #bound<Result>(
    operation: Promise<Result>,
    what: string,
    entry: CdpEntry,
  ): Promise<Result> {
    return this.#race(operation, `${what} on ${describeEntry(entry)}`, {
      timeoutMs: CDP_ATTACH_STEP_TIMEOUT_MS,
    }) as Promise<Result>;
  }

  /**
   * Races an operation against the timeout and the abort signal.
   *
   * @param operation - The CDP send.
   * @param label - What the operation does, used in the timeout error, for
   * example `CDP call "Runtime.evaluate"`.
   * @param options - Timeout and abort signal.
   * @returns The operation result.
   */
  async #race(
    operation: Promise<unknown>,
    label: string,
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
                new CdpTimeoutError(`${label} timed out after ${timeoutMs}ms`),
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
    if (isChildEntry(entry)) {
      for (const watch of this.#watches) {
        if (watch.sessions.delete(session)) {
          try {
            watch.options.onDetach?.(this.#childTarget(entry));
          } catch (error) {
            this.#reportWatches([watch], error);
          }
        }
      }
    }
    this.#emit('targetDetached', entry.event);
    await session.detach().catch(() => undefined);
    // An offscreen document or iframe is attached again by its target
    // events, not here: its session only closes when the target goes away.
    if (
      this.#disposed ||
      this.#subscriptions.size === 0 ||
      isChildEntry(entry)
    ) {
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
    } else if (isChildEntry(entry)) {
      const entries =
        entry.kind === 'offscreen'
          ? this.#offscreenEntries
          : this.#iframeEntries;
      if (entries.get(entry.targetId) === entry) {
        entries.delete(entry.targetId);
      }
      // The iframes go with their offscreen document: their sessions are
      // tunneled through it.
      for (const child of [...this.#iframeEntries.values()]) {
        if (child.parentTargetId === entry.targetId) {
          this.#drop(child);
        }
      }
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
  #emit(event: CdpManagerEvent, payload: CdpTargetLifecycleEvent): void {
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
