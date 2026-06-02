import { describe, it, expect, vi, afterEach } from 'vitest';

import { PlaywrightPlatformDriver } from './playwright-driver.js';
import type { IPlatformDriver } from './types.js';
import { createMockSessionManager } from '../tools/test-utils/mock-factories.js';
import * as discoveryModule from '../tools/utils/discovery.js';

function createMockLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue('Hello World'),
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
});
