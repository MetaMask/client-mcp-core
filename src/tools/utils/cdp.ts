import type { Page, CDPSession } from '@playwright/test';

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
