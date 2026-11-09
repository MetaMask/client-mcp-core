import type {
  BrowserContext,
  CDPSession,
  Page,
  Worker as PlaywrightWorker,
} from '@playwright/test';

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
  /** The page of a page target, the worker of a service worker target. */
  target: Page | PlaywrightWorker;
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

/** How long to wait for the extension service worker by default. */
export const DEFAULT_SW_ATTACH_TIMEOUT_MS = 30_000;

const EXTENSION_URL = /^chrome-extension:\/\/([a-z]{32})\//u;

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

type WorkerMessage = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
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
 */
class ServiceWorkerCdpSession implements CdpSession {
  readonly #browserSession: CDPSession;

  readonly #sessionId: string;

  readonly #onClose: () => void;

  readonly #pending = new Map<number, PendingCommand>();

  #nextId = 1;

  #closed = false;

  /**
   * @param browserSession - The browser-level CDP session.
   * @param sessionId - The attached service worker session ID.
   * @param onClose - Called once when the attached target goes away.
   */
  constructor(
    browserSession: CDPSession,
    sessionId: string,
    onClose: () => void,
  ) {
    this.#browserSession = browserSession;
    this.#sessionId = sessionId;
    this.#onClose = onClose;
    browserSession.on('Target.receivedMessageFromTarget', this.#onMessage);
    browserSession.on('Target.detachedFromTarget', this.#onDetached);
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
  session?: CdpSession;
  opening?: Promise<CdpSession>;
};

type PageEntry = CdpEntryBase & { page: Page };

type ServiceWorkerEntry = CdpEntryBase & {
  extensionId: string;
  worker: PlaywrightWorker;
};

type CdpEntry = PageEntry | ServiceWorkerEntry;

type ServiceWorkerTarget = {
  extensionId: string;
  worker: PlaywrightWorker;
};

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

  readonly #entries = new Set<CdpEntry>();

  readonly #listeners = new Map<CdpManagerEvent, Set<CdpManagerListener>>();

  #browserSession: Promise<CDPSession> | undefined;

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

    let acquired: { entry: CdpEntry; session: CdpSession };
    try {
      acquired = await this.#acquireSession(target, options);
    } catch (error) {
      if (!isClosedSessionError(error)) {
        throw error;
      }
      // Opening failed and the command was never sent: try once more.
      acquired = await this.#acquireSession(target, options);
    }

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
   * Detaches every cached session and stops listening for service workers.
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#context.off('serviceworker', this.#onServiceWorker);
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
   * Drops the cached session of an extension when a new worker of that
   * extension appears: the old worker is dead and so is its session.
   *
   * @param worker - The service worker reported by the context.
   */
  readonly #onServiceWorker = (worker: PlaywrightWorker): void => {
    const extensionId = extensionIdFromUrl(worker.url());
    if (extensionId === undefined) {
      return;
    }
    const entry = this.#workerEntries.get(extensionId);
    if (entry !== undefined && entry.worker !== worker) {
      this.#drop(entry);
    }
  };

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
  ): Promise<{ entry: CdpEntry; open: () => Promise<CdpSession> }> {
    if (target.kind === 'page') {
      const entry = this.#pageEntry(target.page);
      return {
        entry,
        open: async (): Promise<CdpSession> =>
          this.#openPageSession(target.page),
      };
    }
    const entry = await this.#workerEntry(options);
    return {
      entry,
      open: async (): Promise<CdpSession> =>
        this.#openWorkerSession(entry.worker, () => this.#drop(entry)),
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
  ): Promise<{ entry: CdpEntry; session: CdpSession }> {
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
    return entry;
  }

  /**
   * Returns the cached entry of the extension service worker, waiting for
   * the worker when it is not running yet. A known worker object replaces a
   * cached entry for the same extension (the worker restarted).
   *
   * @param options - Bounded wait for the worker.
   * @returns Its entry.
   */
  async #workerEntry(options: CdpAttachOptions): Promise<ServiceWorkerEntry> {
    const knownExtensionId = this.#extensionId();
    if (knownExtensionId !== undefined) {
      const cached = this.#workerEntries.get(knownExtensionId);
      if (cached) {
        return cached;
      }
    }
    const { extensionId, worker } = await this.#findServiceWorker(
      knownExtensionId,
      options,
    );
    const previous = this.#workerEntries.get(extensionId);
    if (previous) {
      if (previous.worker === worker) {
        return previous;
      }
      this.#drop(previous);
    }
    const entry: ServiceWorkerEntry = {
      extensionId,
      worker,
      event: { kind: 'sw', target: worker },
    };
    this.#workerEntries.set(extensionId, entry);
    this.#entries.add(entry);
    return entry;
  }

  /**
   * Finds the extension service worker, waiting for it to appear when it is
   * not running yet.
   *
   * @param knownExtensionId - The extension ID to filter on, when known.
   * @param options - Bounded wait for the worker.
   * @returns The worker and its extension ID.
   */
  async #findServiceWorker(
    knownExtensionId: string | undefined,
    options: CdpAttachOptions,
  ): Promise<ServiceWorkerTarget> {
    const matches = (
      worker: PlaywrightWorker,
    ): ServiceWorkerTarget | undefined => {
      const extensionId = extensionIdFromUrl(worker.url());
      if (
        extensionId === undefined ||
        (knownExtensionId !== undefined && extensionId !== knownExtensionId)
      ) {
        return undefined;
      }
      return { extensionId, worker };
    };

    const existing = this.#context
      .serviceWorkers()
      .map((worker) => matches(worker))
      .filter((target): target is ServiceWorkerTarget => target !== undefined);
    if (existing.length > 0) {
      return existing[existing.length - 1];
    }

    const { timeoutMs = DEFAULT_SW_ATTACH_TIMEOUT_MS, signal } = options;
    const context = this.#context;
    return new Promise<ServiceWorkerTarget>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for the extension service worker`,
            ),
          ),
        );
      }, timeoutMs);
      /**
       * Stops waiting and runs the settling action.
       *
       * @param action - Resolves or rejects the wait.
       */
      function finish(action: () => void): void {
        clearTimeout(timer);
        context.off('serviceworker', onWorker);
        signal?.removeEventListener('abort', onAbort);
        action();
      }
      /**
       * Settles when the expected extension worker appears.
       *
       * @param worker - The reported service worker.
       */
      function onWorker(worker: PlaywrightWorker): void {
        const target = matches(worker);
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

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      context.on('serviceworker', onWorker);
    });
  }

  /**
   * Opens a CDP session on a page.
   *
   * @param page - The page.
   * @returns Its session.
   */
  async #openPageSession(page: Page): Promise<CdpSession> {
    // A Playwright CDPSession has this send/detach surface.
    return (await this.#context.newCDPSession(page)) as unknown as CdpSession;
  }

  /**
   * Opens a session on the service worker target through the browser-level
   * CDP session, because Playwright cannot open one on a `Worker`.
   *
   * @param worker - The extension service worker.
   * @param onClose - Called once when the attached target goes away.
   * @returns Its session.
   */
  async #openWorkerSession(
    worker: PlaywrightWorker,
    onClose: () => void,
  ): Promise<CdpSession> {
    const browserSession = await this.#getBrowserSession();
    const { targetInfos } = await browserSession.send('Target.getTargets');
    const url = worker.url();
    const target = (
      targetInfos as { type: string; url: string; targetId: string }[]
    ).find((info) => info.type === 'service_worker' && info.url === url);
    if (!target) {
      throw new Error(`No service worker target for ${url}`);
    }
    const { sessionId } = await browserSession.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: false,
    });
    return new ServiceWorkerCdpSession(browserSession, sessionId, onClose);
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
      return browser.newBrowserCDPSession();
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
    open: () => Promise<CdpSession>,
  ): Promise<CdpSession> {
    if (entry.session) {
      return entry.session;
    }
    entry.opening ??= (async (): Promise<CdpSession> => {
      const session = await open();
      if (this.#disposed) {
        await session.detach().catch(() => undefined);
        throw new Error('CDP manager is disposed');
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
    const { worker } = await this.#findServiceWorker(
      this.#extensionId(),
      options,
    );
    return this.#openWorkerSession(worker, () => undefined);
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
    this.#emit('targetDetached', entry.event);
    await session.detach().catch(() => undefined);
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
    if ('page' in entry) {
      this.#pageEntries.delete(entry.page);
    } else {
      this.#workerEntries.delete(entry.extensionId);
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
