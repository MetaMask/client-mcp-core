import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { IOSPlatformDriver } from './ios-driver.js';
import type { SnapshotNode } from './types.js';

function createMockClient() {
  return {
    tap: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue([] as SnapshotNode[]),
    back: vi.fn().mockResolvedValue(undefined),
    home: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

const SAMPLE_SNAPSHOT: SnapshotNode[] = [
  {
    index: 0,
    type: 'Application',
    label: 'MetaMask',
    children: [
      {
        index: 1,
        type: 'Button',
        label: 'Send',
        identifier: 'send-button',
        rect: { x: 100, y: 200, width: 80, height: 44 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        type: 'TextField',
        label: 'Amount',
        identifier: 'amount-input',
        rect: { x: 50, y: 300, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
      {
        index: 3,
        type: 'StaticText',
        label: 'Balance: 25 ETH',
        rect: { x: 50, y: 100, width: 200, height: 20 },
        enabled: true,
        hittable: false,
      },
      {
        index: 4,
        type: 'Button',
        label: 'Disabled Button',
        identifier: 'disabled-btn',
        rect: { x: 100, y: 400, width: 80, height: 44 },
        enabled: false,
        hittable: false,
      },
    ],
  },
];

const TEST_UDID = 'AAAA-BBBB-CCCC-DDDD';

describe('IOSPlatformDriver', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let driver: IOSPlatformDriver;

  beforeEach(() => {
    mockClient = createMockClient();
    driver = new IOSPlatformDriver(mockClient as any, TEST_UDID, {
      animationDelayMs: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('click', () => {
    it('finds element by testId and taps at center coordinates', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.click(
        'testId',
        'send-button',
        new Map(),
        5000,
      );

      expect(result).toStrictEqual({
        clicked: true,
        target: 'testId:send-button',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(140, 222);
    });

    it('finds element by a11yRef using refMap', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
      const refMap = new Map([['e1', 'identifier:send-button']]);

      const result = await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(result).toStrictEqual({
        clicked: true,
        target: 'a11yRef:e1',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(140, 222);
    });

    it('finds element by selector matching label', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.click('selector', 'Send', new Map(), 5000);

      expect(result).toStrictEqual({
        clicked: true,
        target: 'selector:Send',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(140, 222);
    });

    it('finds element by selector matching type', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Switch',
          rect: { x: 10, y: 20, width: 60, height: 30 },
        },
      ]);

      const result = await driver.click('selector', 'Switch', new Map(), 5000);

      expect(result).toStrictEqual({
        clicked: true,
        target: 'selector:Switch',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(40, 35);
    });

    it('throws when element not found', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.click('testId', 'nonexistent', new Map(), 5000),
      ).rejects.toThrow('Element not found: testId:nonexistent');
    });

    it('throws when element has no rect', async () => {
      mockClient.snapshot.mockResolvedValue([
        { index: 0, type: 'Button', identifier: 'no-rect-btn' },
      ]);

      await expect(
        driver.click('testId', 'no-rect-btn', new Map(), 5000),
      ).rejects.toThrow('Element has no rect for tap: testId:no-rect-btn');
    });

    it('waits for animation delay after tap', async () => {
      const delayDriver = new IOSPlatformDriver(mockClient as any, TEST_UDID, {
        animationDelayMs: 100,
      });
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const sleepSpy = vi.spyOn(
        IOSPlatformDriver.prototype as unknown as {
          sleep: (ms: number) => Promise<void>;
        },
        'sleep',
      );

      await delayDriver.click('testId', 'send-button', new Map(), 5000);

      expect(sleepSpy).toHaveBeenCalledWith(100);
      sleepSpy.mockRestore();
    });

    it('resolves a11yRef with label-based resolution', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
      const refMap = new Map([['e3', 'label:Balance: 25 ETH']]);

      const result = await driver.click('a11yRef', 'e3', refMap, 5000);

      expect(result.clicked).toBe(true);
      expect(mockClient.tap).toHaveBeenCalledWith(150, 110);
    });

    it('returns undefined for a11yRef with missing refMap entry', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.click('a11yRef', 'e999', new Map(), 5000),
      ).rejects.toThrow('Element not found: a11yRef:e999');
    });
  });

  describe('type', () => {
    it('clicks to focus then types text', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.type(
        'testId',
        'amount-input',
        '0.5',
        new Map(),
        5000,
      );

      expect(result).toStrictEqual({
        typed: true,
        target: 'testId:amount-input',
        textLength: 3,
      });
      expect(mockClient.tap).toHaveBeenCalledWith(150, 320);
      expect(mockClient.type).toHaveBeenCalledWith('0.5');
    });

    it('handles empty text', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.type(
        'testId',
        'amount-input',
        '',
        new Map(),
        5000,
      );

      expect(result).toStrictEqual({
        typed: true,
        target: 'testId:amount-input',
        textLength: 0,
      });
      expect(mockClient.type).toHaveBeenCalledWith('');
    });

    it('propagates click errors when element not found', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.type('testId', 'missing', 'text', new Map(), 5000),
      ).rejects.toThrow('Element not found: testId:missing');
    });
  });

  describe('waitForElement', () => {
    it('returns immediately when element is found', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await driver.waitForElement('testId', 'send-button', new Map(), 5000);

      expect(mockClient.snapshot).toHaveBeenCalledOnce();
    });

    it('polls until element appears', async () => {
      mockClient.snapshot
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(SAMPLE_SNAPSHOT);

      await driver.waitForElement('testId', 'send-button', new Map(), 5000);

      expect(mockClient.snapshot).toHaveBeenCalledTimes(3);
    });

    it('throws on timeout when element never appears', async () => {
      mockClient.snapshot.mockResolvedValue([]);

      await expect(
        driver.waitForElement('testId', 'missing', new Map(), 50),
      ).rejects.toThrow('Timeout waiting for element: testId:missing (50ms)');
    });

    it('works with a11yRef target type', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
      const refMap = new Map([['e1', 'identifier:send-button']]);

      await driver.waitForElement('a11yRef', 'e1', refMap, 5000);

      expect(mockClient.snapshot).toHaveBeenCalledOnce();
    });
  });

  describe('getAccessibilityTree', () => {
    it('normalizes snapshot to A11yNodeTrimmed with refs', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const { nodes, refMap } = await driver.getAccessibilityTree();

      expect(nodes.length).toBe(5);

      expect(nodes[0]).toStrictEqual({
        ref: 'e1',
        role: 'Application',
        name: 'MetaMask',
        path: [],
      });

      expect(nodes[1]).toStrictEqual({
        ref: 'e2',
        role: 'Button',
        name: 'Send',
        path: ['Application'],
      });

      expect(nodes[2]).toStrictEqual({
        ref: 'e3',
        role: 'TextField',
        name: 'Amount',
        path: ['Application'],
      });

      expect(refMap.get('e2')).toBe('identifier:send-button');
      expect(refMap.get('e3')).toBe('identifier:amount-input');
    });

    it('assigns sequential refs e1, e2, e3...', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const { nodes } = await driver.getAccessibilityTree();

      nodes.forEach((node, i) => {
        expect(node.ref).toBe(`e${i + 1}`);
      });
    });

    it('builds refMap with identifier when available, label as fallback', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const { refMap } = await driver.getAccessibilityTree();

      expect(refMap.get('e2')).toBe('identifier:send-button');
      expect(refMap.get('e4')).toBe('label:Balance: 25 ETH');
    });

    it('sets disabled flag for disabled elements', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const { nodes } = await driver.getAccessibilityTree();

      const disabledNode = nodes.find((n) => n.ref === 'e5');
      expect(disabledNode?.disabled).toBe(true);

      const enabledNode = nodes.find((n) => n.ref === 'e2');
      expect(enabledNode?.disabled).toBeUndefined();
    });

    it('uses value as name when label is absent', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'TextField',
          value: 'typed text',
          rect: { x: 0, y: 0, width: 100, height: 40 },
        },
      ]);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes[0]?.name).toBe('typed text');
    });

    it('handles empty snapshot', async () => {
      mockClient.snapshot.mockResolvedValue([]);

      const { nodes, refMap } = await driver.getAccessibilityTree();

      expect(nodes).toStrictEqual([]);
      expect(refMap.size).toBe(0);
    });

    it('builds correct path hierarchy', async () => {
      const nested: SnapshotNode[] = [
        {
          index: 0,
          type: 'Window',
          label: 'Main',
          children: [
            {
              index: 1,
              type: 'View',
              label: 'Container',
              children: [
                {
                  index: 2,
                  type: 'Button',
                  label: 'Deep',
                  identifier: 'deep-btn',
                  rect: { x: 0, y: 0, width: 50, height: 50 },
                },
              ],
            },
          ],
        },
      ];
      mockClient.snapshot.mockResolvedValue(nested);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes[0]?.path).toStrictEqual([]);
      expect(nodes[1]?.path).toStrictEqual(['Window']);
      expect(nodes[2]?.path).toStrictEqual(['Window', 'View']);
    });
  });

  describe('getTestIds', () => {
    it('collects nodes with identifier as testIds', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const items = await driver.getTestIds();

      expect(items).toStrictEqual([
        { testId: 'send-button', tag: 'Button', text: 'Send', visible: true },
        {
          testId: 'amount-input',
          tag: 'TextField',
          text: 'Amount',
          visible: true,
        },
        {
          testId: 'disabled-btn',
          tag: 'Button',
          text: 'Disabled Button',
          visible: true,
        },
      ]);
    });

    it('respects limit parameter', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const items = await driver.getTestIds(2);

      expect(items).toHaveLength(2);
      expect(items[0]?.testId).toBe('send-button');
      expect(items[1]?.testId).toBe('amount-input');
    });

    it('uses value as text when label is absent', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'TextField',
          identifier: 'field-1',
          value: 'some value',
        },
      ]);

      const items = await driver.getTestIds();

      expect(items[0]?.text).toBe('some value');
    });

    it('returns empty array when no identifiers exist', async () => {
      mockClient.snapshot.mockResolvedValue([
        { index: 0, type: 'StaticText', label: 'No ID' },
      ]);

      const items = await driver.getTestIds();

      expect(items).toStrictEqual([]);
    });

    it('defaults tag to element when type is undefined', async () => {
      mockClient.snapshot.mockResolvedValue([
        { index: 0, identifier: 'mystery' },
      ]);

      const items = await driver.getTestIds();

      expect(items[0]?.tag).toBe('element');
    });
  });

  describe('screenshot', () => {
    it('rejects when simctl fails (verifies execFile integration)', async () => {
      const screenshotDriver = new IOSPlatformDriver(
        mockClient as any,
        TEST_UDID,
        { animationDelayMs: 0, screenshotDir: '/tmp/test-screenshots' },
      );

      await expect(
        screenshotDriver.screenshot({ name: 'test-shot' }),
      ).rejects.toThrow();
    });

    it('is a callable method', () => {
      expect(typeof driver.screenshot).toBe('function');
    });
  });

  describe('getAppState', () => {
    it('returns mobile default state', async () => {
      const state = await driver.getAppState();

      expect(state).toStrictEqual({
        isLoaded: true,
        currentUrl: '',
        extensionId: '',
        isUnlocked: true,
        currentScreen: 'unknown',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      });
    });
  });

  describe('isToolSupported', () => {
    it('returns false for browser-only tools', () => {
      expect(driver.isToolSupported('mm_clipboard')).toBe(false);
      expect(driver.isToolSupported('mm_switch_to_tab')).toBe(false);
      expect(driver.isToolSupported('mm_close_tab')).toBe(false);
      expect(driver.isToolSupported('mm_wait_for_notification')).toBe(false);
    });

    it('returns true for supported tools', () => {
      expect(driver.isToolSupported('mm_click')).toBe(true);
      expect(driver.isToolSupported('mm_type')).toBe(true);
      expect(driver.isToolSupported('mm_screenshot')).toBe(true);
      expect(driver.isToolSupported('mm_get_state')).toBe(true);
      expect(driver.isToolSupported('mm_accessibility_snapshot')).toBe(true);
      expect(driver.isToolSupported('mm_list_testids')).toBe(true);
    });

    it('returns true for unknown tool names', () => {
      expect(driver.isToolSupported('mm_future_tool')).toBe(true);
      expect(driver.isToolSupported('')).toBe(true);
    });
  });

  describe('getCurrentUrl', () => {
    it('returns empty string', () => {
      expect(driver.getCurrentUrl()).toBe('');
    });
  });

  describe('getPlatform', () => {
    it('returns ios', () => {
      expect(driver.getPlatform()).toBe('ios');
    });
  });

  describe('coordinate calculation', () => {
    it('calculates center of element rect correctly', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          label: 'Test',
          identifier: 'center-test',
          rect: { x: 0, y: 0, width: 100, height: 50 },
          enabled: true,
          hittable: true,
        },
      ]);

      await driver.click('testId', 'center-test', new Map(), 5000);

      expect(mockClient.tap).toHaveBeenCalledWith(50, 25);
    });

    it('handles non-zero origin coordinates', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          label: 'Offset',
          identifier: 'offset-test',
          rect: { x: 200, y: 300, width: 60, height: 40 },
          enabled: true,
          hittable: true,
        },
      ]);

      await driver.click('testId', 'offset-test', new Map(), 5000);

      expect(mockClient.tap).toHaveBeenCalledWith(230, 320);
    });
  });

  describe('element resolution edge cases', () => {
    it('finds deeply nested elements by testId', async () => {
      const deepSnapshot: SnapshotNode[] = [
        {
          index: 0,
          type: 'Window',
          children: [
            {
              index: 1,
              type: 'View',
              children: [
                {
                  index: 2,
                  type: 'View',
                  children: [
                    {
                      index: 3,
                      type: 'Button',
                      identifier: 'deep-btn',
                      label: 'Deep',
                      rect: { x: 10, y: 20, width: 30, height: 40 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      mockClient.snapshot.mockResolvedValue(deepSnapshot);

      const result = await driver.click('testId', 'deep-btn', new Map(), 5000);

      expect(result.clicked).toBe(true);
      expect(mockClient.tap).toHaveBeenCalledWith(25, 40);
    });

    it('handles refMap values containing colons', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'StaticText',
          label: 'Balance: 25 ETH',
          rect: { x: 0, y: 0, width: 200, height: 20 },
        },
      ]);
      const refMap = new Map([['e1', 'label:Balance: 25 ETH']]);

      const result = await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(result.clicked).toBe(true);
    });
  });

  describe('constructor options', () => {
    it('uses default animation delay of 300ms', async () => {
      const defaultDriver = new IOSPlatformDriver(mockClient as any, TEST_UDID);

      const sleepSpy = vi.spyOn(
        IOSPlatformDriver.prototype as unknown as {
          sleep: (ms: number) => Promise<void>;
        },
        'sleep',
      );
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await defaultDriver.click('testId', 'send-button', new Map(), 5000);

      expect(sleepSpy).toHaveBeenCalledWith(300);
      sleepSpy.mockRestore();
    });

    it('accepts custom animation delay', async () => {
      const customDriver = new IOSPlatformDriver(mockClient as any, TEST_UDID, {
        animationDelayMs: 500,
      });
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const sleepSpy = vi.spyOn(
        IOSPlatformDriver.prototype as unknown as {
          sleep: (ms: number) => Promise<void>;
        },
        'sleep',
      );

      await customDriver.click('testId', 'send-button', new Map(), 5000);

      expect(sleepSpy).toHaveBeenCalledWith(500);
      sleepSpy.mockRestore();
    });
  });
});
