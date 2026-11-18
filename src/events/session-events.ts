import type { BrowserContext } from '@playwright/test';

import { ConsoleSource, DEFAULT_CONSOLE_LEVELS } from './console-source.js';
import { EventBuffer } from './event-buffer.js';
import { NetworkSource } from './network-source.js';
import type { CdpManager, CdpSubscription } from '../platform/cdp-manager.js';
import { getCdpManager } from '../platform/cdp-manager.js';
import type { EventConfig, NetworkStats } from '../tools/types/events.js';
import { debugWarn } from '../utils';

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
   * Starts every source, once per CDP manager. Safe to call often: a call
   * while the sources run does nothing. When the context's CDP manager was
   * replaced (disposed and created again), the sources start on the new one.
   * Failures are logged, never thrown: events are best-effort.
   */
  async ensureStarted(): Promise<void> {
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
        debugWarn('session-events.start', result.reason);
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
