import { describe, it, expect, vi, afterEach } from 'vitest';

import { PlaywrightPlatformDriver } from './playwright-driver.js';
import type { IPlatformDriver } from './types.js';
import { createMockSessionManager } from '../tools/test-utils/mock-factories.js';
import * as discoveryModule from '../tools/utils/discovery.js';
import * as inspectModule from '../tools/utils/inspect.js';

function createMockLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue('Hello World'),
    isEditable: vi.fn().mockResolvedValue(true),
    isDisabled: vi.fn().mockResolvedValue(false),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPage() {
  return {
    url: vi.fn().mockReturnValue('chrome-extension://abc/home.html'),
    locator: vi.fn(() => createMockLocator()),
    isClosed: vi.fn(() => false),
  };
}

function createDriver(
  pageOverride?: object,
  sessionOverride?: object,
): IPlatformDriver {
  const page = (pageOverride ?? createMockPage()) as any;
  const sessionManager = (sessionOverride ??
    createMockSessionManager({ hasActive: true })) as any;
  return new PlaywrightPlatformDriver(() => page, sessionManager);
}

describe('PlaywrightPlatformDriver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPlatform', () => {
    it('returns browser', () => {
      const driver = createDriver();
      expect(driver.getPlatform()).toBe('browser');
    });
  });

  describe('getCurrentUrl', () => {
    it('returns the page URL', () => {
      const page = createMockPage();
      const driver = createDriver(page);
      expect(driver.getCurrentUrl()).toBe('chrome-extension://abc/home.html');
      expect(page.url).toHaveBeenCalledOnce();
    });
  });

  describe('click', () => {
    it('delegates to waitForTarget and locator.click', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      const result = await driver.click(
        'testId',
        'submit-btn',
        new Map(),
        5000,
      );

      expect(result.clicked).toBe(true);
      expect(result.target).toBe('testId:submit-btn');
      expect(locator.click).toHaveBeenCalledOnce();
    });

    it('passes within scope to waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.click('testId', 'btn', new Map(), 5000, {
        type: 'testId',
        value: 'parent-container',
      });

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        expect.anything(),
        'testId',
        'btn',
        expect.any(Map),
        5000,
        { type: 'testId', value: 'parent-container' },
      );
    });

    it('throws timeout error when waitForTarget times out', async () => {
      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout 5000ms exceeded waiting for element'),
      );

      const driver = createDriver();
      await expect(
        driver.click('testId', 'missing', new Map(), 5000),
      ).rejects.toThrowError('Timeout 5000ms exceeded');
    });

    it('returns pageClosedAfterClick when page closes during click', async () => {
      const locator = createMockLocator();
      const pageClosedError = new Error(
        'Target page, context or browser has been closed',
      );
      locator.click.mockRejectedValue(pageClosedError);
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      const result = await driver.click('testId', 'close-btn', new Map(), 5000);

      expect(result.clicked).toBe(true);
      expect(result.pageClosedAfterClick).toBe(true);
    });

    it('throws on non-page-closed errors', async () => {
      const locator = createMockLocator();
      locator.click.mockRejectedValue(new Error('Element detached'));
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await expect(
        driver.click('testId', 'btn', new Map(), 5000),
      ).rejects.toThrowError('Element detached');
    });

    it('throws when budget exhausted by waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(6000);

      const driver = createDriver();
      await expect(
        driver.click('testId', 'btn', new Map(), 5),
      ).rejects.toThrowError('visibility wait consumed entire budget');
      expect(locator.click).not.toHaveBeenCalled();
    });
  });

  describe('abort during the target wait', () => {
    it('does not click when the signal aborts while waiting', async () => {
      const locator = createMockLocator();
      const controller = new AbortController();
      const reason = new Error('Tool execution timed out after 30000ms');
      vi.spyOn(discoveryModule, 'waitForTarget').mockImplementation(
        async () => {
          controller.abort(reason);
          return locator as any;
        },
      );

      const driver = createDriver();
      await expect(
        driver.click(
          'testId',
          'confirm',
          new Map(),
          5000,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(locator.click).not.toHaveBeenCalled();
    });

    it('does not type when the signal aborts while waiting', async () => {
      const locator = createMockLocator();
      const controller = new AbortController();
      vi.spyOn(discoveryModule, 'waitForTarget').mockImplementation(
        async () => {
          controller.abort(new Error('timed out'));
          return locator as any;
        },
      );

      const driver = createDriver();
      await expect(
        driver.type(
          'testId',
          'input',
          'text',
          new Map(),
          5000,
          undefined,
          controller.signal,
        ),
      ).rejects.toThrowError('timed out');
      expect(locator.fill).not.toHaveBeenCalled();
    });

    it('clicks when the signal is not aborted', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.click(
        'testId',
        'btn',
        new Map(),
        5000,
        undefined,
        new AbortController().signal,
      );
      expect(locator.click).toHaveBeenCalled();
    });
  });

  describe('type', () => {
    it('delegates to waitForTarget and locator.fill', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      const result = await driver.type(
        'testId',
        'email-input',
        'user@test.com',
        new Map(),
        5000,
      );

      expect(result.typed).toBe(true);
      expect(result.textLength).toBe(13);
      expect(locator.fill).toHaveBeenCalledWith(
        'user@test.com',
        expect.any(Object),
      );
    });

    it('passes within scope to waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.type('testId', 'input', 'text', new Map(), 5000, {
        type: 'a11yRef',
        value: 'e5',
      });

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        expect.anything(),
        'testId',
        'input',
        expect.any(Map),
        5000,
        { type: 'a11yRef', value: 'e5' },
      );
    });

    it('throws when budget exhausted by waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(6000);

      const driver = createDriver();
      await expect(
        driver.type('testId', 'input', 'text', new Map(), 5),
      ).rejects.toThrowError('visibility wait consumed entire budget');
      expect(locator.fill).not.toHaveBeenCalled();
    });

    it('checks that the element is editable before filling it', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(1000);

      const driver = createDriver();
      await driver.type('testId', 'input', 'text', new Map(), 5000);

      expect(locator.isEditable).toHaveBeenCalledWith({ timeout: 5000 });
      expect(locator.fill).toHaveBeenCalledWith('text', { timeout: 5000 });
    });

    it('fails fast without filling a read-only element', async () => {
      const locator = createMockLocator();
      locator.isEditable.mockResolvedValue(false);
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await expect(
        driver.type('testId', 'address', 'text', new Map(), 5000),
      ).rejects.toThrowError(
        'element is not editable (readonly): testId:address',
      );
      expect(locator.fill).not.toHaveBeenCalled();
    });

    it('fails fast without filling a disabled element', async () => {
      const locator = createMockLocator();
      locator.isEditable.mockResolvedValue(false);
      locator.isDisabled.mockResolvedValue(true);
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await expect(
        driver.type('testId', 'address', 'text', new Map(), 5000),
      ).rejects.toThrowError(
        'element is not editable (disabled): testId:address',
      );
      expect(locator.fill).not.toHaveBeenCalled();
    });
  });

  describe('inspect', () => {
    const inspection = {
      tagName: 'input',
      attributes: { 'data-testid': 'nickname' },
      disabled: false,
      readOnly: false,
      styles: { color: 'rgb(18, 18, 18)' },
      effectiveOpacity: 1,
    };

    it('inspects the target with the remaining budget', async () => {
      const page = createMockPage();
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );
      const inspectSpy = vi
        .spyOn(inspectModule, 'inspectLocator')
        .mockResolvedValue(inspection);
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(1200);

      const driver = createDriver(page);
      const result = await driver.inspect?.(
        'testId',
        'nickname',
        new Map(),
        5000,
        ['color'],
        { type: 'testId', value: 'form' },
      );

      expect(result).toStrictEqual({
        target: 'testId:nickname',
        ...inspection,
      });
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        page,
        'testId',
        'nickname',
        expect.any(Map),
        5000,
        { type: 'testId', value: 'form' },
      );
      expect(inspectSpy).toHaveBeenCalledWith(page, locator, ['color'], 4800);
    });

    it('throws when budget exhausted by waitForTarget', async () => {
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        createMockLocator() as any,
      );
      const inspectSpy = vi.spyOn(inspectModule, 'inspectLocator');
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(6000);

      const driver = createDriver();
      await expect(
        driver.inspect?.('testId', 'el', new Map(), 5, []),
      ).rejects.toThrowError('visibility wait consumed entire budget');
      expect(inspectSpy).not.toHaveBeenCalled();
    });
  });

  describe('waitForElement', () => {
    it('delegates to waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.waitForElement('testId', 'loading', new Map(), 5000);

      expect(discoveryModule.waitForTarget).toHaveBeenCalledOnce();
    });
  });

  describe('scrollToElement', () => {
    it('waits for the target within the scope, then scrolls it into view', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.scrollToElement?.(
        'testId',
        'row',
        new Map(),
        undefined,
        undefined,
        5000,
        { type: 'testId', value: 'list' },
      );

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        expect.anything(),
        'testId',
        'row',
        expect.any(Map),
        5000,
        { type: 'testId', value: 'list' },
      );
      expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledWith({
        timeout: expect.any(Number),
      });
    });

    it('defaults to the interaction timeout', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      await driver.scrollToElement?.('testId', 'row', new Map());

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        expect.anything(),
        'testId',
        'row',
        expect.any(Map),
        15000,
        undefined,
      );
    });

    it('throws when budget exhausted by waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(6000);

      const driver = createDriver();
      await expect(
        driver.scrollToElement?.(
          'testId',
          'row',
          new Map(),
          undefined,
          undefined,
          5,
        ),
      ).rejects.toThrowError('visibility wait consumed entire budget');
      expect(locator.scrollIntoViewIfNeeded).not.toHaveBeenCalled();
    });
  });

  describe('getText', () => {
    it('returns text content from locator', async () => {
      const locator = createMockLocator();
      locator.textContent.mockResolvedValue('Balance: $100');
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      const result = await driver.getText('testId', 'balance', new Map(), 5000);

      expect(result.text).toBe('Balance: $100');
      expect(result).toHaveLength(13);
    });

    it('returns empty string when textContent is null', async () => {
      const locator = createMockLocator();
      locator.textContent.mockResolvedValue(null);
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const driver = createDriver();
      const result = await driver.getText('testId', 'empty', new Map(), 5000);

      expect(result.text).toBe('');
      expect(result).toHaveLength(0);
    });

    it('throws when budget exhausted by waitForTarget', async () => {
      const locator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        locator as any,
      );

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(6000);

      const driver = createDriver();
      await expect(
        driver.getText('testId', 'el', new Map(), 5),
      ).rejects.toThrowError('visibility wait consumed entire budget');
      expect(locator.textContent).not.toHaveBeenCalled();
    });
  });

  describe('getAccessibilityTree', () => {
    it('delegates to collectTrimmedA11ySnapshot', async () => {
      const mockNodes = [
        { ref: 'e1', role: 'button', name: 'Submit', path: [] },
      ];
      const mockRefMap = new Map([['e1', 'role=button[name="Submit"]']]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        { nodes: mockNodes, refMap: mockRefMap } as any,
      );

      const driver = createDriver();
      const { nodes, refMap } = await driver.getAccessibilityTree();

      expect(nodes).toStrictEqual(mockNodes);
      expect(refMap).toBe(mockRefMap);
    });

    it('passes rootSelector to collectTrimmedA11ySnapshot', async () => {
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        { nodes: [], refMap: new Map() } as any,
      );

      const driver = createDriver();
      await driver.getAccessibilityTree('#main-content');

      expect(discoveryModule.collectTrimmedA11ySnapshot).toHaveBeenCalledWith(
        expect.anything(),
        '#main-content',
      );
    });
  });

  describe('getTestIds', () => {
    it('delegates to collectTestIds', async () => {
      const mockItems = [{ testId: 'submit', tag: 'button', visible: true }];
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(
        mockItems as any,
      );

      const driver = createDriver();
      const items = await driver.getTestIds(50);

      expect(items).toStrictEqual(mockItems);
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        expect.anything(),
        50,
      );
    });
  });

  describe('screenshot', () => {
    it('delegates to sessionManager.screenshot', async () => {
      const mockResult = {
        path: '/tmp/ss.png',
        base64: 'abc',
        width: 800,
        height: 600,
      };
      const sessionManager = createMockSessionManager({ hasActive: true });
      vi.spyOn(sessionManager, 'screenshot').mockResolvedValue(mockResult);

      const driver = new PlaywrightPlatformDriver(
        () => createMockPage() as any,
        sessionManager as any,
      );

      const result = await driver.screenshot({ name: 'test', fullPage: true });

      expect(result).toStrictEqual(mockResult);
      expect(sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'test',
        fullPage: true,
        selector: undefined,
      });
    });
  });

  describe('getAppState', () => {
    it('delegates to sessionManager.getExtensionState', async () => {
      const mockState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://abc/home.html',
        extensionId: 'abc',
        isUnlocked: true,
        currentScreen: 'home',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      };
      const sessionManager = createMockSessionManager({ hasActive: true });
      vi.spyOn(sessionManager, 'getExtensionState').mockResolvedValue(
        mockState,
      );

      const driver = new PlaywrightPlatformDriver(
        () => createMockPage() as any,
        sessionManager as any,
      );

      const state = await driver.getAppState();

      expect(state).toStrictEqual(mockState);
    });
  });

  describe('cdp', () => {
    const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
    const SW_URL = `chrome-extension://${EXTENSION_ID}/background.js`;

    function createCdpPage(
      cdpSession: {
        send: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
      },
      contextOverride: Record<string, unknown> = {},
    ) {
      const context = {
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
        pages: vi.fn(() => [
          { url: () => `chrome-extension://${EXTENSION_ID}/home.html` },
        ]),
        serviceWorkers: vi.fn(() => []),
        on: vi.fn(),
        off: vi.fn(),
        browser: vi.fn(() => null),
        ...contextOverride,
      };
      return {
        url: vi
          .fn()
          .mockReturnValue(`chrome-extension://${EXTENSION_ID}/home.html`),
        context: vi.fn().mockReturnValue(context),
        contextMock: context,
      };
    }

    const TIMEOUT_MS = 30_000;

    it('sends a CDP command and returns the raw result', async () => {
      const cdpResult = { result: { value: 'My Page Title' } };
      const cdpSession = {
        send: vi.fn().mockResolvedValue(cdpResult),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const driver = createDriver(createCdpPage(cdpSession));

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        params: { expression: 'document.title', returnByValue: true },
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome).toStrictEqual({ ok: true, result: cdpResult });
      expect(cdpSession.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      expect(cdpSession.detach).not.toHaveBeenCalled();
    });

    it('reuses one persistent session across calls (AC1)', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ ok: true }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const page = createCdpPage(cdpSession);
      const driver = createDriver(page);

      await driver.cdp({ method: 'Runtime.enable', timeoutMs: TIMEOUT_MS });
      await driver.cdp({
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        timeoutMs: TIMEOUT_MS,
      });

      expect(page.contextMock.newCDPSession).toHaveBeenCalledTimes(1);
      expect(cdpSession.send).toHaveBeenCalledTimes(2);
    });

    it('detaches the persistent session on dispose', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ ok: true }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const driver = createDriver(createCdpPage(cdpSession));

      await driver.cdp({ method: 'Runtime.enable', timeoutMs: TIMEOUT_MS });
      await driver.dispose?.();

      expect(cdpSession.detach).toHaveBeenCalledTimes(1);
    });

    it('uses a one-shot session with fresh and detaches it', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ ok: true }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const page = createCdpPage(cdpSession);
      const driver = createDriver(page);

      await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: TIMEOUT_MS,
        fresh: true,
      });
      await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: TIMEOUT_MS,
        fresh: true,
      });

      expect(page.contextMock.newCDPSession).toHaveBeenCalledTimes(2);
      expect(cdpSession.detach).toHaveBeenCalledTimes(2);
    });

    it('sends a CDP command with no params', async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const driver = createDriver(createCdpPage(cdpSession));

      const outcome = await driver.cdp({
        method: 'Network.enable',
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome.ok).toBe(true);
      expect(cdpSession.send).toHaveBeenCalledWith('Network.enable', {});
    });

    it.each(['hermes', 'android-webview'] as const)(
      'rejects the mobile-only target %s with MM_INVALID_INPUT',
      async (target) => {
        const cdpSession = { send: vi.fn(), detach: vi.fn() };
        const page = createCdpPage(cdpSession);
        const driver = createDriver(page);

        const outcome = await driver.cdp({
          method: 'Runtime.evaluate',
          timeoutMs: TIMEOUT_MS,
          target,
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.code).toBe('MM_INVALID_INPUT');
          expect(outcome.message).toContain(target);
          expect(outcome.message).toContain('Browser targets: page, sw');
        }
        expect(page.contextMock.newCDPSession).not.toHaveBeenCalled();
      },
    );

    it('sends --target sw to the extension service worker', async () => {
      const listeners = new Map<string, Set<(payload: never) => void>>();
      const browserSession = {
        send: vi.fn(
          async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Target.getTargets') {
              return {
                targetInfos: [
                  { type: 'service_worker', url: SW_URL, targetId: 'target-1' },
                ],
              };
            }
            if (method === 'Target.attachToTarget') {
              return { sessionId: 'session-1' };
            }
            if (method === 'Target.sendMessageToTarget') {
              const message = JSON.parse(String(params?.message)) as {
                id: number;
              };
              for (const listener of listeners.get(
                'Target.receivedMessageFromTarget',
              ) ?? []) {
                listener({
                  sessionId: 'session-1',
                  message: JSON.stringify({
                    id: message.id,
                    result: { result: { value: 'object' } },
                  }),
                } as never);
              }
            }
            return {};
          },
        ),
        detach: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, listener: (payload: never) => void) => {
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(listener);
        }),
        off: vi.fn((event: string, listener: (payload: never) => void) => {
          listeners.get(event)?.delete(listener);
        }),
      };
      const page = createCdpPage(
        { send: vi.fn(), detach: vi.fn() },
        {
          serviceWorkers: vi.fn(() => [{ url: vi.fn(() => SW_URL) }]),
          browser: vi.fn(() => ({
            newBrowserCDPSession: vi.fn().mockResolvedValue(browserSession),
          })),
        },
      );
      const driver = createDriver(page);

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        params: { expression: 'typeof globalThis.stateHooks' },
        timeoutMs: TIMEOUT_MS,
        target: 'sw',
      });

      expect(outcome).toStrictEqual({
        ok: true,
        result: { result: { value: 'object' } },
      });
      expect(page.contextMock.newCDPSession).not.toHaveBeenCalled();
      expect(browserSession.send).toHaveBeenCalledWith(
        'Target.attachToTarget',
        {
          targetId: 'target-1',
          flatten: false,
        },
      );
    });

    it.each([
      'Browser.close',
      'Target.closeTarget',
      'Target.disposeBrowserContext',
      'Browser.crashGpuProcess',
    ])('blocks %s with MM_CDP_BLOCKED', async (method) => {
      const cdpSession = { send: vi.fn(), detach: vi.fn() };
      const driver = createDriver(createCdpPage(cdpSession));

      const outcome = await driver.cdp({ method, timeoutMs: TIMEOUT_MS });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_CDP_BLOCKED');
        expect(outcome.message).toContain(method);
      }
      expect(cdpSession.send).not.toHaveBeenCalled();
    });

    it('returns MM_CDP_FAILED on CDP error and keeps the session', async () => {
      const cdpSession = {
        send: vi
          .fn()
          .mockRejectedValue(new Error('Protocol error: method not found')),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const driver = createDriver(createCdpPage(cdpSession));

      const outcome = await driver.cdp({
        method: 'Nonexistent.method',
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_CDP_FAILED');
        expect(outcome.message).toContain('Nonexistent.method');
        expect(outcome.message).toContain('Protocol error');
      }
      expect(cdpSession.detach).not.toHaveBeenCalled();
    });

    it('returns MM_CDP_FAILED for non-Error throwables', async () => {
      const cdpSession = {
        send: vi.fn().mockRejectedValue('string error'),
        detach: vi.fn().mockResolvedValue(undefined),
      };
      const driver = createDriver(createCdpPage(cdpSession));

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_CDP_FAILED');
        expect(outcome.message).toContain('string error');
      }
    });

    it('times out long-running CDP calls', async () => {
      vi.useFakeTimers();
      try {
        const cdpSession = {
          send: vi.fn().mockReturnValue(new Promise(() => {})),
          detach: vi.fn().mockResolvedValue(undefined),
        };
        const driver = createDriver(createCdpPage(cdpSession));

        const outcomePromise = driver.cdp({
          method: 'Runtime.evaluate',
          timeoutMs: 5_000,
        });

        await vi.advanceTimersByTimeAsync(5_000);
        const outcome = await outcomePromise;

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.code).toBe('MM_CDP_FAILED');
          expect(outcome.message).toContain('timed out');
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
