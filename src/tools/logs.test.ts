import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { logsTool } from './logs.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ConsoleRecord } from './types/events.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext } from '../types/http.js';

vi.mock('../platform/cdp-manager.js', () => ({
  getCdpManager: vi.fn().mockReturnValue({
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
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

describe('logsTool', () => {
  it('fails without a session', async () => {
    const { context } = createContext(false);
    expect(await logsTool({}, context)).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.MM_NO_ACTIVE_SESSION },
    });
  });

  it('reads console records with cursor, since, limit and grep', async () => {
    const { context, browserContext } = createContext();
    const { buffer } = getSessionEvents(browserContext);
    buffer.append<ConsoleRecord>('console', {
      t: 100,
      target: TARGET,
      level: 'error',
      text: 'alpha failed',
    });
    buffer.append('network', { t: 150, target: TARGET });
    buffer.append<ConsoleRecord>('console', {
      t: 200,
      target: TARGET,
      level: 'error',
      text: 'beta failed',
    });
    buffer.append<ConsoleRecord>('console', {
      t: 300,
      target: TARGET,
      level: 'error',
      text: 'alpha again',
    });

    const all = await logsTool({}, context);
    expect(all).toMatchObject({
      ok: true,
      result: {
        cursor: 4,
        hasMore: false,
        gap: false,
        summary: { seq: 4, counts: { console: 3, network: 1 } },
      },
    });

    const grep = await logsTool({ grep: '^alpha', limit: 1 }, context);
    expect(grep).toMatchObject({
      ok: true,
      result: {
        records: [{ seq: 1, text: 'alpha failed' }],
        cursor: 1,
        hasMore: true,
      },
    });

    const since = await logsTool({ since: '200', cursor: 3 }, context);
    expect(since).toMatchObject({
      ok: true,
      result: { records: [{ seq: 4 }], cursor: 4, hasMore: false },
    });

    const iso = await logsTool(
      { since: new Date(250).toISOString(), action: 'read' },
      context,
    );
    expect(iso.ok && iso.result).toMatchObject({ records: [{ seq: 4 }] });
  });

  it('rejects an invalid grep', async () => {
    const { context } = createContext();
    expect(await logsTool({ grep: '(' }, context)).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.MM_INVALID_INPUT },
    });
  });

  it('accepts a pattern that is only valid without the u flag', async () => {
    const { context, browserContext } = createContext();
    const { buffer } = getSessionEvents(browserContext);
    buffer.append<ConsoleRecord>('console', {
      t: 100,
      target: TARGET,
      level: 'error',
      text: 'foo-bar failed',
    });
    const result = await logsTool({ grep: 'foo\\-bar' }, context);
    expect(result).toMatchObject({
      ok: true,
      result: { records: [{ text: 'foo-bar failed' }] },
    });
  });

  it('rejects a grep pattern longer than 256 characters', async () => {
    const { context } = createContext();
    expect(await logsTool({ grep: 'x'.repeat(257) }, context)).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.MM_INVALID_INPUT },
    });
  });

  it('configure changes the recorded levels', async () => {
    const { context, browserContext } = createContext();
    const events = getSessionEvents(browserContext);
    expect(events.config.consoleLevels).toStrictEqual(['error']);

    const result = await logsTool(
      { action: 'configure', levels: ['error', 'warning', 'error'] },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      result: { action: 'configure', config: { levels: ['error', 'warning'] } },
    });
    expect(events.config.consoleLevels).toStrictEqual(['error', 'warning']);
  });
});
