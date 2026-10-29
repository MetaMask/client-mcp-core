import type { Page } from '@playwright/test';
import * as vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

import {
  ISOLATED_WORLD_NAME,
  callInIsolatedWorld,
  withCdpSession,
} from './cdp.js';

type Send = ReturnType<typeof vi.fn>;

/**
 * Builds a page whose CDP sessions answer with `respond`.
 *
 * @param respond - Answers `Runtime.callFunctionOn`.
 * @returns The page, the sessions it opened and their send mocks.
 */
function createPage(
  respond: (params: Record<string, unknown>, sessionIndex: number) => unknown,
) {
  const sessions: { send: Send; detach: Send }[] = [];
  let contextCounter = 0;
  const newCDPSession = vi.fn(async () => {
    const sessionIndex = sessions.length;
    const session = {
      send: vi.fn(async (method: string, params: Record<string, unknown>) => {
        switch (method) {
          case 'Page.getFrameTree':
            return { frameTree: { frame: { id: 'main' } } };
          case 'Page.createIsolatedWorld':
            contextCounter += 1;
            return { executionContextId: contextCounter };
          case 'Runtime.callFunctionOn':
            return respond(params, sessionIndex);
          default:
            throw new Error(`Unexpected ${method}`);
        }
      }),
      detach: vi.fn(async () => undefined),
    };
    sessions.push(session);
    return session;
  });
  const page = {
    context: () => ({ newCDPSession }),
  } as unknown as Page;
  return { page, sessions, newCDPSession };
}

/**
 * Runs a functionDeclaration sent by callInIsolatedWorld in a new context.
 *
 * @param params - The Runtime.callFunctionOn params.
 * @returns The CDP response.
 */
function evaluateDeclaration(params: Record<string, unknown>): unknown {
  const fn = vm.runInNewContext(`(${String(params.functionDeclaration)})`, {});
  const args = (params.arguments as { value: unknown }[]).map(
    (arg) => arg.value,
  );
  return { result: { value: fn(...args) } };
}

describe('withCdpSession', () => {
  it('detaches the session after the callback', async () => {
    const { page, sessions } = createPage(() => undefined);

    const result = await withCdpSession(page, async () => 'done');

    expect(result).toBe('done');
    expect(sessions[0].detach).toHaveBeenCalled();
  });
});

describe('callInIsolatedWorld', () => {
  it('runs the function source with its arguments in an isolated world', async () => {
    const { page, sessions } = createPage(evaluateDeclaration);

    const result = await callInIsolatedWorld<number>(
      page,
      '(a, b) => a * b',
      [6, 7],
    );

    expect(result).toBe(42);
    expect(sessions[0].send).toHaveBeenCalledWith('Page.createIsolatedWorld', {
      frameId: 'main',
      worldName: ISOLATED_WORLD_NAME,
    });
    expect(sessions[0].send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({
        executionContextId: 1,
        arguments: [{ value: 6 }, { value: 7 }],
        returnByValue: true,
        awaitPromise: true,
      }),
    );
  });

  it('defines __name so keepNames-transformed source runs', async () => {
    const { page } = createPage(evaluateDeclaration);

    const result = await callInIsolatedWorld<string>(
      page,
      'function () { const f = __name(() => "ok", "f"); return f(); }',
    );

    expect(result).toBe('ok');
  });

  it('reuses the session and world between calls', async () => {
    const { page, sessions, newCDPSession } = createPage(() => ({
      result: { value: 1 },
    }));

    await callInIsolatedWorld(page, '() => 1');
    await callInIsolatedWorld(page, '() => 1');

    expect(newCDPSession).toHaveBeenCalledTimes(1);
    const worldCalls = sessions[0].send.mock.calls.filter(
      ([method]) => method === 'Page.createIsolatedWorld',
    );
    expect(worldCalls).toHaveLength(1);
    expect(sessions[0].detach).not.toHaveBeenCalled();
  });

  it('starts over once after the world or session is gone', async () => {
    const { page, sessions, newCDPSession } = createPage((_params, index) => {
      if (index === 0) {
        throw new Error('Cannot find context with specified id');
      }
      return { result: { value: 'fresh' } };
    });

    const result = await callInIsolatedWorld(page, '() => 1');

    expect(result).toBe('fresh');
    expect(newCDPSession).toHaveBeenCalledTimes(2);
    expect(sessions[0].detach).toHaveBeenCalled();
  });

  it('rejects when the retry fails too', async () => {
    const { page, newCDPSession } = createPage(() => {
      throw new Error('Target closed');
    });

    await expect(callInIsolatedWorld(page, '() => 1')).rejects.toThrowError(
      'Target closed',
    );
    expect(newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('rejects without retrying when the function throws in the page', async () => {
    const { page, sessions, newCDPSession } = createPage(() => ({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: boom' },
      },
    }));

    await expect(callInIsolatedWorld(page, '() => 1')).rejects.toThrowError(
      'TypeError: boom',
    );
    expect(newCDPSession).toHaveBeenCalledTimes(1);
    expect(sessions[0].detach).not.toHaveBeenCalled();
  });

  it('uses the exception text when there is no description', async () => {
    const { page } = createPage(() => ({
      result: { type: 'object' },
      exceptionDetails: { text: 'Uncaught' },
    }));

    await expect(callInIsolatedWorld(page, '() => 1')).rejects.toThrowError(
      'Uncaught',
    );
  });

  it('keeps a newer world when an older call fails late', async () => {
    const rejecters: ((error: Error) => void)[] = [];
    const { page, newCDPSession } = createPage(async (_params, index) => {
      if (index === 0) {
        return new Promise((_resolve, reject) => {
          rejecters.push(reject);
        });
      }
      return { result: { value: index } };
    });

    // Two calls in flight on world 0.
    const first = callInIsolatedWorld(page, '() => 1');
    const second = callInIsolatedWorld(page, '() => 1');
    await vi.waitFor(() => expect(rejecters).toHaveLength(2));
    // The first fails, drops world 0 and retries on world 1.
    rejecters[0](new Error('Target closed'));
    expect(await first).toBe(1);
    // The second fails later: world 1 is kept and reused by its retry.
    rejecters[1](new Error('Target closed'));
    expect(await second).toBe(1);
    expect(await callInIsolatedWorld(page, '() => 1')).toBe(1);
    expect(newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('rejects after timeoutMs while the page call is pending', async () => {
    vi.useFakeTimers();
    try {
      const { page } = createPage(async () => new Promise(() => undefined));

      const pending = callInIsolatedWorld(page, '() => 1', [], 100);
      const outcome = pending.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(await outcome).toBe('In-page call timed out after 100ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves before timeoutMs when the page answers', async () => {
    const { page } = createPage(() => ({ result: { value: 'quick' } }));

    expect(await callInIsolatedWorld(page, '() => 1', [], 1_000)).toBe('quick');
  });
});
