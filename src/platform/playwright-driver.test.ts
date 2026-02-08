import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { PlaywrightPlatformDriver } from './playwright-driver.js';
import * as discoveryModule from '../mcp-server/discovery.js';
import * as errorClassificationModule from '../mcp-server/tools/error-classification.js';
import {
  createMockSessionManager,
  createMockPage,
  createMockLocator,
} from '../mcp-server/test-utils';

describe('PlaywrightPlatformDriver', () => {
  let mockPage: ReturnType<typeof createMockPage>;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let driver: PlaywrightPlatformDriver;

  beforeEach(() => {
    mockPage = createMockPage({ url: 'chrome-extension://ext-123/home.html' });
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
    });
    driver = new PlaywrightPlatformDriver(
      () => mockPage,
      mockSessionManager as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('click', () => {
    it('clicks element via waitForTarget and returns success', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      const result = await driver.click(
        'testId',
        'my-button',
        new Map(),
        15000,
      );

      expect(result).toStrictEqual({
        clicked: true,
        target: 'testId:my-button',
      });
      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        mockPage,
        'testId',
        'my-button',
        new Map(),
        15000,
      );
      expect(mockLocator.click).toHaveBeenCalled();
    });

    it('handles page-closed error after click', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(mockLocator, 'click').mockRejectedValue(
        new Error('Target page, context or browser has been closed'),
      );
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      const result = await driver.click(
        'a11yRef',
        'e5',
        new Map([['e5', 'button[name="Close"]']]),
        15000,
      );

      expect(result).toStrictEqual({
        clicked: true,
        target: 'a11yRef:e5',
        pageClosedAfterClick: true,
      });
    });

    it('rethrows non-page-closed click errors', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(mockLocator, 'click').mockRejectedValue(
        new Error('Element is not clickable'),
      );
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      await expect(
        driver.click('selector', '.btn', new Map(), 5000),
      ).rejects.toThrow('Element is not clickable');
    });

    it('propagates waitForTarget errors', async () => {
      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout waiting for element'),
      );

      await expect(
        driver.click('testId', 'nonexistent', new Map(), 5000),
      ).rejects.toThrow('Timeout waiting for element');
    });
  });

  describe('type', () => {
    it('types text into element via waitForTarget and fill', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      const result = await driver.type(
        'testId',
        'amount-input',
        '0.5',
        new Map(),
        15000,
      );

      expect(result).toStrictEqual({
        typed: true,
        target: 'testId:amount-input',
        textLength: 3,
      });
      expect(mockLocator.fill).toHaveBeenCalledWith('0.5');
    });

    it('handles empty text', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      const result = await driver.type(
        'selector',
        'input.field',
        '',
        new Map(),
        10000,
      );

      expect(result).toStrictEqual({
        typed: true,
        target: 'selector:input.field',
        textLength: 0,
      });
      expect(mockLocator.fill).toHaveBeenCalledWith('');
    });

    it('propagates fill errors', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(mockLocator, 'fill').mockRejectedValue(
        new Error('Element is not editable'),
      );
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      await expect(
        driver.type('testId', 'input', 'text', new Map(), 5000),
      ).rejects.toThrow('Element is not editable');
    });
  });

  describe('waitForElement', () => {
    it('waits for element via waitForTarget', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      await driver.waitForElement('testId', 'spinner', new Map(), 30000);

      expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
        mockPage,
        'testId',
        'spinner',
        new Map(),
        30000,
      );
    });

    it('returns void (discards locator)', async () => {
      const mockLocator = createMockLocator();
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );

      const result = await driver.waitForElement(
        'a11yRef',
        'e1',
        new Map([['e1', 'button']]),
        5000,
      );

      expect(result).toBeUndefined();
    });

    it('propagates timeout errors', async () => {
      vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
        new Error('Timeout 30000ms exceeded'),
      );

      await expect(
        driver.waitForElement('testId', 'missing', new Map(), 30000),
      ).rejects.toThrow('Timeout 30000ms exceeded');
    });
  });

  describe('getAccessibilityTree', () => {
    it('delegates to collectTrimmedA11ySnapshot', async () => {
      const mockResult = {
        nodes: [{ ref: 'e1', role: 'button', name: 'Submit', path: [] }],
        refMap: new Map([['e1', 'role=button[name="Submit"]']]),
      };
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        mockResult,
      );

      const result = await driver.getAccessibilityTree();

      expect(result).toBe(mockResult);
      expect(discoveryModule.collectTrimmedA11ySnapshot).toHaveBeenCalledWith(
        mockPage,
        undefined,
      );
    });

    it('passes rootSelector to collectTrimmedA11ySnapshot', async () => {
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        { nodes: [], refMap: new Map() },
      );

      await driver.getAccessibilityTree('#main-content');

      expect(discoveryModule.collectTrimmedA11ySnapshot).toHaveBeenCalledWith(
        mockPage,
        '#main-content',
      );
    });
  });

  describe('getTestIds', () => {
    it('delegates to collectTestIds', async () => {
      const mockItems = [
        { testId: 'btn-1', tag: 'button', text: 'Click', visible: true },
      ];
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(
        mockItems as any,
      );

      const result = await driver.getTestIds();

      expect(result).toBe(mockItems);
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        mockPage,
        undefined,
      );
    });

    it('passes limit to collectTestIds', async () => {
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

      await driver.getTestIds(50);

      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(mockPage, 50);
    });
  });

  describe('screenshot', () => {
    it('delegates to sessionManager.screenshot', async () => {
      const mockResult = {
        path: '/screenshots/test.png',
        base64: 'abc123',
        width: 1280,
        height: 720,
      };
      vi.spyOn(mockSessionManager, 'screenshot').mockResolvedValue(mockResult);

      const result = await driver.screenshot({ name: 'test-shot' });

      expect(result).toBe(mockResult);
      expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
        name: 'test-shot',
        fullPage: undefined,
        selector: undefined,
      });
    });

    it('passes fullPage and selector options', async () => {
      vi.spyOn(mockSessionManager, 'screenshot').mockResolvedValue({
        path: '/path.png',
        base64: '',
        width: 0,
        height: 0,
      });

      await driver.screenshot({
        name: 'element-shot',
        fullPage: false,
        selector: '#my-element',
      });

      expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
        name: 'element-shot',
        fullPage: false,
        selector: '#my-element',
      });
    });
  });

  describe('getAppState', () => {
    it('delegates to sessionManager.getExtensionState', async () => {
      const mockState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://ext-123/home.html',
        extensionId: 'ext-123',
        isUnlocked: true,
        currentScreen: 'home' as const,
        accountAddress: '0x1234',
        networkName: 'Localhost 8545',
        chainId: 1337,
        balance: '25 ETH',
      };
      vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue(
        mockState,
      );

      const result = await driver.getAppState();

      expect(result).toBe(mockState);
      expect(mockSessionManager.getExtensionState).toHaveBeenCalled();
    });
  });

  describe('isToolSupported', () => {
    it('returns true for any tool name', () => {
      expect(driver.isToolSupported('screenshot')).toBe(true);
      expect(driver.isToolSupported('click')).toBe(true);
      expect(driver.isToolSupported('nonexistent')).toBe(true);
      expect(driver.isToolSupported('')).toBe(true);
    });
  });

  describe('getCurrentUrl', () => {
    it('returns the current page URL', () => {
      const url = driver.getCurrentUrl();

      expect(url).toBe('chrome-extension://ext-123/home.html');
      expect(mockPage.url).toHaveBeenCalled();
    });

    it('always gets the current page via getPage getter', () => {
      const page1 = createMockPage({ url: 'https://page1.com' });
      const page2 = createMockPage({ url: 'https://page2.com' });
      let currentPage = page1;

      const dynamicDriver = new PlaywrightPlatformDriver(
        () => currentPage,
        mockSessionManager as any,
      );

      expect(dynamicDriver.getCurrentUrl()).toBe('https://page1.com');

      currentPage = page2;
      expect(dynamicDriver.getCurrentUrl()).toBe('https://page2.com');
    });
  });

  describe('getPlatform', () => {
    it('returns browser', () => {
      expect(driver.getPlatform()).toBe('browser');
    });
  });

  describe('isPageClosedError delegation', () => {
    it('uses isPageClosedError from error-classification', async () => {
      const mockLocator = createMockLocator();
      const pageClosedError = new Error('browser has been closed');
      vi.spyOn(mockLocator, 'click').mockRejectedValue(pageClosedError);
      vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(
        mockLocator as any,
      );
      const spy = vi.spyOn(errorClassificationModule, 'isPageClosedError');

      await driver.click('testId', 'btn', new Map(), 5000);

      expect(spy).toHaveBeenCalledWith(pageClosedError);
    });
  });
});
