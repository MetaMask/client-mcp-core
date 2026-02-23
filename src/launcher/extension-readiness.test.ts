/**
 * Unit tests for extension-readiness.ts
 *
 * Tests extension UI readiness detection with selector matching and error handling.
 */

import type { Page } from '@playwright/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { waitForExtensionUiReady } from './extension-readiness.js';
import type {
  ExtensionReadinessDeps,
  ExtensionReadinessConfig,
} from './extension-readiness.js';

const testConfig: ExtensionReadinessConfig = {
  readySelectors: ['[data-testid="ready"]', '[data-testid="fallback-ready"]'],
  expectedStatesDescription: 'custom ready state',
};

function createMockLog() {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

function createMockPage(
  options: {
    waitForSelectorResolves?: boolean;
    waitForSelectorError?: Error;
    url?: string;
  } = {},
): Page {
  const {
    waitForSelectorResolves = true,
    waitForSelectorError,
    url = 'chrome-extension://test/home.html',
  } = options;

  const page = {
    waitForSelector: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
  };

  if (waitForSelectorError) {
    page.waitForSelector.mockRejectedValue(waitForSelectorError);
  } else if (waitForSelectorResolves) {
    page.waitForSelector.mockResolvedValue({});
  } else {
    page.waitForSelector.mockRejectedValue(new Error('Timeout'));
  }

  return page as unknown as Page;
}

describe('extension-readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitForExtensionUiReady', () => {
    describe('success paths', () => {
      it('resolves when first selector matches', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await waitForExtensionUiReady(deps, testConfig);

        expect(log.info).toHaveBeenCalledWith('Extension UI is ready');
      });

      it('uses provided config selectors', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await waitForExtensionUiReady(deps, testConfig);

        expect(page.waitForSelector).toHaveBeenCalled();
        const { calls } = (page.waitForSelector as ReturnType<typeof vi.fn>)
          .mock;
        const selectors = calls.map((call: unknown[]) => call[0]);
        expect(selectors).toContain('[data-testid="ready"]');
      });

      it('uses custom config selectors', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };
        const config: ExtensionReadinessConfig = {
          readySelectors: ['[data-testid="custom-selector"]', '.my-class'],
        };

        await waitForExtensionUiReady(deps, config);

        const { calls } = (page.waitForSelector as ReturnType<typeof vi.fn>)
          .mock;
        const selectors = calls.map((call: unknown[]) => call[0]);
        expect(selectors).toContain('[data-testid="custom-selector"]');
        expect(selectors).toContain('.my-class');
      });

      it('uses custom timeout', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await waitForExtensionUiReady(deps, testConfig, 60000);

        const { calls } = (page.waitForSelector as ReturnType<typeof vi.fn>)
          .mock;
        expect(calls[0][1]).toStrictEqual({ timeout: 60000 });
      });

      it('uses default timeout of 30000ms', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await waitForExtensionUiReady(deps, testConfig);

        const { calls } = (page.waitForSelector as ReturnType<typeof vi.fn>)
          .mock;
        expect(calls[0][1]).toStrictEqual({ timeout: 30000 });
      });

      it('races multiple selectors - first match wins', async () => {
        const page = createMockPage();
        let resolveCount = 0;
        (page.waitForSelector as ReturnType<typeof vi.fn>).mockImplementation(
          async () => {
            resolveCount += 1;
            if (resolveCount === 1) {
              return {};
            }
            return new Promise(() => {});
          },
        );
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };
        const config: ExtensionReadinessConfig = {
          readySelectors: ['#first', '#second', '#third'],
        };

        await waitForExtensionUiReady(deps, config);

        expect(log.info).toHaveBeenCalledWith('Extension UI is ready');
      });
    });

    describe('error paths', () => {
      it('throws when no ready selectors are configured', async () => {
        const page = createMockPage({ waitForSelectorResolves: true });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await expect(
          waitForExtensionUiReady(deps, { readySelectors: [] }),
        ).rejects.toThrowError(/must include at least one ready selector/u);
      });

      it('throws error with debug screenshot when no selector matches', async () => {
        const page = createMockPage({
          waitForSelectorResolves: false,
          url: 'chrome-extension://testid/popup.html',
        });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/test-screenshots',
          log,
        };
        const config: ExtensionReadinessConfig = {
          readySelectors: ['[data-testid="test"]'],
          expectedStatesDescription: 'test ready state',
        };

        await expect(
          waitForExtensionUiReady(deps, config, 5000),
        ).rejects.toThrowError(
          /Extension UI did not reach expected state within 5000ms/u,
        );

        expect(page.screenshot).toHaveBeenCalledWith({
          path: expect.stringMatching(/ui-ready-failure-\d+\.png$/u),
          fullPage: true,
        });
        expect(log.error).toHaveBeenCalledWith(
          expect.stringMatching(/Debug screenshot saved:/u),
        );
      });

      it('includes current URL in error message', async () => {
        const page = createMockPage({
          waitForSelectorResolves: false,
          url: 'chrome-extension://testid/onboarding.html',
        });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };

        await expect(
          waitForExtensionUiReady(deps, testConfig),
        ).rejects.toThrowError(
          /Current URL: chrome-extension:\/\/testid\/onboarding\.html/u,
        );
      });

      it('includes expected states description in error message', async () => {
        const page = createMockPage({ waitForSelectorResolves: false });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };
        const config: ExtensionReadinessConfig = {
          readySelectors: ['#test'],
          expectedStatesDescription: 'custom expected state',
        };

        await expect(
          waitForExtensionUiReady(deps, config),
        ).rejects.toThrowError(/Expected: custom expected state/u);
      });

      it('uses fallback description when not provided', async () => {
        const page = createMockPage({ waitForSelectorResolves: false });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/tmp/screenshots',
          log,
        };
        const config: ExtensionReadinessConfig = {
          readySelectors: ['#test'],
        };

        await expect(
          waitForExtensionUiReady(deps, config),
        ).rejects.toThrowError(/Expected: one of the expected ready states/u);
      });

      it('saves screenshot to correct directory with timestamp', async () => {
        const page = createMockPage({ waitForSelectorResolves: false });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/custom/screenshot/path',
          log,
        };

        await expect(
          waitForExtensionUiReady(deps, testConfig),
        ).rejects.toThrowError(
          /Extension UI did not reach expected state within 30000ms./u,
        );

        expect(page.screenshot).toHaveBeenCalledWith({
          path: expect.stringMatching(
            /^\/custom\/screenshot\/path\/ui-ready-failure-\d+\.png$/u,
          ),
          fullPage: true,
        });
      });

      it('includes screenshot path in error message', async () => {
        const page = createMockPage({ waitForSelectorResolves: false });
        const log = createMockLog();
        const deps: ExtensionReadinessDeps = {
          page,
          screenshotDir: '/screenshots',
          log,
        };

        await expect(
          waitForExtensionUiReady(deps, testConfig),
        ).rejects.toThrowError(/Debug screenshot saved to:/u);
      });
    });
  });
});
