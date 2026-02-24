import type { Page } from '@playwright/test';
import path from 'path';

export type ExtensionReadinessDeps = {
  page: Page;
  screenshotDir: string;
  log: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
};

/**
 * Configuration for extension readiness detection.
 * Allows different extensions to specify their own UI ready selectors.
 */
export type ExtensionReadinessConfig = {
  /**
   * CSS selectors that indicate the extension UI is ready.
   * The function waits for ANY of these selectors to appear.
   */
  readySelectors: string[];
  /**
   * Human-readable description of expected states for error messages.
   */
  expectedStatesDescription?: string;
};

/**
 * Wait for the extension UI to be ready by checking for expected selectors.
 *
 * @param deps - Dependencies including page, screenshot directory, and logger
 * @param config - Configuration with ready selectors to wait for
 * @param timeout - Maximum time to wait in milliseconds (default: 30000)
 */
export async function waitForExtensionUiReady(
  deps: ExtensionReadinessDeps,
  config: ExtensionReadinessConfig,
  timeout = 30000,
): Promise<void> {
  const { page, screenshotDir, log } = deps;
  const { readySelectors, expectedStatesDescription } = config;

  if (readySelectors.length === 0) {
    throw new Error(
      'Extension readiness config must include at least one ready selector.',
    );
  }

  try {
    await Promise.race(
      readySelectors.map(async (selector) =>
        page.waitForSelector(selector, { timeout }),
      ),
    );
    log.info('Extension UI is ready');
  } catch {
    const currentUrl = page.url();
    const screenshotPath = path.join(
      screenshotDir,
      `ui-ready-failure-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.error(`Debug screenshot saved: ${screenshotPath}`);

    const expectedStates =
      expectedStatesDescription ?? 'one of the expected ready states';

    throw new Error(
      `Extension UI did not reach expected state within ${timeout}ms. ` +
        `Current URL: ${currentUrl}. ` +
        `Expected: ${expectedStates}. ` +
        `Debug screenshot saved to: ${screenshotPath}`,
    );
  }
}
