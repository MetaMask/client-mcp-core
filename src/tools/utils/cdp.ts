import type { Page, CDPSession } from '@playwright/test';

/** Name of the isolated world in which in-page functions run. */
export const ISOLATED_WORLD_NAME = '__mm_client_mcp_core__';

/**
 * Opens a short-lived CDP session for a single operation.
 *
 * @param page The Playwright page that owns the CDP target.
 * @param fn The async callback that performs CDP work with the session.
 * @returns The callback result after the session has been detached.
 */
export async function withCdpSession<TResult>(
  page: Page,
  fn: (cdpSession: CDPSession) => Promise<TResult>,
): Promise<TResult> {
  const cdpSession = await page.context().newCDPSession(page);

  try {
    return await fn(cdpSession);
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

type IsolatedWorld = {
  session: Promise<CDPSession>;
  contextId?: Promise<number>;
};

/**
 * One CDP session and isolated world per page, kept between calls. Each
 * `Page.createIsolatedWorld` on a new session adds a JS context to the
 * frame that lives until the next navigation, so creating one per call
 * would pile up contexts on a long-lived extension page.
 */
const isolatedWorlds = new WeakMap<Page, IsolatedWorld>();

/**
 * Error thrown when the in-page function itself threw.
 */
class InPageError extends Error {}

/**
 * Drops the cached session and world of a page.
 *
 * @param page - The page.
 * @param world - The entry to drop (kept when it was already replaced).
 */
function resetIsolatedWorld(page: Page, world: IsolatedWorld): void {
  if (isolatedWorlds.get(page) !== world) {
    return;
  }
  isolatedWorlds.delete(page);
  world.session
    .then(async (session) => session.detach())
    .catch(() => undefined);
}

/**
 * Calls a function once in the page's isolated world.
 *
 * @param page - The page.
 * @param functionDeclaration - Source text of the function.
 * @param args - JSON arguments.
 * @returns The function's JSON result.
 */
async function callOnce<TResult>(
  page: Page,
  functionDeclaration: string,
  args: unknown[],
): Promise<TResult> {
  let world = isolatedWorlds.get(page);
  if (!world) {
    world = { session: page.context().newCDPSession(page) };
    isolatedWorlds.set(page, world);
  }
  const current = world;
  try {
    const session = await current.session;
    current.contextId ??= (async (): Promise<number> => {
      const { frameTree } = await session.send('Page.getFrameTree');
      const { executionContextId } = await session.send(
        'Page.createIsolatedWorld',
        { frameId: frameTree.frame.id, worldName: ISOLATED_WORLD_NAME },
      );
      return executionContextId;
    })();
    const executionContextId = await current.contextId;
    const response = await session.send('Runtime.callFunctionOn', {
      functionDeclaration,
      executionContextId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new InPageError(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value as TResult;
  } catch (error) {
    if (!(error instanceof InPageError)) {
      // The session closed or the world went away (navigation): start
      // over on the next call.
      resetIsolatedWorld(page, current);
    }
    throw error;
  }
}

/**
 * Calls a function in an isolated world of the page's main frame and
 * returns its JSON result (promises are awaited). Steady state is one
 * `Runtime.callFunctionOn`; the session and world are created on first use
 * and again (one retry) after a navigation or a closed session.
 *
 * The isolated world shares the DOM with the page but has its own globals,
 * so it works on pages that lock down their own globals (LavaMoat scuttling
 * on MetaMask Extension pages breaks `page.evaluate` in the main world).
 *
 * `functionDeclaration` is source text, for example `fn.toString()`: the
 * function must be self-contained (no imports, no closures over module
 * scope) and its arguments and result must be JSON-serializable.
 *
 * @param page - The Playwright page.
 * @param functionDeclaration - Source text of the function to call.
 * @param args - Arguments passed to the function.
 * @param timeoutMs - When set, stop waiting after this time and reject.
 * @returns The function's return value.
 */
export async function callInIsolatedWorld<TResult>(
  page: Page,
  functionDeclaration: string,
  args: unknown[] = [],
  timeoutMs?: number,
): Promise<TResult> {
  // Tools such as esbuild/tsx with keepNames add `__name(...)` calls to
  // function source; define it so such source still runs in the page.
  const declaration = `function () {
    var __name = function (fn) { return fn; };
    return (${functionDeclaration}).apply(this, arguments);
  }`;
  const call = (async (): Promise<TResult> => {
    try {
      return await callOnce<TResult>(page, declaration, args);
    } catch (error) {
      if (error instanceof InPageError) {
        throw error;
      }
      return await callOnce<TResult>(page, declaration, args);
    }
  })();
  if (timeoutMs === undefined) {
    return call;
  }
  // A call still pending after the timeout settles later; ignore it.
  call.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`In-page call timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
