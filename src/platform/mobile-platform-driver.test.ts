import type { DeviceBackend, UIElement } from '@metamask/device-mcp';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { MobilePlatformDriver } from './mobile-platform-driver.js';

function makeElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    type: 'Button',
    frame: { x: 0, y: 0, width: 100, height: 44 },
    enabled: true,
    ...overrides,
  };
}

function createMockBackend(
  overrides: Partial<DeviceBackend> = {},
): DeviceBackend {
  return {
    platform: 'ios',
    getDeviceInfo: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({
      platform: 'ios',
      hierarchy: [],
      raw: '[]',
      timestamp: Date.now(),
    }),
    tapElement: vi.fn().mockResolvedValue({
      success: true,
      x: 50,
      y: 50,
      targetDescription: 'Button',
    }),
    tapCoordinates: vi.fn(),
    typeText: vi.fn(),
    swipe: vi.fn(),
    waitForElement: vi.fn().mockResolvedValue(makeElement()),
    getAppState: vi.fn().mockResolvedValue({
      bundleId: 'io.metamask',
      state: 'Running',
    }),
    screenshot: vi.fn().mockResolvedValue({
      data: 'base64data',
      format: 'png' as const,
      path: '/tmp/screenshot.png',
    }),
    openApp: vi.fn(),
    closeApp: vi.fn(),
    pressButton: vi.fn(),
    dismissKeyboard: vi.fn(),
    dismissAlert: vi.fn(),
    getLogs: vi.fn(),
    longPress: vi.fn(),
    scrollToElement: vi.fn(),
    getAlertText: vi.fn(),
    getWindowSize: vi.fn(),
    getContexts: vi.fn(),
    setContext: vi.fn(),
    getClipboard: vi.fn(),
    setClipboard: vi.fn(),
    startScreenRecording: vi.fn(),
    stopScreenRecording: vi.fn(),
    getElementText: vi.fn().mockResolvedValue('Hello World'),
    ...overrides,
  };
}

