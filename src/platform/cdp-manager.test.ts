import type { Browser, BrowserContext, Page, Worker } from '@playwright/test';
import { describe, it, expect, vi } from 'vitest';

import {
  CdpManager,
  DEFAULT_SW_ATTACH_TIMEOUT_MS,
  STOPPED_WORKER_MESSAGE,
  STOPPED_WORKER_WAIT_MS,
  SW_TARGET_POLL_MS,
  disposeCdpManager,
  getCdpManager,
  isClosedSessionError,
} from './cdp-manager.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/`;
const SW_URL = `${EXTENSION_URL}background.js`;
const PAGE_URL = `${EXTENSION_URL}home.html`;
const TARGET_ID = 'target-1';
const TARGET_ID_2 = 'target-2';
const SESSION_ID = 'session-1';

/**
 * Minimal emitter used by the fakes.
 *
 * @returns The emitter mock.
 */
function createEmitter() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    }),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: string, payload: unknown): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

type FakeCdpSession = {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

/**
 * Creates a fake page CDP session.
 *
 * @param send - Answers commands.
 * @returns The session mock.
 */
function createCdpSession(
  send: (method: string, params?: Record<string, unknown>) => unknown = () => ({
    result: { value: 'ok' },
  }),
): FakeCdpSession {
  return {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) =>
      send(method, params),
    ),
    detach: vi.fn(async () => undefined),
  };
}

type FakeWorker = Worker & { emitter: ReturnType<typeof createEmitter> };

/**
 * Creates a fake extension worker that emits `close` like Playwright does.
 *
 * @param url - Its URL.
 * @returns The worker mock.
 */
function createWorker(url = SW_URL): FakeWorker {
  const emitter = createEmitter();
  return {
    url: vi.fn(() => url),
    on: emitter.on,
    once: emitter.on,
    off: emitter.off,
    emitter,
  } as unknown as FakeWorker;
}

/**
 * Creates a fake page.
 *
 * @param url - Its URL.
 * @returns The page mock.
 */
function createPage(url = PAGE_URL): Page {
  return { url: vi.fn(() => url) } as unknown as Page;
}

type SwTargetInfo = {
  type: string;
  url: string;
  targetId: string;
};

type SwOptions = {
  workers?: Worker[];
  pages?: Page[];
  browser?: Browser | null;
  /** The browser-level target list. Defaults to one Extension SW target. */
  targets?: SwTargetInfo[];
  /** Answers the service worker command tunneled over the browser session. */
  swReply?: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
};

type FakeContext = {
  context: BrowserContext;
  emitter: ReturnType<typeof createEmitter>;
  newCDPSession: ReturnType<typeof vi.fn>;
  workers: Worker[];
  targets: SwTargetInfo[];
  browserSession: {
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  browserEmitter: ReturnType<typeof createEmitter>;
  emittedTargetIds: { targetId: string; flatten: boolean }[];
};

/**
 * Creates a fake browser context.
 *
 * @param options - Workers, pages, sessions and tunnel answers.
 * @returns The context mock and its handles.
 */
function createContext(options: SwOptions = {}): FakeContext {
  const emitter = createEmitter();
  const browserEmitter = createEmitter();
  const emittedTargetIds: { targetId: string; flatten: boolean }[] = [];
  const newCDPSession = vi.fn(async () => createCdpSession());
  const workers = options.workers ?? [createWorker()];
  const targets = options.targets ?? [
    { type: 'service_worker', url: SW_URL, targetId: TARGET_ID },
  ];

  const browserSession = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case 'Target.getTargets':
          return { targetInfos: targets };
        case 'Target.attachToTarget': {
          emittedTargetIds.push({
            targetId: String(params?.targetId),
            flatten: Boolean(params?.flatten),
          });
          return { sessionId: SESSION_ID };
        }
        case 'Target.sendMessageToTarget': {
          const message = JSON.parse(String(params?.message)) as {
            id: number;
            method: string;
            params: Record<string, unknown>;
          };
          const reply = options.swReply?.(message.method, message.params) ?? {
            result: { value: 'ok' },
          };
          browserEmitter.emit('Target.receivedMessageFromTarget', {
            sessionId: String(params?.sessionId),
            message: JSON.stringify({ id: message.id, ...reply }),
          });
          return {};
        }
        default:
          return {};
      }
    }),
    detach: vi.fn(async () => undefined),
    on: browserEmitter.on,
    off: browserEmitter.off,
  };

  const browser =
    options.browser === undefined
      ? ({
          newBrowserCDPSession: vi.fn(async () => browserSession),
        } as unknown as Browser)
      : options.browser;

  const context = {
    on: emitter.on,
    off: emitter.off,
    pages: vi.fn(() => options.pages ?? [createPage()]),
    serviceWorkers: vi.fn(() => workers),
    browser: vi.fn(() => browser),
    newCDPSession,
  } as unknown as BrowserContext;

  return {
    context,
    emitter,
    newCDPSession,
    workers,
    targets,
    browserSession,
    browserEmitter,
    emittedTargetIds,
  };
}

