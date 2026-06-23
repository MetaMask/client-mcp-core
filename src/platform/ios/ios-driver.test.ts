import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { snapshotAxIos } from './ax-snapshot.js';
import { IOSPlatformDriver } from './ios-driver.js';
import type { SnapshotNode } from './types.js';

vi.mock('./ax-snapshot.js', () => ({
  snapshotAxIos: vi.fn().mockResolvedValue([]),
}));

function createMockClient() {
  return {
    tap: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue([] as SnapshotNode[]),
    bind: vi.fn().mockResolvedValue(undefined),
    back: vi.fn().mockResolvedValue(undefined),
    home: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    waitForRunner: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    tapElement: vi
      .fn()
      .mockRejectedValue(new Error('tapElement not implemented in mock')),
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
    vi.mocked(snapshotAxIos).mockResolvedValue([]);
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
      expect(mockClient.tap).toHaveBeenCalledWith(
        140,
        222,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('finds element by a11yRef using refMap', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
      const refMap = new Map([['e1', 'identifier:send-button']]);

      const result = await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(result).toStrictEqual({
        clicked: true,
        target: 'a11yRef:e1',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(
        140,
        222,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('finds element by selector matching label', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.click('selector', 'Send', new Map(), 5000);

      expect(result).toStrictEqual({
        clicked: true,
        target: 'selector:Send',
      });
      expect(mockClient.tap).toHaveBeenCalledWith(
        140,
        222,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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
      expect(mockClient.tap).toHaveBeenCalledWith(
        40,
        35,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('throws when element not found after timeout', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.click('testId', 'nonexistent', new Map(), 50),
      ).rejects.toThrowError(
        'Element not found: testId:nonexistent (timeout 50ms)',
      );
    });

    it('polls until element appears then clicks', async () => {
      mockClient.snapshot
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(SAMPLE_SNAPSHOT);

      const result = await driver.click(
        'testId',
        'send-button',
        new Map(),
        5000,
      );

      expect(result.clicked).toBe(true);
      expect(mockClient.snapshot).toHaveBeenCalledTimes(2);
    });

    it('throws when element has no rect', async () => {
      mockClient.snapshot.mockResolvedValue([
        { index: 0, type: 'Button', identifier: 'no-rect-btn' },
      ]);

      await expect(
        driver.click('testId', 'no-rect-btn', new Map(), 5000),
      ).rejects.toThrowError('Element has no rect for tap: testId:no-rect-btn');
    });

    it('waits for animation delay after tap', async () => {
      const delayDriver = new IOSPlatformDriver(mockClient as any, TEST_UDID, {
        animationDelayMs: 100,
      });
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await delayDriver.click('testId', 'send-button', new Map(), 5000);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
      setTimeoutSpy.mockRestore();
    });

    it('resolves a11yRef with label-based resolution', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
      const refMap = new Map([['e3', 'label:Balance: 25 ETH']]);

      const result = await driver.click('a11yRef', 'e3', refMap, 5000);

      expect(result.clicked).toBe(true);
      expect(mockClient.tap).toHaveBeenCalledWith(
        150,
        110,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('returns undefined for a11yRef with missing refMap entry', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.click('a11yRef', 'e999', new Map(), 50),
      ).rejects.toThrowError('Element not found: a11yRef:e999 (timeout 50ms)');
    });

    it('uses tapElement(identifier) and skips label fallback when identifier exists', async () => {
      mockClient.tapElement.mockResolvedValue(undefined);
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.click(
        'testId',
        'send-button',
        new Map(),
        5000,
      );

      expect(result.clicked).toBe(true);
      expect(mockClient.tapElement).toHaveBeenCalledTimes(1);
      expect(mockClient.tapElement).toHaveBeenCalledWith(
        'send-button',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockClient.tap).not.toHaveBeenCalled();
    });

    it('falls back to coordinate tap when tapElement(identifier) fails', async () => {
      mockClient.tapElement.mockRejectedValue(new Error('not found'));
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const result = await driver.click(
        'testId',
        'send-button',
        new Map(),
        5000,
      );

      expect(result.clicked).toBe(true);
      expect(mockClient.tapElement).toHaveBeenCalledTimes(1);
      expect(mockClient.tapElement).toHaveBeenCalledWith(
        'send-button',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockClient.tap).toHaveBeenCalledWith(
        140,
        222,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('tries tapElement(label) when no identifier is present', async () => {
      mockClient.tapElement.mockRejectedValueOnce(new Error('not found'));
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          label: 'Label-Only Button',
          rect: { x: 10, y: 20, width: 60, height: 30 },
          enabled: true,
          hittable: true,
        },
      ]);

      const result = await driver.click(
        'selector',
        'Label-Only Button',
        new Map(),
        5000,
      );

      expect(result.clicked).toBe(true);
      expect(mockClient.tapElement).toHaveBeenCalledTimes(1);
      expect(mockClient.tapElement).toHaveBeenCalledWith(
        'Label-Only Button',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockClient.tap).toHaveBeenCalledWith(
        40,
        35,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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
      expect(mockClient.fill).toHaveBeenCalledWith(
        150,
        320,
        '0.5',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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
      expect(mockClient.fill).toHaveBeenCalledWith(
        150,
        320,
        '',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('propagates click errors when element not found', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await expect(
        driver.type('testId', 'missing', 'text', new Map(), 50),
      ).rejects.toThrowError(/Element not found: testId:missing/u);
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
      ).rejects.toThrowError(
        'Timeout waiting for element: testId:missing (50ms)',
      );
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

      expect(nodes).toHaveLength(5);

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

    it('passes rootSelector as scope to snapshot', async () => {
      mockClient.snapshot
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(SAMPLE_SNAPSHOT);

      await driver.getAccessibilityTree('main-view');

      expect(mockClient.snapshot).toHaveBeenCalledWith({ scope: 'main-view' });
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

      await expect(driver.getAccessibilityTree()).rejects.toThrowError(
        'MM_IOS_EMPTY_SNAPSHOT: discovery snapshot is empty after rebind (io.metamask.MetaMask)',
      );
    });

    it('forwards the session deviceUdid to snapshotAxIos when AX fallback runs', async () => {
      mockClient.snapshot.mockResolvedValue([]);
      vi.mocked(snapshotAxIos).mockResolvedValue(SAMPLE_SNAPSHOT);

      const { nodes } = await driver.getAccessibilityTree();

      expect(snapshotAxIos).toHaveBeenCalledWith(TEST_UDID);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('propagates MM_IOS_AX_DEVICE_NOT_FOUND from AX fallback instead of wrapping as MM_IOS_EMPTY_SNAPSHOT', async () => {
      mockClient.snapshot.mockResolvedValue([]);
      const deviceError = new Error(
        'MM_IOS_AX_DEVICE_NOT_FOUND: no Simulator window matched UDID AAAA-BBBB-CCCC-DDDD',
      );
      vi.mocked(snapshotAxIos).mockRejectedValue(deviceError);

      await expect(driver.getAccessibilityTree()).rejects.toThrowError(
        /MM_IOS_AX_DEVICE_NOT_FOUND/u,
      );
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
      ).rejects.toThrowError('xcrun');
    });

    it('is a callable method', () => {
      expect(typeof driver.screenshot).toBe('function');
    });
  });

  describe('getAppState', () => {
    it('returns loaded state when runner ping succeeds', async () => {
      const state = await driver.getAppState();

      expect(state).toStrictEqual({
        isLoaded: true,
        currentUrl: '',
        extensionId: 'io.metamask.MetaMask',
        isUnlocked: true,
        currentScreen: 'unknown',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      });
      expect(mockClient.ping).toHaveBeenCalled();
    });

    it('returns not-loaded state when runner ping fails', async () => {
      mockClient.ping.mockRejectedValueOnce(new Error('connection refused'));

      const state = await driver.getAppState();

      expect(state).toStrictEqual({
        isLoaded: false,
        currentUrl: '',
        extensionId: 'io.metamask.MetaMask',
        isUnlocked: false,
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
      expect(driver.isToolSupported('clipboard')).toBe(false);
      expect(driver.isToolSupported('switch_to_tab')).toBe(false);
      expect(driver.isToolSupported('close_tab')).toBe(false);
      expect(driver.isToolSupported('wait_for_notification')).toBe(false);
      expect(driver.isToolSupported('navigate')).toBe(false);
    });

    it('returns true for supported tools', () => {
      expect(driver.isToolSupported('click')).toBe(true);
      expect(driver.isToolSupported('type')).toBe(true);
      expect(driver.isToolSupported('screenshot')).toBe(true);
      expect(driver.isToolSupported('get_state')).toBe(true);
      expect(driver.isToolSupported('accessibility_snapshot')).toBe(true);
      expect(driver.isToolSupported('list_testids')).toBe(true);
    });

    it('returns false for unknown tool names (allow-list)', () => {
      expect(driver.isToolSupported('future_tool')).toBe(false);
      expect(driver.isToolSupported('')).toBe(false);
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

      expect(mockClient.tap).toHaveBeenCalledWith(
        50,
        25,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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

      expect(mockClient.tap).toHaveBeenCalledWith(
        230,
        320,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe('findBySelector priority', () => {
    it('matches identifier before label', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          label: 'other-label',
          identifier: 'my-id',
          rect: { x: 0, y: 0, width: 40, height: 40 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'my-id',
          rect: { x: 100, y: 100, width: 40, height: 40 },
        },
      ]);

      const result = await driver.click('selector', 'my-id', new Map(), 5000);

      expect(result.clicked).toBe(true);
      // Should tap center of the first element (identifier match), not the second (label match)
      expect(mockClient.tap).toHaveBeenCalledWith(
        20,
        20,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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
      expect(mockClient.tap).toHaveBeenCalledWith(
        25,
        40,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await defaultDriver.click('testId', 'send-button', new Map(), 5000);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 300);
      setTimeoutSpy.mockRestore();
    });

    it('accepts custom animation delay', async () => {
      const customDriver = new IOSPlatformDriver(mockClient as any, TEST_UDID, {
        animationDelayMs: 500,
      });
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await customDriver.click('testId', 'send-button', new Map(), 5000);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 500);
      setTimeoutSpy.mockRestore();
    });
  });

  describe('hermes identity surface', () => {
    function makeDriver(opts?: {
      appBundleId?: string;
      metroPort?: number;
    }): IOSPlatformDriver {
      return new IOSPlatformDriver(mockClient as any, TEST_UDID, {
        animationDelayMs: 0,
        appBundleId: opts?.appBundleId,
        metroPort: opts?.metroPort,
      });
    }

    describe('getAppId()', () => {
      it('returns the configured appBundleId', () => {
        const identityDriver = makeDriver({
          appBundleId: 'io.metamask.MetaMask.dev',
        });
        expect(identityDriver.getAppId()).toBe('io.metamask.MetaMask.dev');
      });

      it('returns the default bundle ID when appBundleId option is omitted', () => {
        const identityDriver = makeDriver();
        expect(identityDriver.getAppId()).toBe('io.metamask.MetaMask');
      });
    });

    describe('getMetroPort()', () => {
      it('returns the configured metroPort', () => {
        const identityDriver = makeDriver({ metroPort: 8082 });
        expect(identityDriver.getMetroPort()).toBe(8082);
      });

      it('returns undefined when metroPort option is omitted', () => {
        const identityDriver = makeDriver();
        expect(identityDriver.getMetroPort()).toBeUndefined();
      });
    });

    describe('Hermes device pin', () => {
      it('starts unset (returns undefined before first setPinnedHermesDeviceId call)', () => {
        const identityDriver = makeDriver();
        expect(identityDriver.getPinnedHermesDeviceId()).toBeUndefined();
      });

      it('round-trips a value via setPinnedHermesDeviceId/getPinnedHermesDeviceId', () => {
        const identityDriver = makeDriver();
        identityDriver.setPinnedHermesDeviceId('abc123');
        expect(identityDriver.getPinnedHermesDeviceId()).toBe('abc123');
      });

      it('overwrites the previous pin when set again', () => {
        const identityDriver = makeDriver();
        identityDriver.setPinnedHermesDeviceId('abc123');
        identityDriver.setPinnedHermesDeviceId('def456');
        expect(identityDriver.getPinnedHermesDeviceId()).toBe('def456');
      });

      it('keeps pin scoped to the driver instance (fresh driver has unset pin)', () => {
        const identityDriver1 = makeDriver();
        identityDriver1.setPinnedHermesDeviceId('abc123');
        const identityDriver2 = makeDriver();
        expect(identityDriver2.getPinnedHermesDeviceId()).toBeUndefined();
        expect(identityDriver1.getPinnedHermesDeviceId()).toBe('abc123');
      });
    });
  });

  describe('type abort signal', () => {
    it('rejects with timeout when fill hangs', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      let receivedSignal: AbortSignal | undefined;
      mockClient.fill.mockImplementation(async (_x, _y, _text, options) => {
        receivedSignal = options?.signal;
        if (receivedSignal?.aborted) {
          return Promise.reject(new Error(String(receivedSignal.reason)));
        }
        return new Promise((_resolve, reject) => {
          receivedSignal?.addEventListener('abort', () => {
            reject(new Error(String(receivedSignal?.reason)));
          });
        });
      });

      const promise = driver.type(
        'testId',
        'amount-input',
        'secret',
        new Map(),
        100,
      );

      await expect(promise).rejects.toThrowError(
        'Timeout typing into testId:amount-input (100ms)',
      );

      expect(receivedSignal?.aborted).toBe(true);
    });

    it('passes an AbortSignal to fill', async () => {
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await driver.type('testId', 'amount-input', 'hello', new Map(), 5000);

      const lastCall =
        mockClient.fill.mock.calls[mockClient.fill.mock.calls.length - 1];
      expect(lastCall[3]).toStrictEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe('click abort signal', () => {
    it('passes an AbortSignal to tapElement', async () => {
      mockClient.tapElement.mockResolvedValue(undefined);
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await driver.click('testId', 'send-button', new Map(), 5000);

      expect(mockClient.tapElement).toHaveBeenCalledWith(
        'send-button',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('passes an AbortSignal to tap on coordinate fallback', async () => {
      mockClient.tapElement.mockRejectedValue(new Error('not found'));
      mockClient.snapshot.mockResolvedValue(SAMPLE_SNAPSHOT);

      await driver.click('testId', 'send-button', new Map(), 5000);

      expect(mockClient.tap).toHaveBeenCalledWith(
        140,
        222,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('rejects with timeout when coordinate tap hangs', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          label: 'No ID',
          rect: { x: 0, y: 0, width: 40, height: 40 },
        },
      ]);

      let receivedSignal: AbortSignal | undefined;
      mockClient.tap.mockImplementation(async (_x, _y, options) => {
        receivedSignal = options?.signal;
        if (receivedSignal?.aborted) {
          return Promise.reject(new Error(String(receivedSignal.reason)));
        }
        return new Promise((_resolve, reject) => {
          receivedSignal?.addEventListener('abort', () => {
            reject(new Error(String(receivedSignal?.reason)));
          });
        });
      });

      const promise = driver.click('selector', 'No ID', new Map(), 100);

      await expect(promise).rejects.toThrowError(
        'Timeout clicking selector:No ID (100ms)',
      );

      expect(receivedSignal?.aborted).toBe(true);
    });

    it('rejects with timeout when tapElement hangs', async () => {
      mockClient.snapshot.mockResolvedValue([
        {
          index: 0,
          type: 'Button',
          identifier: 'btn',
          rect: { x: 0, y: 0, width: 40, height: 40 },
        },
      ]);

      let tapElementSignal: AbortSignal | undefined;
      mockClient.tapElement.mockImplementation(async (_text, options) => {
        tapElementSignal = options?.signal;
        if (tapElementSignal?.aborted) {
          return Promise.reject(new Error(String(tapElementSignal.reason)));
        }
        return new Promise((_resolve, reject) => {
          tapElementSignal?.addEventListener('abort', () => {
            reject(new Error(String(tapElementSignal?.reason)));
          });
        });
      });

      let tapSignal: AbortSignal | undefined;
      mockClient.tap.mockImplementation(async (_x, _y, options) => {
        tapSignal = options?.signal;
        if (tapSignal?.aborted) {
          return Promise.reject(new Error(String(tapSignal.reason)));
        }
        return new Promise((_resolve, reject) => {
          tapSignal?.addEventListener('abort', () => {
            reject(new Error(String(tapSignal?.reason)));
          });
        });
      });

      const promise = driver.click('testId', 'btn', new Map(), 100);

      await expect(promise).rejects.toThrowError(
        'Timeout clicking testId:btn (100ms)',
      );

      expect(tapElementSignal?.aborted).toBe(true);
    });
  });
});
