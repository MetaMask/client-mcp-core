import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { isErrorRequest, networkTool } from './network.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { NetworkRecord } from './types/events.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext } from '../types/http.js';

vi.mock('../platform/cdp-manager.js', () => ({
  getCdpManager: vi.fn().mockReturnValue({
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

const TARGET = {
  kind: 'sw' as const,
  id: 'W',
  url: 'chrome-extension://x/bg.js',
};

/**
 * Builds a tool context around a fake browser context.
 *
 * @param hasActive - Whether a session is active.
 * @returns The context and its browser context.
 */
function createContext(hasActive = true): {
  context: ToolContext;
  browserContext: BrowserContext;
} {
  const browserContext = {} as BrowserContext;
  const sessionManager = createMockSessionManager({ hasActive });
  sessionManager.getContext.mockReturnValue(browserContext);
  return {
    context: { sessionManager } as unknown as ToolContext,
    browserContext,
  };
}

/**
 * Appends a network record.
 *
 * @param browserContext - The browser context of the session.
 * @param fields - Record fields.
 * @returns The stored record.
 */
function addRequest(
  browserContext: BrowserContext,
  fields: Partial<NetworkRecord> & { url: string },
): NetworkRecord {
  return getSessionEvents(browserContext).buffer.append<NetworkRecord>(
    'network',
    {
      t: 100,
      target: TARGET,
      method: 'GET',
      type: 'fetch',
      ...fields,
    },
  );
}

/**
 * Marks a request final.
 *
 * @param browserContext - The browser context of the session.
 * @param record - The request record.
 * @returns The record.
 */
function settleRequest(
  browserContext: BrowserContext,
  record: NetworkRecord,
): NetworkRecord {
  getSessionEvents(browserContext).buffer.settle('network', record);
  return record;
}

describe('isErrorRequest', () => {
  it.each([
    [{ status: 200 }, false],
    [{}, false],
    [{ status: 404 }, true],
    [{ failure: 'net::ERR_ABORTED' }, true],
    [{ status: 200, rpcError: { message: 'x' } }, true],
  ])('%j → %s', (fields, expected) => {
    expect(
      isErrorRequest({
        seq: 1,
        t: 1,
        target: TARGET,
        method: 'GET',
        url: 'u',
        type: 'fetch',
        ...fields,
      }),
    ).toBe(expected);
  });
});

describe('networkTool', () => {
  it('fails without a session', async () => {
    const { context } = createContext(false);
    expect(await networkTool({}, context)).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.MM_NO_ACTIVE_SESSION },
    });
  });

  it('reads requests with filters, paging and stats', async () => {
    const { context, browserContext } = createContext();
    const first = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/a',
      status: 200,
    });
    const second = addRequest(browserContext, {
      url: 'https://mainnet.infura.io/v3/x',
      status: 404,
    });
    const third = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/b',
      failure: 'net::ERR_ABORTED',
    });
    settleRequest(browserContext, first);
    settleRequest(browserContext, second);
    settleRequest(browserContext, third);

    const all = await networkTool({}, context);
    expect(all).toMatchObject({
      ok: true,
      result: {
        cursor: 6,
        hasMore: false,
        gap: false,
        stats: { pending: 0, ignored: 0, rpcErrorsSkipped: 0 },
      },
    });
    expect(
      all.ok && 'records' in all.result && all.result.records,
    ).toHaveLength(3);

    // Filtered reads are in settle order and page by settle position.
    const errors = await networkTool({ errors: true, limit: 1 }, context);
    expect(errors).toMatchObject({
      ok: true,
      result: { records: [{ seq: 2 }], hasMore: true, cursor: 5 },
    });
    const errorsNext = await networkTool(
      { errors: true, limit: 1, cursor: 5 },
      context,
    );
    expect(errorsNext).toMatchObject({
      ok: true,
      result: { records: [{ seq: 3 }], hasMore: false, cursor: 6 },
    });

    const url = await networkTool(
      { url: 'https://gas.api.cx.metamask.io/**', cursor: 4 },
      context,
    );
    expect(url).toMatchObject({ ok: true, result: { records: [{ seq: 3 }] } });

    const both = await networkTool(
      { url: 'gas.api', errors: true, since: 50, action: 'read' },
      context,
    );
    expect(both).toMatchObject({ ok: true, result: { records: [{ seq: 3 }] } });
  });

  it('returns a request that ends after a filtered read, even when it started before the cursor', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const pending = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/pending',
    });

    const first = await networkTool({ errors: true }, context);
    expect(first).toMatchObject({
      ok: true,
      result: { records: [], cursor: pending.seq, hasMore: false },
    });

    pending.failure = 'net::ERR_ABORTED';
    settleRequest(browserContext, pending);
    const second = await networkTool(
      { errors: true, cursor: pending.seq },
      context,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        records: [{ seq: pending.seq, failure: 'net::ERR_ABORTED' }],
        cursor: pending.seq + 1,
      },
    });

    const third = await networkTool(
      { errors: true, cursor: pending.seq + 1 },
      context,
    );
    expect(third).toMatchObject({ ok: true, result: { records: [] } });
  });

  it('returns an open request after a stale cursor read', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const pending = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/pending',
    });

    // A cursor from an earlier session reads from the start, reports the
    // gap, and returns the newest position: the request is still open, so
    // it is not returned, but its late failure stays after that position.
    const first = await networkTool({ errors: true, cursor: 5 }, context);
    expect(first).toMatchObject({
      ok: true,
      result: { records: [], cursor: pending.seq, gap: true },
    });

    pending.failure = 'net::ERR_ABORTED';
    settleRequest(browserContext, pending);
    const second = await networkTool(
      { errors: true, cursor: pending.seq },
      context,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        records: [{ seq: pending.seq, failure: 'net::ERR_ABORTED' }],
        cursor: pending.seq + 1,
      },
    });
  });

  it('returns an older request that ends after a filtered read, once', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const open = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/slow',
    });
    settleRequest(
      browserContext,
      addRequest(browserContext, {
        url: 'https://mainnet.infura.io/v3/x',
        status: 500,
      }),
    );

    const first = await networkTool({ errors: true }, context);
    expect(first).toMatchObject({
      ok: true,
      result: { records: [{ seq: 2 }], cursor: 3 },
    });

    // The older record settles after the read: its settle position is
    // above the returned cursor, so the next read returns it once.
    open.failure = 'net::ERR_ABORTED';
    settleRequest(browserContext, open);
    const second = await networkTool({ errors: true, cursor: 3 }, context);
    expect(second).toMatchObject({
      ok: true,
      result: {
        records: [{ seq: 1, failure: 'net::ERR_ABORTED' }],
        cursor: 4,
      },
    });
    const third = await networkTool({ errors: true, cursor: 4 }, context);
    expect(third).toMatchObject({ ok: true, result: { records: [] } });
  });

  it('pages late failures with limit 1', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const first = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/1',
    });
    const second = addRequest(browserContext, {
      url: 'https://mainnet.infura.io/v3/x',
    });
    const third = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/3',
    });
    second.status = 500;
    settleRequest(browserContext, second);
    first.failure = 'net::ERR_FAILED';
    settleRequest(browserContext, first);
    third.failure = 'net::ERR_ABORTED';
    settleRequest(browserContext, third);

    const page1 = await networkTool({ errors: true, limit: 1 }, context);
    expect(page1).toMatchObject({
      ok: true,
      result: { records: [{ seq: 2 }], cursor: 4, hasMore: true },
    });
    const page2 = await networkTool(
      { errors: true, limit: 1, cursor: 4 },
      context,
    );
    expect(page2).toMatchObject({
      ok: true,
      result: { records: [{ seq: 1 }], cursor: 5, hasMore: true },
    });
    const page3 = await networkTool(
      { errors: true, limit: 1, cursor: 5 },
      context,
    );
    expect(page3).toMatchObject({
      ok: true,
      result: { records: [{ seq: 3 }], cursor: 6, hasMore: false },
    });
  });

  it('reads settled requests in settle order with settled: true', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const started = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/started-before-mark',
    });
    addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/still-open',
    });

    // At the mark, nothing has settled.
    const mark = await networkTool({ settled: true }, context);
    expect(mark).toMatchObject({
      ok: true,
      result: { records: [], cursor: 2, gap: false },
    });
    const markCursor = (mark as { result: { cursor: number } }).result.cursor;

    // The request started before the mark ends after it: a settled read
    // from the mark returns it, with its final status.
    started.status = 200;
    settleRequest(browserContext, started);
    const afterEnd = await networkTool(
      { settled: true, cursor: markCursor },
      context,
    );
    expect(afterEnd).toMatchObject({
      ok: true,
      result: {
        records: [{ seq: 1, status: 200 }],
        hasMore: false,
        cursor: 3,
      },
    });

    // The other request is still open, and a repeated read with the returned
    // cursor returns neither record again.
    const repeat = await networkTool({ settled: true, cursor: 3 }, context);
    expect(repeat).toMatchObject({ ok: true, result: { records: [] } });
  });

  it('keeps unfiltered reads on start order and pending records', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    await events.ensureStarted();
    const pending = addRequest(browserContext, {
      url: 'https://gas.api.cx.metamask.io/pending',
    });
    settleRequest(
      browserContext,
      addRequest(browserContext, {
        url: 'https://gas.api.cx.metamask.io/done',
        status: 200,
      }),
    );

    const first = await networkTool({}, context);
    expect(first).toMatchObject({
      ok: true,
      result: { records: [{ seq: 1 }, { seq: 2 }], cursor: 3 },
    });

    // A record updated in place keeps its seq: an unfiltered read past it
    // never returns it again, unlike a filtered read (which uses settle
    // positions).
    pending.failure = 'net::ERR_ABORTED';
    settleRequest(browserContext, pending);
    const again = await networkTool({ cursor: 3 }, context);
    expect(again).toMatchObject({ ok: true, result: { records: [] } });
  });

  it('configure turns rpcErrors on and off', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);

    expect(
      await networkTool({ action: 'configure', rpcErrors: true }, context),
    ).toMatchObject({
      ok: true,
      result: { action: 'configure', config: { rpcErrors: true } },
    });
    expect(events.config.rpcErrors).toBe(true);
    expect(events.config.consoleLevels).toStrictEqual(['error']);

    await networkTool({ action: 'configure', rpcErrors: false }, context);
    expect(events.config.rpcErrors).toBe(false);
  });
});