describe('MobilePlatformDriver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPlatform', () => {
    it('returns ios for ios backend', () => {
      const driver = new MobilePlatformDriver(createMockBackend());
      expect(driver.getPlatform()).toBe('ios');
    });

    it('returns android for android backend', () => {
      const backend = createMockBackend({ platform: 'android' });
      const driver = new MobilePlatformDriver(backend);
      expect(driver.getPlatform()).toBe('android');
    });
  });

  describe('getCurrentUrl', () => {
    it('returns empty string', () => {
      const driver = new MobilePlatformDriver(createMockBackend());
      expect(driver.getCurrentUrl()).toBe('');
    });
  });

  describe('click', () => {
    it('waits for element then taps', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'identifier:submit-btn']]);

      const result = await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.waitForElement).toHaveBeenCalledWith(
        { identifier: 'submit-btn' },
        5000,
      );
      expect(backend.tapElement).toHaveBeenCalledWith({
        identifier: 'submit-btn',
      });
      expect(result).toStrictEqual({
        clicked: true,
        target: 'a11yRef:e1',
      });
    });

    it('resolves testId target', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.click('testId', 'confirm-button', new Map(), 5000);

      expect(backend.tapElement).toHaveBeenCalledWith({
        identifier: 'confirm-button',
      });
    });

    it('resolves selector as identifier', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.click('selector', 'my-element', new Map(), 5000);

      expect(backend.tapElement).toHaveBeenCalledWith({
        identifier: 'my-element',
      });
    });

    it('throws for unknown a11yRef', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.click('a11yRef', 'e99', new Map(), 5000),
      ).rejects.toThrowError('Unknown a11yRef: e99');
    });
  });

  describe('type', () => {
    it('waits, taps to focus, then types', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.type(
        'testId',
        'password-input',
        'secret123',
        new Map(),
        5000,
      );

      expect(backend.waitForElement).toHaveBeenCalledWith(
        { identifier: 'password-input' },
        5000,
      );
      expect(backend.tapElement).toHaveBeenCalledWith({
        identifier: 'password-input',
      });
      expect(backend.typeText).toHaveBeenCalledWith('secret123');
      expect(result).toStrictEqual({
        typed: true,
        target: 'testId:password-input',
        textLength: 9,
      });
    });
  });

  describe('waitForElement', () => {
    it('delegates to backend.waitForElement', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e5', 'label:Settings']]);

      await driver.waitForElement('a11yRef', 'e5', refMap, 10000);

      expect(backend.waitForElement).toHaveBeenCalledWith(
        { label: 'Settings' },
        10000,
      );
    });
  });

  describe('getText', () => {
    it('waits then reads element text', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e3', 'identifier:balance-label']]);

      const result = await driver.getText('a11yRef', 'e3', refMap, 5000);

      expect(backend.waitForElement).toHaveBeenCalledWith(
        { identifier: 'balance-label' },
        5000,
      );
      expect(backend.getElementText).toHaveBeenCalledWith({
        identifier: 'balance-label',
      });
      expect(result).toStrictEqual({
        text: 'Hello World',
        target: 'a11yRef:e3',
        length: 11,
      });
    });

    it('resolves value: prefix to text query', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e2', 'value:0.5 ETH']]);

      await driver.getText('a11yRef', 'e2', refMap, 5000);

      expect(backend.getElementText).toHaveBeenCalledWith({
        text: '0.5 ETH',
      });
    });
  });

  describe('getAccessibilityTree', () => {
    it('normalizes UIElement hierarchy to A11yNodeTrimmed', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              label: 'Submit',
              identifier: 'submit-btn',
            }),
            makeElement({
              type: 'TextField',
              label: 'Email',
              value: 'user@test.com',
              enabled: false,
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes, refMap } = await driver.getAccessibilityTree();

      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toStrictEqual({
        ref: 'e1',
        role: 'Button',
        name: 'Submit',
        path: [],
        testId: 'submit-btn',
      });
      expect(nodes[1]).toStrictEqual({
        ref: 'e2',
        role: 'TextField',
        name: 'Email',
        path: [],
        disabled: true,
        textContent: 'user@test.com',
      });
      expect(refMap.get('e1')).toBe('identifier:submit-btn');
      expect(refMap.get('e2')).toBe('label:Email');
    });

    it('assigns sequential refs to nested children', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Window',
              label: 'Main',
              children: [
                makeElement({ type: 'Button', label: 'OK' }),
                makeElement({ type: 'Button', label: 'Cancel' }),
              ],
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes).toHaveLength(3);
      expect(nodes[0].ref).toBe('e1');
      expect(nodes[0].path).toStrictEqual([]);
      expect(nodes[1].ref).toBe('e2');
      expect(nodes[1].path).toStrictEqual(['Window']);
      expect(nodes[2].ref).toBe('e3');
      expect(nodes[2].path).toStrictEqual(['Window']);
    });

    it('builds refMap with value fallback', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [makeElement({ type: 'StaticText', value: '0.5 ETH' })],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { refMap } = await driver.getAccessibilityTree();

      expect(refMap.get('e1')).toBe('value:0.5 ETH');
    });
  });

  describe('getTestIds', () => {
    it('collects identifiers from hierarchy', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              identifier: 'submit-btn',
              label: 'Submit',
            }),
            makeElement({ type: 'StaticText', label: 'Hello' }),
            makeElement({
              type: 'TextField',
              identifier: 'email-input',
              label: 'Email',
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items).toHaveLength(2);
      expect(items[0]).toStrictEqual({
        testId: 'submit-btn',
        tag: 'Button',
        text: 'Submit',
        visible: true,
      });
      expect(items[1]).toStrictEqual({
        testId: 'email-input',
        tag: 'TextField',
        text: 'Email',
        visible: true,
      });
    });

    it('respects limit', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({ identifier: 'a' }),
            makeElement({ identifier: 'b' }),
            makeElement({ identifier: 'c' }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds(2);

      expect(items).toHaveLength(2);
    });
  });

  describe('screenshot', () => {
    it('returns mapped result with empty base64 and zero dimensions', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      const result = await driver.screenshot({ name: 'test-shot' });

      expect(result).toStrictEqual({
        path: '/tmp/screenshot.png',
        base64: '',
        width: 0,
        height: 0,
      });
    });

    it('uses name as fallback path when backend returns no path', async () => {
      const backend = createMockBackend({
        screenshot: vi.fn().mockResolvedValue({
          data: 'base64data',
          format: 'png',
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.screenshot({ name: 'my-screen' });

      expect(result.path).toBe('my-screen.png');
    });
  });

  describe('getAppState', () => {
    it('returns ExtensionState with mobile defaults for running app', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      const state = await driver.getAppState();

      expect(state).toStrictEqual({
        isLoaded: true,
        currentUrl: '',
        extensionId: 'io.metamask',
        isUnlocked: true,
        currentScreen: 'unknown',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      });
    });

    it('returns isLoaded false for non-running app', async () => {
      const backend = createMockBackend({
        getAppState: vi.fn().mockResolvedValue({
          bundleId: 'io.metamask',
          state: 'NotRunning',
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const state = await driver.getAppState();

      expect(state.isLoaded).toBe(false);
      expect(state.isUnlocked).toBe(false);
    });

    it('uses custom bundleId', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend, 'com.example.app');

      await driver.getAppState();

      expect(backend.getAppState).toHaveBeenCalledWith('com.example.app');
    });
  });
});
