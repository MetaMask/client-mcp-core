/**
 * Unit tests for extension-id-resolver.ts
 *
 * Tests extension ID resolution via service workers and chrome://extensions fallback.
 */

import type { BrowserContext, Page } from '@playwright/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  resolveExtensionId,
  DEFAULT_EXTENSION_ID_CONFIG,
} from './extension-id-resolver.js';
import type { ExtensionIdResolverConfig } from './extension-id-resolver.js';

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createMockServiceWorker(url: string) {
  return {
    url: vi.fn().mockReturnValue(url),
  };
}

function createMockPage(
  options: {
    readyResults?: boolean[];
    extensionId?: string | undefined;
    gotoError?: Error;
    evaluateError?: Error;
  } = {},
) {
  const {
    readyResults = [true],
    extensionId = undefined,
    gotoError,
    evaluateError,
  } = options;
  let evaluateCallIndex = 0;

  const page = {
    goto: gotoError
      ? vi.fn().mockRejectedValue(gotoError)
      : vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async () => {
      const callIndex = evaluateCallIndex;
      evaluateCallIndex += 1;

      if (evaluateError) {
        throw evaluateError;
      }

      // readyResults determine waitForExtensionsPageReady behavior
      // Once all readyResults used, return extensionId for findExtension call
      if (callIndex < readyResults.length) {
        return readyResults[callIndex];
      }
      return extensionId;
    }),
    url: vi.fn().mockReturnValue('chrome://extensions'),
  };

  return page as unknown as Page;
}

function createMockContext(
  options: {
    existingWorkers?: { url: () => string }[];
    newWorker?: { url: () => string } | null;
    pages?: Page[];
    waitForEventError?: Error;
  } = {},
) {
  const context = {
    serviceWorkers: vi.fn().mockReturnValue(options.existingWorkers ?? []),
    waitForEvent: vi.fn(),
    pages: vi.fn().mockReturnValue(options.pages ?? []),
    newPage: vi.fn(),
  };

  if (options.waitForEventError) {
    context.waitForEvent.mockRejectedValue(options.waitForEventError);
  } else if (options.newWorker === null) {
    context.waitForEvent.mockResolvedValue(null);
  } else if (options.newWorker) {
    context.waitForEvent.mockResolvedValue(options.newWorker);
  } else {
    context.waitForEvent.mockResolvedValue(null);
  }

  return context as unknown as BrowserContext;
}

