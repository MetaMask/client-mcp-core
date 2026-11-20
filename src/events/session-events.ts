import type { BrowserContext } from '@playwright/test';

import { ConsoleSource, DEFAULT_CONSOLE_LEVELS } from './console-source.js';
import { EventBuffer } from './event-buffer.js';
import { NetworkSource } from './network-source.js';
import { redactText, truncateText } from './redact.js';
import type { CdpManager, CdpSubscription } from '../platform/cdp-manager.js';
import { getCdpManager } from '../platform/cdp-manager.js';
import type { EventConfig, NetworkStats } from '../tools/types/events.js';
import { debugWarn, extractErrorMessage } from '../utils';

/**
 * How long a call waits for the sources to start. Each attach step of the
 * CDP manager is bounded already; this caps the wait as a whole, so a call
 * never hangs on a start that is still running. The start keeps going.
 */
export const SESSION_EVENTS_START_WAIT_MS = 5_000;

/** Longest capture error text kept in the buffer summary. */
const MAX_CAPTURE_ERROR_LENGTH = 300;

/**
 * A producer of event records: it listens to CDP events of every page and
 * the Extension service worker and writes records into the session buffer.
 */
export type SessionEventSource = {
  /**
   * Starts listening. Called once per CDP manager of the session.
   *
   * @param manager - The session's CDP manager.
   * @param events - The session's events: its buffer and browser context.
   * @returns The subscription to end when the session stops.
   */
  start(manager: CdpManager, events: SessionEvents): Promise<CdpSubscription>;
};

/**
 * The event buffer and event sources of one browser session.
 */
export class SessionEvents {
  readonly buffer = new EventBuffer();

  readonly context: BrowserContext;

  /** What the sources record. Sources read it for each event. */
  config: EventConfig = {
    consoleLevels: [...DEFAULT_CONSOLE_LEVELS],
    rpcErrors: false,
  };

  /** Counters of the network source. */
  readonly networkStats: NetworkStats = {
    pending: 0,
    ignored: 0,
    rpcErrorsSkipped: 0,
  };

  readonly #sources: SessionEventSource[];

  #manager: CdpManager | undefined;

  #starting: Promise<void> | undefined;

  #subscriptions: CdpSubscription[] = [];

  /**
   * @param context - The browser context of the session.
   * @param sources - The sources that fill the buffer.
   */
  constructor(context: BrowserContext, sources: SessionEventSource[]) {
    this.context = context;
    this.#sources = sources;
  }

  /**
   * Records an error of an event source: it is counted in the buffer
   * summary (`captureErrors`, `lastCaptureError`) and written to the debug
   * log. Sources pass it as the `onError` of their CDP subscription. Never
   * throws.
   *
   * @param error - The error.
   */
  readonly reportError = (error: unknown): void => {
    try {
      debugWarn('session-events.source', error);
      this.buffer.noteCaptureError(
        truncateText(
          redactText(extractErrorMessage(error)),
          MAX_CAPTURE_ERROR_LENGTH,
        ),
      );
    } catch {
      // Error reporting must never break event dispatch.
    }
  };

  /**
   * Starts every source, once per CDP manager. Safe to call often: a call
   * while the sources run does nothing. When the context's CDP manager was
   * replaced (disposed and created again), the sources start on the new one.
   * Failures are recorded (see {@link reportError}), never thrown: events
   * are best-effort.
   *
   * Waits at most {@link SESSION_EVENTS_START_WAIT_MS} for a start in
   * progress, so a caller (`mm launch`, `mm logs`, …) never hangs on a
   * target that does not answer; the start keeps going.
   */
  async ensureStarted(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#start(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_EVENTS_START_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Starts every source once per CDP manager, or returns the start in
   * progress.
   *
   * @returns Settles when the sources started. Never rejects.
   */
  async #start(): Promise<void> {
    const manager = getCdpManager(this.context);
    if (manager === this.#manager) {
      await this.#starting;
      return;
    }
    this.#manager = manager;
    const previous = this.#subscriptions;
    this.#subscriptions = [];
    const starting = (async (): Promise<void> => {
      await Promise.all(
        previous.map(async (subscription) =>
          subscription.unsubscribe().catch(() => undefined),
        ),
      );
      const results = await Promise.allSettled(
        this.#sources.map(async (source) => source.start(manager, this)),
      );
      const started = results.flatMap((result) => {
        if (result.status === 'fulfilled') {
          return [result.value];
        }
        this.reportError(result.reason);
        return [];
      });
      if (this.#manager !== manager) {
        // The CDP manager was replaced while the sources started: these
        // subscriptions belong to the old manager, not to this session.
        await Promise.all(
          started.map(async (subscription) =>
            subscription.unsubscribe().catch(() => undefined),
          ),
        );
        return;
      }
      this.#subscriptions = started;
    })();
    this.#starting = starting;
    await starting;
  }
}

/**
 * Creates the sources of a new session.
 *
 * @returns The sources.
 */
function createSources(): SessionEventSource[] {
  return [new ConsoleSource(), new NetworkSource()];
}

const sessions = new WeakMap<BrowserContext, SessionEvents>();

/**
 * Returns the events of a browser session, creating them (and a new buffer
 * with a new `startedAt`) on first use. A relaunched session has a new
 * browser context, so it gets a new buffer.
 *
 * @param context - The browser context of the session.
 * @returns Its events.
 */
export function getSessionEvents(context: BrowserContext): SessionEvents {
  let events = sessions.get(context);
  if (!events) {
    events = new SessionEvents(context, createSources());
    sessions.set(context, events);
  }
  return events;
}
