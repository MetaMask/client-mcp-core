import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { eventsTool } from './events.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext } from '../types/http.js';

vi.mock('../platform/cdp-manager.js', () => ({
  getCdpManager: vi.fn().mockReturnValue({}),
}));

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

describe('eventsTool', () => {
  it('fails without a session', async () => {
    const { context } = createContext(false);
    const result = await eventsTool({ action: 'mark' }, context);
    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: ErrorCodes.MM_NO_ACTIVE_SESSION,
        message: 'No active session. Call launch first.',
      },
    });
  });

  it('mark returns the current seq and the summary', async () => {
    const { context, browserContext } = createContext();
    const { buffer } = getSessionEvents(browserContext);
    buffer.append('console', {
      t: 1,
      target: { kind: 'sw', id: 'W', url: 'chrome-extension://x/bg.js' },
    });

    const result = await eventsTool({ action: 'mark' }, context);

    expect(result).toStrictEqual({
      ok: true,
      result: {
        action: 'mark',
        cursor: 1,
        summary: {
          startedAt: buffer.startedAt,
          seq: 1,
          counts: { console: 1, network: 0 },
          dropped: { console: 0, network: 0 },
        },
      },
    });
  });

  it('clear empties one kind or all, keeping seq', async () => {
    const { context, browserContext } = createContext();
    const { buffer } = getSessionEvents(browserContext);
    const target = { kind: 'page' as const, id: 'P', url: 'about:blank' };
    buffer.append('console', { t: 1, target });
    buffer.append('network', { t: 1, target });

    const one = await eventsTool({ action: 'clear', kind: 'network' }, context);
    expect(one).toMatchObject({
      ok: true,
      result: {
        action: 'clear',
        cleared: ['network'],
        summary: { seq: 2, counts: { console: 1, network: 0 } },
      },
    });

    const all = await eventsTool({ action: 'clear' }, context);
    expect(all).toMatchObject({
      ok: true,
      result: {
        cleared: ['console', 'network'],
        summary: { seq: 2, counts: { console: 0, network: 0 } },
      },
    });
  });
});