describe('extension-id-resolver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('DEFAULT_EXTENSION_ID_CONFIG', () => {
    it('has MetaMask as default extension name pattern', () => {
      expect(DEFAULT_EXTENSION_ID_CONFIG.extensionNamePattern).toBe('MetaMask');
    });
  });

  describe('resolveExtensionId', () => {
    describe('service worker discovery', () => {
      it('returns extension ID from existing service worker', async () => {
        const extensionId = 'abcdefghijklmnopqrstuvwxyzabcdef';
        const worker = createMockServiceWorker(
          `chrome-extension://${extensionId}/background.js`,
        );
        const context = createMockContext({ existingWorkers: [worker] });
        const log = createMockLog();

        const result = await resolveExtensionId({ context, log });

        expect(result).toBe(extensionId);
        expect(log.info).toHaveBeenCalledWith(
          `Found extension ID from existing service worker: ${extensionId}`,
        );
      });

      it('returns extension ID from new service worker event', async () => {
        const extensionId = 'abcdefghijklmnopqrstuvwxyzabcdef';
        const worker = createMockServiceWorker(
          `chrome-extension://${extensionId}/sw.js`,
        );
        const context = createMockContext({
          existingWorkers: [],
          newWorker: worker,
        });
        const log = createMockLog();

        const result = await resolveExtensionId({ context, log });

        expect(result).toBe(extensionId);
        expect(log.info).toHaveBeenCalledWith(
          `Found extension ID from new service worker: ${extensionId}`,
        );
        expect(context.waitForEvent).toHaveBeenCalledWith('serviceworker', {
          timeout: 10000,
        });
      });

      it('skips workers without chrome-extension URL', async () => {
        const worker = createMockServiceWorker('https://example.com/sw.js');
        const page = createMockPage({
          extensionId: 'validextensionidabcdefghijklmnop',
        });
        const context = createMockContext({
          existingWorkers: [worker],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('validextensionidabcdefghijklmnop');
        expect(log.info).toHaveBeenCalledWith(
          'Service worker discovery failed, falling back to chrome://extensions',
        );
      });

      it('skips workers with invalid extension ID format (must be 32 lowercase letters)', async () => {
        const worker = createMockServiceWorker(
          'chrome-extension://INVALID/background.js',
        );
        const page = createMockPage({
          extensionId: 'validextensionidabcdefghijklmnop',
        });
        const context = createMockContext({
          existingWorkers: [worker],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('validextensionidabcdefghijklmnop');
      });

      it('handles service worker error and falls back to extensions page', async () => {
        const page = createMockPage({
          extensionId: 'fallbackextensionidabcdefghijklm',
        });
        const context = createMockContext({
          existingWorkers: [],
          waitForEventError: new Error('Service worker error'),
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('fallbackextensionidabcdefghijklm');
        expect(log.warn).toHaveBeenCalledWith(
          'Service worker extension ID discovery failed:',
          expect.any(Error),
        );
      });

      it('iterates through multiple existing workers to find valid extension ID', async () => {
        const invalidWorker = createMockServiceWorker(
          'https://example.com/sw.js',
        );
        const validExtensionId = 'foundextensionidabcdefghijklmnop';
        const validWorker = createMockServiceWorker(
          `chrome-extension://${validExtensionId}/sw.js`,
        );
        const context = createMockContext({
          existingWorkers: [invalidWorker, validWorker],
        });
        const log = createMockLog();

        const result = await resolveExtensionId({ context, log });

        expect(result).toBe(validExtensionId);
      });
    });

    describe('extensions page fallback', () => {
      it('uses existing page if available', async () => {
        const page = createMockPage({
          extensionId: 'existingpageextensionidabcdefgh',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('existingpageextensionidabcdefgh');
        expect(context.newPage).not.toHaveBeenCalled();
      });

      it('creates new page if none exist', async () => {
        const page = createMockPage({
          extensionId: 'newpageextensionidabcdefghijklm',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [],
        });
        (context.newPage as ReturnType<typeof vi.fn>).mockResolvedValue(page);
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('newpageextensionidabcdefghijklm');
        expect(context.newPage).toHaveBeenCalled();
      });

      it('navigates to chrome://extensions', async () => {
        const page = createMockPage({
          extensionId: 'navextensionidabcdefghijklmnopq',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        await promise;

        expect(page.goto).toHaveBeenCalledWith('chrome://extensions');
        expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
      });

      it('uses string pattern for extension name matching', async () => {
        const page = createMockPage({
          extensionId: 'stringpatternextensionidabcdefg',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();
        const config: ExtensionIdResolverConfig = {
          extensionNamePattern: 'MyExtension',
        };

        const promise = resolveExtensionId({ context, log }, config);
        await vi.runAllTimersAsync();
        await promise;

        expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
          pattern: 'MyExtension',
          useRegex: false,
        });
      });

      it('uses regex pattern for extension name matching', async () => {
        const page = createMockPage({
          extensionId: 'regexpatternextensionidabcdefgh',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();
        const config: ExtensionIdResolverConfig = {
          extensionNamePattern: /Meta[Mm]ask/u,
        };

        const promise = resolveExtensionId({ context, log }, config);
        await vi.runAllTimersAsync();
        await promise;

        expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
          pattern: 'Meta[Mm]ask',
          useRegex: true,
        });
      });

      it('returns undefined when extension not found after all retries (no error)', async () => {
        const page = createMockPage();
        let callCount = 0;
        (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(
          async () => {
            callCount += 1;
            if (callCount % 2 === 1) {
              return true;
            }
            return undefined;
          },
        );
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(
          'Extension not found (attempt 1/3), retrying...',
        );
        expect(log.warn).toHaveBeenCalledWith(
          'Extension not found (attempt 2/3), retrying...',
        );
      });

      it('retries on error and succeeds on subsequent attempt', async () => {
        const page = createMockPage();
        let callCount = 0;
        (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(
          async () => {
            callCount += 1;
            // First 2 calls: page ready check + find extension - both fail
            if (callCount <= 2) {
              if (callCount === 1) {
                return true;
              } // Page ready
              throw new Error('First attempt failed');
            }
            // Second attempt: page ready check + find extension - succeeds
            if (callCount === 3) {
              return true;
            } // Page ready
            return 'retrysuccessextensionidabcdefgh';
          },
        );
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('retrysuccessextensionidabcdefgh');
        expect(log.warn).toHaveBeenCalledWith(
          'Error getting extension ID (attempt 1/3):',
          expect.any(Error),
        );
      });

      it('throws error after all retry attempts fail with error', async () => {
        const page = createMockPage({
          evaluateError: new Error('Persistent error'),
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        let caughtError: unknown;
        const promise = resolveExtensionId({ context, log }).catch((error) => {
          caughtError = error;
        });
        await vi.runAllTimersAsync();
        await promise;

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain(
          'Failed to get extension ID after 3 attempts',
        );
      });
    });

    describe('page readiness waiting', () => {
      it('executes page evaluate callbacks for readiness and extension matching', async () => {
        const page = createMockPage({
          extensionId: 'callbackextensionidabcdefghijklmn',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        await promise;

        const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
        const readyEvalFn = evaluateMock.mock.calls.find(
          ([, arg]) => !arg,
        )?.[0] as (() => boolean) | undefined;
        const findExtensionEvalFn = evaluateMock.mock.calls.find(
          ([, arg]) =>
            Boolean(arg) &&
            typeof arg === 'object' &&
            'pattern' in (arg as Record<string, unknown>) &&
            'useRegex' in (arg as Record<string, unknown>),
        )?.[0] as
          | ((args: {
              pattern: string;
              useRegex: boolean;
            }) => string | undefined)
          | undefined;

        expect(readyEvalFn).toBeDefined();
        expect(findExtensionEvalFn).toBeDefined();

        const originalDocument = (globalThis as { document?: unknown })
          .document;
        const restoreDocument = () => {
          (globalThis as { document?: unknown }).document = originalDocument;
        };

        try {
          const managerWithoutShadow = { shadowRoot: null };
          (globalThis as { document: unknown }).document = {
            querySelector: vi.fn().mockReturnValue(managerWithoutShadow),
          };

          expect(readyEvalFn?.()).toBe(false);
          expect(
            findExtensionEvalFn?.({ pattern: 'MetaMask', useRegex: false }),
          ).toBeUndefined();

          const extensionItem = {
            shadowRoot: {
              querySelector: vi
                .fn()
                .mockReturnValue({ textContent: 'MetaMask Dev' }),
            },
            getAttribute: vi
              .fn()
              .mockReturnValue('matchedextensionidabcdefghijklmnop'),
          };
          const itemList = {
            shadowRoot: {
              querySelectorAll: vi.fn().mockReturnValue([extensionItem]),
            },
          };
          const managerWithItems = {
            shadowRoot: {
              querySelector: vi.fn().mockReturnValue(itemList),
            },
          };

          (globalThis as { document: unknown }).document = {
            querySelector: vi.fn().mockReturnValue(managerWithItems),
          };

          expect(readyEvalFn?.()).toBe(true);
          expect(
            findExtensionEvalFn?.({ pattern: 'MetaMask', useRegex: false }),
          ).toBe('matchedextensionidabcdefghijklmnop');
          expect(
            findExtensionEvalFn?.({ pattern: 'Meta[Mm]ask', useRegex: true }),
          ).toBe('matchedextensionidabcdefghijklmnop');
        } finally {
          restoreDocument();
        }
      });

      it('waits for extensions page to be ready with polling', async () => {
        const page = createMockPage({
          readyResults: [false, false, true], // Not ready, not ready, ready
          extensionId: 'readypageextensionidabcdefghijkl',
        });
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        const promise = resolveExtensionId({ context, log });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('readypageextensionidabcdefghijkl');
        expect(
          (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(4);
      });

      it('throws error when page does not become ready after max attempts', async () => {
        const page = createMockPage();
        (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const context = createMockContext({
          existingWorkers: [],
          newWorker: null,
          pages: [page],
        });
        const log = createMockLog();

        let caughtError: unknown;
        const promise = resolveExtensionId({ context, log }).catch((error) => {
          caughtError = error;
        });
        await vi.runAllTimersAsync();
        await promise;

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain(
          'Failed to get extension ID after 3 attempts',
        );
      });
    });
  });
});
