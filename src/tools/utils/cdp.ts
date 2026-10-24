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
 * Error thrown when the node of a backend node id cannot be resolved (it
 * left the DOM, or the page navigated). The session and world stay valid.
 */
class NodeNotFoundError extends Error {}

/**
 * Runs a step on the page's cached session and isolated world, creating
 * them on first use. On a session or world failure (closed session, world
 * gone after a navigation), drops them so the next call starts over.
 * Errors from the page function (`InPageError`) and unresolvable nodes
 * (`NodeNotFoundError`) keep them.
 *
 * @param page - The page.
 * @param step - The CDP work, given the session and world context id.
 * @returns The step's result.
 */
async function inIsolatedWorld<TResult>(
  page: Page,
  step: (session: CDPSession, executionContextId: number) => Promise<TResult>,
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
    return await step(session, await current.contextId);
  } catch (error) {
    if (
      !(error instanceof InPageError) &&
      !(error instanceof NodeNotFoundError)
    ) {
      // The session closed or the world went away (navigation): start
      // over on the next call.
      resetIsolatedWorld(page, current);
    }
    throw error;
  }
}

/**
 * Runs `inIsolatedWorld` and, after a session or world failure, once more
 * on a new session and world.
 *
 * @param page - The page.
 * @param step - The CDP work, given the session and world context id.
 * @returns The step's result.
 */
async function inIsolatedWorldWithRetry<TResult>(
  page: Page,
  step: (session: CDPSession, executionContextId: number) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await inIsolatedWorld(page, step);
  } catch (error) {
    if (error instanceof InPageError || error instanceof NodeNotFoundError) {
      throw error;
    }
    return await inIsolatedWorld(page, step);
  }
}

type CallFunctionOnResponse = {
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
};

/**
 * Throws the page exception of a `Runtime.callFunctionOn` response.
 *
 * @param response - The response (`exceptionDetails` is set when the
 * function threw).
 */
function throwOnException(response: CallFunctionOnResponse): void {
  if (response.exceptionDetails) {
    throw new InPageError(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text,
    );
  }
}

/**
 * Wraps function source so it runs in the page. Tools such as esbuild/tsx
 * with keepNames add `__name(...)` calls to function source; define it so
 * such source still runs.
 *
 * @param functionDeclaration - Source text of the function.
 * @returns The wrapped source.
 */
function wrapDeclaration(functionDeclaration: string): string {
  return `function () {
    var __name = function (fn) { return fn; };
    return (${functionDeclaration}).apply(this, arguments);
  }`;
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
  const declaration = wrapDeclaration(functionDeclaration);
  const call = inIsolatedWorldWithRetry(
    page,
    async (session, executionContextId) => {
      const response = await session.send('Runtime.callFunctionOn', {
        functionDeclaration: declaration,
        executionContextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      throwOnException(response);
      return response.result.value as TResult;
    },
  );
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

let nodeCallCounter = 0;

/**
 * Calls a function with a DOM node as `this`, in the isolated world of the
 * page's main frame (see `callInIsolatedWorld`), and returns its JSON
 * result. Runs on the cached session: `DOM.resolveNode` with the world's
 * context id, then `Runtime.callFunctionOn` on the node object, then
 * releases the object. Backend node ids are per renderer, so ids read on
 * another CDP session of the same page are valid here.
 *
 * Retries once on a new session and world after a session or world
 * failure. Rejects without retrying when the node cannot be resolved (it
 * left the DOM) or when the function throws in the page.
 *
 * @param page - The Playwright page.
 * @param backendNodeId - The backend DOM node id of the node.
 * @param functionDeclaration - Source text of the function (self-contained,
 * JSON-serializable result).
 * @returns The function's return value.
 */
export async function callOnNodeInIsolatedWorld<TResult>(
  page: Page,
  backendNodeId: number,
  functionDeclaration: string,
): Promise<TResult> {
  const declaration = wrapDeclaration(functionDeclaration);
  return inIsolatedWorldWithRetry(page, async (session, executionContextId) => {
    nodeCallCounter += 1;
    const objectGroup = `mm-node-${nodeCallCounter}`;
    let objectId: string | undefined;
    try {
      ({
        object: { objectId },
      } = await session.send('DOM.resolveNode', {
        backendNodeId,
        executionContextId,
        objectGroup,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\bnode\b/iu.test(message)) {
        throw new NodeNotFoundError(message);
      }
      throw error;
    }
    try {
      if (!objectId) {
        throw new NodeNotFoundError(`No object for node ${backendNodeId}`);
      }
      const response = await session.send('Runtime.callFunctionOn', {
        functionDeclaration: declaration,
        objectId,
        returnByValue: true,
      });
      throwOnException(response);
      return response.result.value as TResult;
    } finally {
      await session
        .send('Runtime.releaseObjectGroup', { objectGroup })
        .catch(() => undefined);
    }
  });
}
