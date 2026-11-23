import type { BrowserContext } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEventSource } from './session-events.js';
import {
  getSessionEvents,
  SESSION_EVENTS_START_WAIT_MS,
  SessionEvents,
} from './session-events.js';
import { getCdpManager } from '../platform/cdp-manager.js';

vi.mock('../platform/cdp-manager.js', () => ({
  getCdpManager: vi.fn(),
}));

const getCdpManagerMock = vi.mocked(getCdpManager);

/**
 * Creates a source whose start resolves with a fake subscription.
 *
 * @returns The source and its unsubscribe mock.
 */
function createSource(): {
  source: SessionEventSource & { start: ReturnType<typeof vi.fn> };
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const source = {
    start: vi.fn().mockResolvedValue({ unsubscribe }),
  };
  return { source, unsubscribe };
}

describe('SessionEvents', () => {
  beforeEach(() => {
    getCdpManagerMock.mockReset();
  });

  it('starts every source once per CDP manager', async () => {
    const manager = { id: 1 };
    getCdpManagerMock.mockReturnValue(manager as never);
    const { source } = createSource();
    const events = new SessionEvents({} as BrowserContext, [source]);

    await Promise.all([events.ensureStarted(), events.ensureStarted()]);
    await events.ensureStarted();

    expect(source.start).toHaveBeenCalledTimes(1);
    expect(source.start).toHaveBeenCalledWith(manager, events);
  });

  it('restarts the sources on a new CDP manager, ending the old subscriptions', async () => {
    getCdpManagerMock.mockReturnValueOnce({ id: 1 } as never);
    const { source, unsubscribe } = createSource();
    const events = new SessionEvents({} as BrowserContext, [source]);
    await events.ensureStarted();

    const second = { id: 2 };
    getCdpManagerMock.mockReturnValue(second as never);
    await events.ensureStarted();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(source.start).toHaveBeenCalledTimes(2);
    expect(source.start).toHaveBeenLastCalledWith(second, events);
  });

  it('unsubscribes subscriptions that finish after their manager was replaced', async () => {
    const unsubscribeFirst = vi.fn().mockResolvedValue(undefined);
    const unsubscribeSecond = vi.fn().mockResolvedValue(undefined);
    let resolveFirstStart: (subscription: {
      unsubscribe: () => Promise<void>;
    }) => void = () => undefined;
    const source = {
      start: vi
        .fn()
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              resolveFirstStart = resolve;
            }),
        )
        .mockResolvedValue({ unsubscribe: unsubscribeSecond }),
    };
    const events = new SessionEvents({} as BrowserContext, [source]);

    getCdpManagerMock.mockReturnValue({ id: 1 } as never);
    const firstRun = events.ensureStarted();

    // The manager is replaced before the first source finishes starting.
    getCdpManagerMock.mockReturnValue({ id: 2 } as never);
    await events.ensureStarted();
    expect(source.start).toHaveBeenCalledTimes(2);

    resolveFirstStart({ unsubscribe: unsubscribeFirst });
    await firstRun;

    expect(unsubscribeFirst).toHaveBeenCalledTimes(1);
    expect(unsubscribeSecond).not.toHaveBeenCalled();

    // The manager-2 subscription is the one kept: no restart.
    await events.ensureStarted();
    expect(source.start).toHaveBeenCalledTimes(2);
  });

  it('keeps the other sources when one fails to start', async () => {
    getCdpManagerMock.mockReturnValueOnce({ id: 1 } as never);
    const failing = { start: vi.fn().mockRejectedValue(new Error('boom')) };
    const { source, unsubscribe } = createSource();
    const events = new SessionEvents({} as BrowserContext, [failing, source]);

    expect(await events.ensureStarted()).toBeUndefined();

    getCdpManagerMock.mockReturnValue({ id: 2 } as never);
    await events.ensureStarted();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(failing.start).toHaveBeenCalledTimes(2);
  });
});

describe('SessionEvents start bound and errors', () => {
  beforeEach(() => {
    getCdpManagerMock.mockReset();
  });

  /**
   * Tracks whether a promise settled.
   *
   * @param promise - The promise.
   * @returns Read `settled` later.
   */
  function track(promise: Promise<unknown>): { settled: boolean } {
    const state = { settled: false };
    promise
      .finally(() => {
        state.settled = true;
      })
      .catch(() => undefined);
    return state;
  }

  it('does not hang later calls on a start that never finishes', async () => {
    vi.useFakeTimers();
    try {
      getCdpManagerMock.mockReturnValue({ id: 1 } as never);
      const source = {
        start: vi.fn(async () => new Promise<never>(() => undefined)),
      };
      const events = new SessionEvents({} as BrowserContext, [source]);

      const first = track(events.ensureStarted());
      await vi.advanceTimersByTimeAsync(SESSION_EVENTS_START_WAIT_MS);
      expect(first.settled).toBe(true);

      // The start is still running: a later call waits one bound, not
      // forever, and does not start the sources again.
      const later = track(events.ensureStarted());
      await vi.advanceTimersByTimeAsync(SESSION_EVENTS_START_WAIT_MS - 1);
      expect(later.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(later.settled).toBe(true);
      expect(source.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns as soon as the sources started', async () => {
    getCdpManagerMock.mockReturnValue({ id: 1 } as never);
    const { source } = createSource();
    const events = new SessionEvents({} as BrowserContext, [source]);

    expect(await events.ensureStarted()).toBeUndefined();
    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it('records a source that fails to start as a capture error', async () => {
    getCdpManagerMock.mockReturnValue({ id: 1 } as never);
    const failing = {
      start: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'boom at https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef',
          ),
        ),
    };
    const events = new SessionEvents({} as BrowserContext, [failing]);

    await events.ensureStarted();

    expect(events.buffer.summary()).toMatchObject({
      captureErrors: 1,
      lastCaptureError: 'boom at https://mainnet.infura.io/v3/[REDACTED]',
    });
  });

  it('reportError counts, redacts and cuts an error, and never throws', () => {
    const events = new SessionEvents({} as BrowserContext, []);

    events.reportError(new Error('x'.repeat(400)));
    expect(events.buffer.summary().lastCaptureError).toBe(
      `${'x'.repeat(300)}…`,
    );
    events.reportError('plain text');
    expect(events.buffer.summary()).toMatchObject({
      captureErrors: 2,
      lastCaptureError: 'plain text',
    });

    vi.spyOn(events.buffer, 'noteCaptureError').mockImplementation(() => {
      throw new Error('buffer broken');
    });
    expect(() => events.reportError(new Error('y'))).not.toThrowError();
  });
});

describe('getSessionEvents', () => {
  it('returns one instance per browser context, with its own buffer', () => {
    const first = {} as BrowserContext;
    const second = {} as BrowserContext;
    const events = getSessionEvents(first);

    expect(getSessionEvents(first)).toBe(events);
    const other = getSessionEvents(second);
    expect(other).not.toBe(events);
    expect(other.buffer.startedAt).toBeGreaterThan(events.buffer.startedAt);
  });
});