/**
 * Waits for the pending microtasks of the manager.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('isClosedSessionError', () => {
  it.each([
    'Target page, context or browser has been closed',
    'Protocol error (Runtime.callFunctionOn): Target closed.',
    'Session closed. Most likely the page has been closed.',
    'Session with given id not found.',
    'Browser has been closed',
  ])('matches %s', (message) => {
    expect(isClosedSessionError(new Error(message))).toBe(true);
  });

  it.each([
    'Protocol error: method not found',
    'CDP call timed out',
    'Not allowed',
  ])('does not match %s', (message) => {
    expect(isClosedSessionError(new Error(message))).toBe(false);
  });

  it('reads non-Error throwables', () => {
    expect(isClosedSessionError('Target closed')).toBe(true);
  });
});

describe('CdpManager page targets', () => {
  it('reuses one session across calls (AC1)', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const page = createPage();

    const first = await manager.getSession({ kind: 'page', page });
    const second = await manager.getSession({ kind: 'page', page });

    expect(second).toBe(first);
    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight open between concurrent callers', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const page = createPage();

    const [first, second] = await Promise.all([
      manager.getSession({ kind: 'page', page }),
      manager.getSession({ kind: 'page', page }),
    ]);

    expect(second).toBe(first);
    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('drops the session of a closed page', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const pageEvents = createEmitter();
    const page = {
      url: vi.fn(() => PAGE_URL),
      once: pageEvents.on,
    } as unknown as Page;
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await manager.getSession({ kind: 'page', page });
    pageEvents.emit('close', page);
    await manager.getSession({ kind: 'page', page });

    expect(detached).toHaveBeenCalledTimes(1);
    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('keeps one session per page', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const firstPage = createPage(`${EXTENSION_URL}a.html`);
    const secondPage = createPage(`${EXTENSION_URL}b.html`);

    await manager.getSession({ kind: 'page', page: firstPage });
    await manager.getSession({ kind: 'page', page: secondPage });

    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('emits targetAttached once and targetDetached on dispose', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const page = createPage();
    const attached = vi.fn();
    const detached = vi.fn();
    manager.on('targetAttached', attached).on('targetDetached', detached);

    await manager.getSession({ kind: 'page', page });
    await manager.getSession({ kind: 'page', page });
    await manager.dispose();

    expect(attached).toHaveBeenCalledTimes(1);
    expect(attached).toHaveBeenCalledWith({ kind: 'page', target: page });
    expect(detached).toHaveBeenCalledTimes(1);
    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('detaches the session on dispose only once', async () => {
    const fake = createContext();
    const session = createCdpSession();
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);

    await manager.getSession({ kind: 'page', page: createPage() });
    await manager.dispose();
    await manager.dispose();

    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(fake.emitter.listenerCount('serviceworker')).toBe(0);
  });

  it('removes a listener with off', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const listener = vi.fn();
    manager.on('targetAttached', listener).off('targetAttached', listener);

    await manager.getSession({ kind: 'page', page: createPage() });

    expect(listener).not.toHaveBeenCalled();
  });

  it('calls every listener of an event', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const first = vi.fn();
    const second = vi.fn();
    manager.on('targetAttached', first).on('targetAttached', second);

    await manager.getSession({ kind: 'page', page: createPage() });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores a session detach failure on dispose', async () => {
    const fake = createContext();
    const session = createCdpSession();
    session.detach.mockRejectedValueOnce(new Error('Target closed'));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);

    await manager.getSession({ kind: 'page', page: createPage() });

    expect(await manager.dispose()).toBeUndefined();
  });

  it('detaches a session that opens after dispose', async () => {
    const fake = createContext();
    const session = createCdpSession();
    session.detach.mockRejectedValueOnce(new Error('Target closed'));
    let resolveSession!: (value: FakeCdpSession) => void;
    fake.newCDPSession.mockReturnValueOnce(
      new Promise<FakeCdpSession>((resolve) => {
        resolveSession = resolve;
      }),
    );
    const manager = new CdpManager(fake.context);

    const opening = manager.getSession({ kind: 'page', page: createPage() });
    await flush();
    const disposing = manager.dispose();
    resolveSession(session);

    await expect(opening).rejects.toThrowError('CDP manager is disposed');
    await disposing;
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('rejects calls after dispose', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    await manager.dispose();

    await expect(
      manager.getSession({ kind: 'page', page: createPage() }),
    ).rejects.toThrowError('CDP manager is disposed');
    await expect(
      manager.send({ kind: 'page', page: createPage() }, 'Runtime.evaluate'),
    ).rejects.toThrowError('CDP manager is disposed');
  });
});

describe('CdpManager send', () => {
  it('sends on the persistent session and keeps it', async () => {
    const fake = createContext();
    const session = createCdpSession(() => ({ result: { value: 1 } }));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);
    const page = createPage();

    const first = await manager.send(
      { kind: 'page', page },
      'Runtime.evaluate',
      { expression: '1+1' },
    );
    const second = await manager.send(
      { kind: 'page', page },
      'Runtime.evaluate',
      { expression: '2+2' },
    );

    expect(first).toStrictEqual({ result: { value: 1 } });
    expect(second).toStrictEqual({ result: { value: 1 } });
    expect(session.send).toHaveBeenCalledTimes(2);
    expect(session.detach).not.toHaveBeenCalled();
    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('drops a session closed by a send failure and reopens on the next call', async () => {
    const fake = createContext();
    const firstSession = createCdpSession(() => {
      throw new Error('Target closed');
    });
    const secondSession = createCdpSession(() => ({ ok: true }));
    fake.newCDPSession
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const manager = new CdpManager(fake.context);
    const page = createPage();
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await expect(
      manager.send({ kind: 'page', page }, 'Runtime.evaluate'),
    ).rejects.toThrowError('Target closed');
    expect(detached).toHaveBeenCalledTimes(1);

    expect(
      await manager.send({ kind: 'page', page }, 'Runtime.evaluate'),
    ).toStrictEqual({ ok: true });
    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('retries once when opening the session failed (nothing was sent)', async () => {
    const fake = createContext();
    const session = createCdpSession(() => ({ ok: true }));
    fake.newCDPSession
      .mockRejectedValueOnce(new Error('Target closed'))
      .mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);

    expect(
      await manager.send(
        { kind: 'page', page: createPage() },
        'Runtime.evaluate',
      ),
    ).toStrictEqual({ ok: true });
    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('surfaces the second open failure', async () => {
    const fake = createContext();
    fake.newCDPSession.mockRejectedValue(new Error('Target closed'));
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'page', page: createPage() }, 'Runtime.evaluate'),
    ).rejects.toThrowError('Target closed');
    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-session open failure', async () => {
    const fake = createContext();
    fake.newCDPSession.mockRejectedValue(new Error('boom'));
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'page', page: createPage() }, 'Runtime.evaluate'),
    ).rejects.toThrowError('boom');
    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('times out a slow command without dropping the session', async () => {
    const fake = createContext();
    const session = createCdpSession(async () => new Promise(() => undefined));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);
    const page = createPage();

    await expect(
      manager.send(
        { kind: 'page', page },
        'Runtime.evaluate',
        {},
        {
          timeoutMs: 5,
        },
      ),
    ).rejects.toThrowError('CDP call "Runtime.evaluate" timed out after 5ms');
    await expect(
      manager.send(
        { kind: 'page', page },
        'Runtime.evaluate',
        {},
        {
          timeoutMs: 5,
        },
      ),
    ).rejects.toThrowError('CDP call "Runtime.evaluate" timed out after 5ms');

    expect(fake.newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending command', async () => {
    const fake = createContext();
    const session = createCdpSession(async () => new Promise(() => undefined));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();

    const pending = manager.send(
      { kind: 'page', page: createPage() },
      'Runtime.evaluate',
      {},
      { signal: controller.signal },
    );
    controller.abort(new Error('stop'));

    await expect(pending).rejects.toThrowError('stop');
  });

  it('aborts a command with an already aborted signal', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(
      manager.send(
        { kind: 'page', page: createPage() },
        'Runtime.evaluate',
        {},
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toThrowError('stop');
  });

  it('aborts a pending command with a non-Error reason', async () => {
    const fake = createContext();
    const session = createCdpSession(async () => new Promise(() => undefined));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();

    const pending = manager.send(
      { kind: 'page', page: createPage() },
      'Runtime.evaluate',
      {},
      { signal: controller.signal, timeoutMs: 1000 },
    );
    await flush();
    controller.abort('stop');

    await expect(pending).rejects.toThrowError('CDP target wait aborted');
  });

  it('opens a one-shot session with fresh and detaches it', async () => {
    const fake = createContext();
    const first = createCdpSession(() => ({ ok: 1 }));
    const second = createCdpSession(() => ({ ok: 2 }));
    fake.newCDPSession
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const manager = new CdpManager(fake.context);
    const page = createPage();

    expect(
      await manager.send(
        { kind: 'page', page },
        'Runtime.evaluate',
        {},
        {
          fresh: true,
        },
      ),
    ).toStrictEqual({ ok: 1 });
    expect(
      await manager.send(
        { kind: 'page', page },
        'Runtime.evaluate',
        {},
        {
          fresh: true,
        },
      ),
    ).toStrictEqual({ ok: 2 });

    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(second.detach).toHaveBeenCalledTimes(1);
    expect(fake.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('keeps the persistent session when a fresh call runs', async () => {
    const fake = createContext();
    const persistent = createCdpSession(() => ({ persistent: true }));
    const oneShot = createCdpSession(() => ({ fresh: true }));
    fake.newCDPSession
      .mockResolvedValueOnce(persistent)
      .mockResolvedValueOnce(oneShot);
    const manager = new CdpManager(fake.context);
    const page = createPage();

    await manager.send({ kind: 'page', page }, 'Runtime.evaluate');
    await manager.send(
      { kind: 'page', page },
      'Runtime.evaluate',
      {},
      {
        fresh: true,
      },
    );
    await manager.send({ kind: 'page', page }, 'Runtime.evaluate');

    expect(persistent.detach).not.toHaveBeenCalled();
    expect(oneShot.detach).toHaveBeenCalledTimes(1);
  });

  it('ignores a detach failure of a one-shot session', async () => {
    const fake = createContext();
    const session = createCdpSession(() => ({ ok: true }));
    session.detach.mockRejectedValueOnce(new Error('Target closed'));
    fake.newCDPSession.mockResolvedValueOnce(session);
    const manager = new CdpManager(fake.context);

    expect(
      await manager.send(
        { kind: 'page', page: createPage() },
        'Runtime.evaluate',
        {},
        {
          fresh: true,
        },
      ),
    ).toStrictEqual({ ok: true });
  });
});

describe('CdpManager service worker target', () => {
  it('attaches to the extension worker through the browser session', async () => {
    const fake = createContext({
      swReply: () => ({
        result: { result: { type: 'string', value: 'object' } },
      }),
    });
    const manager = new CdpManager(fake.context);

    const result = await manager.send(
      { kind: 'sw' },
      'Runtime.evaluate',
      { expression: 'typeof globalThis.stateHooks', returnByValue: true },
      { timeoutMs: 1000 },
    );

    expect(result).toStrictEqual({
      result: { type: 'string', value: 'object' },
    });
    expect(fake.emittedTargetIds).toStrictEqual([
      { targetId: TARGET_ID, flatten: false },
    ]);
    const sendMessage = fake.browserSession.send.mock.calls.find(
      ([method]) => method === 'Target.sendMessageToTarget',
    );
    expect(JSON.parse(String(sendMessage?.[1]?.message))).toMatchObject({
      method: 'Runtime.evaluate',
      params: { expression: 'typeof globalThis.stateHooks' },
    });
  });

  it('reuses the worker session across calls', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    expect(fake.emittedTargetIds).toHaveLength(1);
    expect(
      fake.browserSession.send.mock.calls.filter(
        ([method]) => method === 'Target.attachToTarget',
      ),
    ).toHaveLength(1);
  });

  it('polls for the worker target when none is running', async () => {
    vi.useFakeTimers();
    try {
      const fake = createContext({ workers: [], targets: [] });
      const manager = new CdpManager(fake.context);
      const pending = manager.send(
        { kind: 'sw' },
        'Runtime.evaluate',
        {},
        { timeoutMs: 5000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      fake.targets.push({
        type: 'service_worker',
        url: SW_URL,
        targetId: TARGET_ID,
      });
      await vi.advanceTimersByTimeAsync(SW_TARGET_POLL_MS);

      expect(await pending).toStrictEqual({ value: 'ok' });
      expect(fake.emittedTargetIds).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives the extension ID from a live target', async () => {
    const fake = createContext({ workers: [], pages: [] });
    const manager = new CdpManager(fake.context);

    expect(
      await manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).toBeDefined();
    expect(fake.emittedTargetIds).toHaveLength(1);
  });

  it('fails fast with the stopped-worker error when the extension is known', async () => {
    const fake = createContext({ workers: [], targets: [] });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate', {}, { timeoutMs: 5 }),
    ).rejects.toThrowError(STOPPED_WORKER_MESSAGE);
  });

  it('times out cleanly when no extension is known at all', async () => {
    const fake = createContext({ workers: [], pages: [], targets: [] });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate', {}, { timeoutMs: 5 }),
    ).rejects.toThrowError(
      'Timed out after 5ms waiting for the extension service worker',
    );
  });

  it('caps the wait at the stopped-worker window once the extension is known', async () => {
    vi.useFakeTimers();
    try {
      const fake = createContext({ workers: [], targets: [] });
      const manager = new CdpManager(fake.context);
      const pending = manager.send(
        { kind: 'sw' },
        'Runtime.evaluate',
        {},
        { timeoutMs: 30_000 },
      );
      const error = pending.catch((reason: Error) => reason);

      await vi.advanceTimersByTimeAsync(STOPPED_WORKER_WAIT_MS - 1);
      await vi.advanceTimersByTimeAsync(1);

      expect((await error).message).toBe(STOPPED_WORKER_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits 30 seconds for the worker by default', () => {
    expect(DEFAULT_SW_ATTACH_TIMEOUT_MS).toBe(30_000);
  });

  it('uses the default wait when no timeout is given', async () => {
    const fake = createContext({ workers: [], targets: [] });
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();

    const pending = manager.send(
      { kind: 'sw' },
      'Runtime.evaluate',
      {},
      {
        signal: controller.signal,
      },
    );
    await flush();
    controller.abort(new Error('stop'));

    await expect(pending).rejects.toThrowError('stop');
  });

  it('aborts the wait for the worker', async () => {
    const fake = createContext({ workers: [], targets: [] });
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();

    const pending = manager.send(
      { kind: 'sw' },
      'Runtime.evaluate',
      {},
      {
        timeoutMs: 1000,
        signal: controller.signal,
      },
    );
    await flush();
    controller.abort(new Error('stop waiting'));

    await expect(pending).rejects.toThrowError('stop waiting');
  });

  it('rejects an already aborted wait', async () => {
    const fake = createContext({ workers: [], targets: [] });
    const manager = new CdpManager(fake.context);
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(
      manager.send(
        { kind: 'sw' },
        'Runtime.evaluate',
        {},
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toThrowError('stop');
  });

  it('re-attaches to a restarted worker with a new target ID (AC3)', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const worker = fake.workers[0];

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    expect(fake.emittedTargetIds).toHaveLength(1);

    // Playwright keeps the same Worker object and emits no event: only the
    // CDP target changes.
    fake.targets[0] = {
      type: 'service_worker',
      url: SW_URL,
      targetId: TARGET_ID_2,
    };
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    expect(fake.emittedTargetIds.map((entry) => entry.targetId)).toStrictEqual([
      TARGET_ID,
      TARGET_ID_2,
    ]);
    expect(fake.workers[0]).toBe(worker);
  });

  it('drops the session when the attached target detaches', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.browserEmitter.emit('Target.detachedFromTarget', {
      sessionId: SESSION_ID,
    });
    expect(detached).toHaveBeenCalledTimes(1);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    expect(fake.emittedTargetIds).toHaveLength(2);
  });

  it('ignores messages for another session and unknown ids', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.browserEmitter.emit('Target.receivedMessageFromTarget', {
      sessionId: 'other',
      message: JSON.stringify({ id: 1, result: {} }),
    });
    fake.browserEmitter.emit('Target.receivedMessageFromTarget', {
      sessionId: SESSION_ID,
      message: JSON.stringify({ id: 999, result: {} }),
    });
    fake.browserEmitter.emit('Target.receivedMessageFromTarget', {
      sessionId: SESSION_ID,
      message: 'not json',
    });
    fake.browserEmitter.emit('Target.receivedMessageFromTarget', {
      sessionId: SESSION_ID,
      message: JSON.stringify({ method: 'Network.requestWillBeSent' }),
    });

    expect(
      await manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).toBeDefined();
  });

  it('rejects when the worker answers with an error', async () => {
    const fake = createContext({
      swReply: () => ({
        error: { code: -32000, message: 'Runtime is gone' },
      }),
    });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError('Runtime is gone');
  });

  it('rejects when the tunnel send fails', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    fake.browserSession.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Target.sendMessageToTarget') {
          throw new Error('Target closed');
        }
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { type: 'service_worker', url: SW_URL, targetId: TARGET_ID },
            ],
          };
        }
        return { sessionId: SESSION_ID, ...params };
      },
    );

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError('Target closed');
  });

  it('fails when the browser has no CDP session', async () => {
    const fake = createContext({ browser: null });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError(
      'CDP service worker targets need a Chromium browser session',
    );
  });

  it('fails when the worker has no live target', async () => {
    const fake = createContext({ targets: [] });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate', {}, { timeoutMs: 5 }),
    ).rejects.toThrowError(STOPPED_WORKER_MESSAGE);
  });

  it('sends a fresh command on a detached one-shot worker session', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate', {}, { fresh: true });

    expect(
      fake.browserSession.send.mock.calls.filter(
        ([method]) => method === 'Target.detachFromTarget',
      ),
    ).toHaveLength(1);
  });

  it('detaches the worker session and the browser session on dispose', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    await manager.dispose();

    expect(
      fake.browserSession.send.mock.calls.filter(
        ([method]) => method === 'Target.detachFromTarget',
      ),
    ).toHaveLength(1);
    expect(fake.browserSession.detach).toHaveBeenCalledTimes(1);
    expect(
      fake.browserEmitter.listenerCount('Target.receivedMessageFromTarget'),
    ).toBe(0);
  });

  it('ignores serviceworker events for other extensions and same worker', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.emitter.emit(
      'serviceworker',
      createWorker('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/bg.js'),
    );
    fake.emitter.emit('serviceworker', {
      url: vi.fn(() => 'https://example.test/sw.js'),
    } as unknown as Worker);
    fake.emitter.emit('serviceworker', fake.workers[0]);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    expect(fake.emittedTargetIds).toHaveLength(1);
  });

  it('detaches the worker session once and ignores a detach failure', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const session = await manager.getSession({ kind: 'sw' });
    fake.browserSession.send.mockImplementation(async (method: string) => {
      if (method === 'Target.detachFromTarget') {
        throw new Error('Target closed');
      }
      return {};
    });

    expect(await session.detach()).toBeUndefined();
    expect(await session.detach()).toBeUndefined();

    expect(
      fake.browserSession.send.mock.calls.filter(
        ([method]) => method === 'Target.detachFromTarget',
      ),
    ).toHaveLength(1);
  });

  it('fails pending commands and rejects new ones when the target detaches', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const session = await manager.getSession({ kind: 'sw' });
    fake.browserSession.send.mockImplementation(async () => ({}));

    const pending = session.send('Runtime.evaluate', {});
    await flush();
    fake.browserEmitter.emit('Target.detachedFromTarget', {
      sessionId: 'other',
    });
    await flush();
    fake.browserEmitter.emit('Target.detachedFromTarget', {
      sessionId: SESSION_ID,
    });

    await expect(pending).rejects.toThrowError(
      'Session closed. The service worker target is gone.',
    );
    await expect(session.send('Runtime.evaluate', {})).rejects.toThrowError(
      'Session closed. The service worker target is gone.',
    );
  });

  it('uses a generic message when the worker error has none', async () => {
    const fake = createContext({ swReply: () => ({ error: { code: -1 } }) });
    const manager = new CdpManager(fake.context);

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError('CDP command failed');
  });

  it('keeps the cached entry when discovery finds the same worker', async () => {
    const fake = createContext({ workers: [], pages: [] });
    const manager = new CdpManager(fake.context);
    const worker = createWorker();

    const first = manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    await flush();
    fake.emitter.emit('serviceworker', worker);
    await first;

    const second = manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    await flush();
    fake.emitter.emit('serviceworker', worker);
    await second;

    expect(fake.emittedTargetIds).toHaveLength(1);
  });

  it('drops the old target session when a new target ID appears', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.targets[0] = {
      type: 'service_worker',
      url: SW_URL,
      targetId: TARGET_ID_2,
    };
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    expect(detached).toHaveBeenCalledTimes(1);
    expect(fake.emittedTargetIds.map((entry) => entry.targetId)).toStrictEqual([
      TARGET_ID,
      TARGET_ID_2,
    ]);
  });

  it('picks the extension target and skips other service workers', async () => {
    const fake = createContext({
      workers: [],
      pages: [createPage()],
      targets: [
        {
          type: 'service_worker',
          url: 'https://example.test/sw.js',
          targetId: 'web-sw',
        },
        {
          type: 'service_worker',
          url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/bg.js',
          targetId: 'other-ext',
        },
        { type: 'service_worker', url: SW_URL, targetId: TARGET_ID },
        { type: 'page', url: PAGE_URL, targetId: 'page-target' },
      ],
    });
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    expect(fake.emittedTargetIds).toStrictEqual([
      { targetId: TARGET_ID, flatten: false },
    ]);
  });

  it('derives the extension ID from a running service worker', async () => {
    const fake = createContext({
      pages: [createPage('https://example.test/home.html')],
      workers: [createWorker('https://example.test/sw.js'), createWorker()],
    });
    const manager = new CdpManager(fake.context);

    expect(
      await manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).toBeDefined();
    expect(fake.emittedTargetIds).toHaveLength(1);
  });

  it('enables target discovery once on the browser session', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    expect(
      fake.browserSession.send.mock.calls.filter(
        ([method]) => method === 'Target.setDiscoverTargets',
      ),
    ).toStrictEqual([['Target.setDiscoverTargets', { discover: true }]]);
  });

  it('drops the worker session on close and reattaches when it restarts', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const worker = fake.workers[0] as FakeWorker;
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    worker.emitter.emit('close', worker);
    await flush();
    expect(detached).toHaveBeenCalledTimes(1);

    const restarted = createWorker();
    (fake.context.serviceWorkers as ReturnType<typeof vi.fn>).mockReturnValue([
      restarted,
    ]);
    fake.emitter.emit('serviceworker', restarted);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    expect(fake.emittedTargetIds).toHaveLength(2);
  });

  it('rejects a pending command promptly when the worker closes', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const worker = fake.workers[0] as FakeWorker;
    const session = await manager.getSession({ kind: 'sw' });
    fake.browserSession.send.mockImplementation(async () => ({}));

    const pending = session.send('Runtime.evaluate', {});
    await flush();
    worker.emitter.emit('close', worker);

    await expect(pending).rejects.toThrowError(
      'Session closed. The service worker target is gone.',
    );
  });

  it('caps the wait when only a worker was seen before', async () => {
    vi.useFakeTimers();
    try {
      const fake = createContext({ workers: [], pages: [], targets: [] });
      const manager = new CdpManager(fake.context);
      fake.emitter.emit('serviceworker', createWorker());

      const pending = manager.send(
        { kind: 'sw' },
        'Runtime.evaluate',
        {},
        { timeoutMs: 30_000 },
      );
      const error = pending.catch((reason: Error) => reason);
      await vi.advanceTimersByTimeAsync(STOPPED_WORKER_WAIT_MS);

      expect((await error).message).toBe(STOPPED_WORKER_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a target-list failure while polling', async () => {
    vi.useFakeTimers();
    try {
      const fake = createContext({ workers: [], pages: [], targets: [] });
      const manager = new CdpManager(fake.context);
      const implementation = fake.browserSession.send.getMockImplementation();
      let getTargets = 0;
      fake.browserSession.send.mockImplementation(
        async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Target.getTargets' && (getTargets += 1) > 1) {
            throw new Error('boom');
          }
          return implementation?.(method, params);
        },
      );

      const pending = manager.send({ kind: 'sw' }, 'Runtime.evaluate');
      const error = pending.catch((reason: Error) => reason);
      await vi.advanceTimersByTimeAsync(SW_TARGET_POLL_MS);

      expect((await error).message).toBe('boom');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the worker session only for its destroyed target', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const detached = vi.fn();
    manager.on('targetDetached', detached);

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.browserEmitter.emit('Target.targetDestroyed', { targetId: 'other' });
    await flush();
    expect(detached).not.toHaveBeenCalled();

    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    expect(fake.emittedTargetIds).toHaveLength(1);

    fake.browserEmitter.emit('Target.targetDestroyed', { targetId: TARGET_ID });
    await flush();
    expect(detached).toHaveBeenCalledTimes(1);
  });

  it('maps a target that vanishes on attach to the stopped-worker error', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const implementation = fake.browserSession.send.getMockImplementation();
    fake.browserSession.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        // A plain string, as some transport layers throw.
        if (method === 'Target.attachToTarget') {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'No target with given id found';
        }
        return implementation?.(method, params);
      },
    );

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError(STOPPED_WORKER_MESSAGE);
  });

  it('surfaces another attach failure', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const implementation = fake.browserSession.send.getMockImplementation();
    fake.browserSession.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Target.attachToTarget') {
          throw new Error('boom');
        }
        return implementation?.(method, params);
      },
    );

    await expect(
      manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).rejects.toThrowError('boom');
  });

  it('fails an open worker session when the worker closes while attaching', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const worker = fake.workers[0] as FakeWorker;
    const implementation = fake.browserSession.send.getMockImplementation();
    let resolveAttach!: (value: unknown) => void;
    fake.browserSession.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Target.attachToTarget') {
          return new Promise((resolve) => {
            resolveAttach = resolve;
          });
        }
        if (method === 'Target.detachFromTarget') {
          throw new Error('Target closed');
        }
        return implementation?.(method, params);
      },
    );

    const opening = manager.getSession({ kind: 'sw' });
    await flush();
    worker.emitter.emit('close', worker);
    await flush();
    resolveAttach({ sessionId: SESSION_ID });

    await expect(opening).rejects.toThrowError(STOPPED_WORKER_MESSAGE);
  });

  it('ignores the close of a worker without a cached session', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');

    const other = createWorker(
      'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/bg.js',
    );
    fake.emitter.emit('serviceworker', other);
    other.emitter.emit('close', other);
    await flush();

    expect(
      await manager.send({ kind: 'sw' }, 'Runtime.evaluate'),
    ).toBeDefined();
    expect(fake.emittedTargetIds).toHaveLength(1);
  });

  it('fails an open page session when the page closes while attaching', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    const pageEvents = createEmitter();
    const page = {
      url: vi.fn(() => PAGE_URL),
      once: pageEvents.on,
    } as unknown as Page;
    const session = createCdpSession();
    session.detach.mockRejectedValueOnce(new Error('Target closed'));
    let resolveSession!: (value: FakeCdpSession) => void;
    fake.newCDPSession.mockReturnValueOnce(
      new Promise<FakeCdpSession>((resolve) => {
        resolveSession = resolve;
      }),
    );

    const opening = manager.getSession({ kind: 'page', page });
    await flush();
    pageEvents.emit('close', page);
    resolveSession(session);

    await expect(opening).rejects.toThrowError(
      'CDP target closed while attaching',
    );
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('ignores a browser session detach failure on dispose', async () => {
    const fake = createContext();
    const manager = new CdpManager(fake.context);
    await manager.send({ kind: 'sw' }, 'Runtime.evaluate');
    fake.browserSession.detach.mockRejectedValueOnce(
      new Error('Browser closed'),
    );

    expect(await manager.dispose()).toBeUndefined();
  });
});

describe('getCdpManager', () => {
  it('returns one manager per browser context', async () => {
    const fake = createContext();
    const first = getCdpManager(fake.context);
    const second = getCdpManager(fake.context);

    expect(second).toBe(first);
    await first.dispose();
  });

  it('forgets a manager after disposeCdpManager', async () => {
    const fake = createContext();
    const first = getCdpManager(fake.context);
    await disposeCdpManager(fake.context);
    const second = getCdpManager(fake.context);

    expect(second).not.toBe(first);
    await second.dispose();
  });

  it('does nothing when the context has no manager', async () => {
    const fake = createContext();
    expect(await disposeCdpManager(fake.context)).toBeUndefined();
  });
});
