import type { DeviceBackend, UIElement } from '@metamask/device-mcp';
import { describe, it, expect, vi, afterEach } from 'vitest';

import androidLoginSnapshot from './__fixtures__/android-login-snapshot.json';
import iosWalletHomePreorder from './__fixtures__/ios-wallet-home-preorder.json';
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
    screenshot: vi.fn().mockImplementation(async (_outputPath, options) =>
      Promise.resolve({
        data: options?.encode === false ? undefined : 'base64data',
        format: 'png' as const,
        path: '/tmp/screenshot.png',
      }),
    ),
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

/**
 * The real iOS wallet home snapshot (idb nested format, device-mcp P1-26,
 * proof/p1-26/ios/home-describe-screen.txt, amounts sanitized). The fixture
 * stores the elements in pre-order with their depth, to keep the file small;
 * this rebuilds the nested hierarchy. It is the raw (intentionally
 * unpruned) snapshot: the DevLauncher window and all layout-only elements
 * are in it, so the tests exercise `filterAppHierarchy` and
 * `pruneLayoutOnly` end to end.
 *
 * @returns The hierarchy.
 */
function iosWalletHomeSnapshot(): UIElement[] {
  const roots: UIElement[] = [];
  const stack: UIElement[] = [];
  for (const { depth, ...element } of iosWalletHomePreorder as (UIElement & {
    depth: number;
  })[]) {
    stack.length = depth;
    const parent = stack[depth - 1];
    if (parent) {
      parent.children = [...(parent.children ?? []), element];
    } else {
      roots.push(element);
    }
    stack.push(element);
  }
  return roots;
}

describe('MobilePlatformDriver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('captureScreen', () => {
    it('returns the tree and the test IDs of one snapshot', async () => {
      const backend = createMockBackend({
        getWindowSize: vi.fn().mockResolvedValue({ width: 402, height: 874 }),
        snapshot: vi
          .fn()
          .mockResolvedValueOnce({
            platform: 'ios',
            hierarchy: [
              makeElement({ identifier: 'login', label: 'Unlock' }),
              makeElement({
                identifier: 'below',
                type: 'StaticText',
                frame: { x: 0, y: 2000, width: 10, height: 10 },
              }),
            ],
            raw: '[]',
            timestamp: Date.now(),
          })
          .mockResolvedValueOnce({
            platform: 'ios',
            hierarchy: [makeElement({ identifier: 'wallet' })],
            raw: '[]',
            timestamp: Date.now(),
          }),
      });
      const driver = new MobilePlatformDriver(backend);

      const screen = await driver.captureScreen();
      const testIds = await screen.getTestIds();

      expect(backend.snapshot).toHaveBeenCalledTimes(1);
      expect(screen.nodes.map((node) => node.testId)).toStrictEqual([
        'login',
        'below',
      ]);
      expect(screen.refMap.get('e1')).toBe('identifier:login');
      // Same items, order and visibility as getTestIds on that snapshot.
      expect(testIds).toStrictEqual([
        { testId: 'login', tag: 'Button', text: 'Unlock', visible: true },
        { testId: 'below', tag: 'StaticText', text: undefined, visible: false },
      ]);
      expect(await screen.getTestIds(1)).toHaveLength(1);
    });
  });

  describe('P1-13: one snapshot, app-only hierarchy, viewport', () => {
    const snapshotOf = async (
      platform: 'ios' | 'android',
      hierarchy: UIElement[],
    ): ReturnType<DeviceBackend['snapshot']> => ({
      platform,
      hierarchy,
      raw: '',
      timestamp: 0,
    });

    // Shaped like a real adb snapshot: System UI status bar window, then
    // the app window with the DevLauncher "Tools" button in a Compose view.
    const androidHierarchy = (): UIElement[] => [
      makeElement({
        type: 'android.widget.FrameLayout',
        frame: { x: 0, y: 0, width: 1080, height: 63 },
        children: [
          makeElement({
            type: 'android.widget.FrameLayout',
            identifier: 'com.android.systemui:id/status_bar',
            children: [
              makeElement({
                type: 'android.widget.TextView',
                identifier: 'com.android.systemui:id/clock',
                value: '12:46 AM',
              }),
            ],
          }),
        ],
      }),
      makeElement({
        type: 'android.widget.FrameLayout',
        frame: { x: 0, y: 0, width: 1080, height: 2400 },
        children: [
          makeElement({
            type: 'android.widget.LinearLayout',
            identifier: 'io.metamask:id/action_bar_root',
            frame: { x: 0, y: 0, width: 1080, height: 2400 },
            children: [
              makeElement({
                type: 'androidx.compose.ui.platform.ComposeView',
                children: [
                  makeElement({
                    type: 'android.widget.ImageView',
                    label: 'Tools',
                  }),
                ],
              }),
              makeElement({
                type: 'android.widget.Button',
                identifier: 'log-in-button',
                label: 'Unlock',
                frame: { x: 40, y: 1800, width: 1000, height: 120 },
              }),
              makeElement({
                type: 'android.widget.TextView',
                identifier: 'below-fold',
                frame: { x: 0, y: 2600, width: 1080, height: 60 },
              }),
            ],
          }),
        ],
      }),
    ];

    it('lists the app test IDs of a real Android login snapshot (AC2)', async () => {
      const backend = createMockBackend({
        platform: 'android',
        snapshot: vi.fn(async () =>
          snapshotOf('android', androidLoginSnapshot as UIElement[]),
        ),
        getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
      });
      const driver = new MobilePlatformDriver(backend);

      const screen = await driver.captureScreen();
      const testIds = (await screen.getTestIds()).map((item) => item.testId);

      // Before P1-13: 35 test IDs, 22 of them com.android.systemui.
      expect(testIds.filter((id) => id.includes('systemui'))).toStrictEqual([]);
      expect(testIds).toContain('log-in-button');
      expect(screen.nodes[0]?.bounds).toStrictEqual({
        x: 0,
        y: 0,
        width: 1080,
        height: 2400,
      });
      expect(backend.getWindowSize).not.toHaveBeenCalled();
    });

    it('takes one snapshot and no window size for a capture (AC1)', async () => {
      const backend = createMockBackend({
        platform: 'android',
        snapshot: vi.fn(async () => snapshotOf('android', androidHierarchy())),
        getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
      });
      const driver = new MobilePlatformDriver(backend);

      const screen = await driver.captureScreen();
      await screen.getTestIds();
      await screen.getTestIds(1);

      expect(backend.snapshot).toHaveBeenCalledTimes(1);
      // The viewport comes from the snapshot's top-level window frames.
      expect(backend.getWindowSize).not.toHaveBeenCalled();
    });

    it('drops com.android.systemui test IDs, nodes and refs (AC2)', async () => {
      const backend = createMockBackend({
        platform: 'android',
        snapshot: vi.fn(async () => snapshotOf('android', androidHierarchy())),
      });
      const driver = new MobilePlatformDriver(backend);

      const screen = await driver.captureScreen();
      const testIds = await screen.getTestIds();
      const listed = await driver.getTestIds();
      const tree = await driver.getAccessibilityTree();

      for (const ids of [
        testIds.map((item) => item.testId),
        listed.map((item) => item.testId),
        screen.nodes.flatMap((node) => (node.testId ? [node.testId] : [])),
        [...screen.refMap.values()],
        tree.nodes.map((node) => node.name),
      ]) {
        expect(ids.join(' ')).not.toMatch(/systemui|12:46|Tools/u);
      }
      expect(testIds).toStrictEqual([
        {
          testId: 'io.metamask:id/action_bar_root',
          tag: 'android.widget.LinearLayout',
          text: undefined,
          visible: true,
        },
        {
          testId: 'log-in-button',
          tag: 'android.widget.Button',
          text: 'Unlock',
          visible: true,
        },
        {
          testId: 'below-fold',
          tag: 'android.widget.TextView',
          text: undefined,
          visible: false,
        },
      ]);
      // Tree and test IDs come from the same filtered hierarchy.
      expect(
        screen.nodes.flatMap((node) => (node.testId ? [node.testId] : [])),
      ).toStrictEqual(testIds.map((item) => item.testId));
      // The unnamed app window is layout-only (P1-14): the first node is
      // its first child with a testId.
      expect(screen.nodes[0]?.ref).toBe('e1');
      expect(screen.nodes[0]?.role).toBe('android.widget.LinearLayout');
    });

    it('drops the iOS DevLauncher overlay by default', async () => {
      const hierarchy = [
        makeElement({
          type: 'Other',
          label: 'MetaMask',
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            makeElement({ identifier: 'log-in-button', label: 'Unlock' }),
            makeElement({
              type: 'Image',
              identifier: 'gearshape.fill',
              label: 'Gear Shape, Filled',
            }),
            makeElement({ type: 'StaticText', label: 'Tools' }),
          ],
        }),
      ];
      const backend = createMockBackend({
        snapshot: vi.fn(async () => snapshotOf('ios', hierarchy)),
      });
      const driver = new MobilePlatformDriver(backend);

      const screen = await driver.captureScreen();

      expect(screen.nodes.map((node) => node.name)).toStrictEqual([
        'MetaMask',
        'Unlock',
      ]);
      expect(
        (await screen.getTestIds()).map((item) => item.testId),
      ).toStrictEqual(['log-in-button']);
    });

    it('keeps the DevLauncher overlay with excludeDevOverlay: false', async () => {
      const hierarchy = [
        makeElement({ type: 'Image', identifier: 'gearshape.fill' }),
        makeElement({ type: 'StaticText', label: 'Tools' }),
      ];
      const backend = createMockBackend({
        snapshot: vi.fn(async () => snapshotOf('ios', hierarchy)),
      });
      const driver = new MobilePlatformDriver(backend, 'io.metamask', {
        excludeDevOverlay: false,
      });

      const screen = await driver.captureScreen();

      expect(screen.nodes.map((node) => node.name)).toStrictEqual([
        '',
        'Tools',
      ]);
      expect(
        (await screen.getTestIds()).map((item) => item.testId),
      ).toStrictEqual(['gearshape.fill']);
    });

    it('reads the window size at most once across observations without a root frame', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn(async () =>
          snapshotOf('ios', [
            makeElement({
              identifier: 'below',
              frame: { x: 0, y: 2000, width: 10, height: 10 },
            }),
          ]),
        ),
        getWindowSize: vi.fn().mockResolvedValue({ width: 402, height: 874 }),
      });
      const driver = new MobilePlatformDriver(backend);

      for (let i = 0; i < 5; i++) {
        const screen = await driver.captureScreen();
        expect((await screen.getTestIds())[0]?.visible).toBe(false);
      }
      await driver.getTestIds();

      expect(backend.snapshot).toHaveBeenCalledTimes(6);
      expect(backend.getWindowSize).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed window size read', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn(async () =>
          snapshotOf('ios', [
            makeElement({
              identifier: 'below',
              frame: { x: 0, y: 2000, width: 10, height: 10 },
            }),
          ]),
        ),
        getWindowSize: vi
          .fn()
          .mockRejectedValueOnce(new Error('idb describe failed'))
          .mockResolvedValue({ width: 402, height: 874 }),
      });
      const driver = new MobilePlatformDriver(backend);

      const first = await driver.getTestIds();
      const second = await driver.getTestIds();
      await driver.getTestIds();

      expect(first[0]?.visible).toBe(true);
      expect(second[0]?.visible).toBe(false);
      expect(backend.getWindowSize).toHaveBeenCalledTimes(2);
    });

    it('prefers the snapshot viewport over the window size', async () => {
      // Landscape: the root frame is wider than `wm size` (natural
      // orientation); the snapshot is what the screen shows now.
      const backend = createMockBackend({
        platform: 'android',
        snapshot: vi.fn(async () =>
          snapshotOf('android', [
            makeElement({
              type: 'android.widget.FrameLayout',
              frame: { x: 0, y: 0, width: 2400, height: 1080 },
              children: [
                makeElement({
                  identifier: 'right-side',
                  frame: { x: 2000, y: 100, width: 200, height: 100 },
                }),
              ],
            }),
          ]),
        ),
        getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items[0]?.visible).toBe(true);
      expect(backend.getWindowSize).not.toHaveBeenCalled();
    });
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
    const obscured = (keyboard: boolean): Error =>
      Object.assign(new Error('TARGET_OBSCURED: covered'), {
        code: 'TARGET_OBSCURED',
        keyboard,
      });

    it('dismisses the keyboard and taps again with dismissKeyboard', async () => {
      const before = makeElement({ identifier: 'log-in-button' });
      const after = makeElement({
        identifier: 'log-in-button',
        frame: { x: 16, y: 700, width: 370, height: 48 },
      });
      const backend = createMockBackend({
        waitForElement: vi
          .fn()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
        tapElement: vi
          .fn()
          .mockRejectedValueOnce(obscured(true))
          .mockResolvedValueOnce({
            success: true,
            x: 1,
            y: 2,
            targetDescription: '',
          }),
      });
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.click(
        'testId',
        'log-in-button',
        new Map(),
        5000,
        undefined,
        undefined,
        { dismissKeyboard: true },
      );

      expect(result).toStrictEqual({
        clicked: true,
        target: 'testId:log-in-button',
        keyboardDismissed: true,
      });
      expect(backend.dismissKeyboard).toHaveBeenCalledTimes(1);
      // The second tap uses the element read after the keyboard closed.
      expect(vi.mocked(backend.tapElement).mock.calls).toStrictEqual([
        [{ identifier: 'log-in-button' }, { element: before }],
        [{ identifier: 'log-in-button' }, { element: after }],
      ]);
    });

    it('does not dismiss the keyboard without the option', async () => {
      const backend = createMockBackend({
        tapElement: vi.fn().mockRejectedValue(obscured(true)),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click('testId', 'log-in-button', new Map(), 5000),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(backend.dismissKeyboard).not.toHaveBeenCalled();
      expect(backend.tapElement).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss the keyboard when an overlay (not the keyboard) covers the target', async () => {
      const backend = createMockBackend({
        tapElement: vi.fn().mockRejectedValue(obscured(false)),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click('testId', 'x', new Map(), 5000, undefined, undefined, {
          dismissKeyboard: true,
        }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED', keyboard: false });
      expect(backend.dismissKeyboard).not.toHaveBeenCalled();
    });

    it('fails when the target is still covered after the keyboard is dismissed', async () => {
      const backend = createMockBackend({
        tapElement: vi.fn().mockRejectedValue(obscured(true)),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click('testId', 'x', new Map(), 5000, undefined, undefined, {
          dismissKeyboard: true,
        }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(backend.dismissKeyboard).toHaveBeenCalledTimes(1);
      expect(backend.tapElement).toHaveBeenCalledTimes(2);
    });

    it('does not tap again when the request is aborted while dismissing', async () => {
      const controller = new AbortController();
      const backend = createMockBackend({
        tapElement: vi.fn().mockRejectedValue(obscured(true)),
        dismissKeyboard: vi.fn(async () => {
          controller.abort();
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click(
          'testId',
          'x',
          new Map(),
          5000,
          undefined,
          controller.signal,
          {
            dismissKeyboard: true,
          },
        ),
      ).rejects.toThrowError('This operation was aborted');
      expect(backend.tapElement).toHaveBeenCalledTimes(1);
    });

    it('taps the element that waitForElement returned (one snapshot)', async () => {
      const found = makeElement({
        identifier: 'submit-btn',
        frame: { x: 10, y: 600, width: 120, height: 48 },
      });
      const backend = createMockBackend({
        waitForElement: vi.fn().mockResolvedValue(found),
      });
      const driver = new MobilePlatformDriver(backend);

      await driver.click('testId', 'submit-btn', new Map(), 5000);
      await driver.type('testId', 'submit-btn', 'x', new Map(), 5000);

      expect(backend.tapElement).toHaveBeenNthCalledWith(
        1,
        { identifier: 'submit-btn' },
        { element: found },
      );
      expect(backend.tapElement).toHaveBeenNthCalledWith(
        2,
        { identifier: 'submit-btn' },
        { element: found },
      );
      expect(backend.snapshot).not.toHaveBeenCalled();
    });

    it('waits for element then taps', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'identifier:submit-btn']]);

      const result = await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.waitForElement).toHaveBeenCalledWith(
        { identifier: 'submit-btn' },
        5000,
      );
      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'submit-btn',
        },
        {
          element: makeElement(),
        },
      );
      expect(result).toStrictEqual({
        clicked: true,
        target: 'a11yRef:e1',
      });
    });

    it('resolves testId target', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.click('testId', 'confirm-button', new Map(), 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'confirm-button',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('throws for selector target type', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.click('selector', 'my-element', new Map(), 5000),
      ).rejects.toThrowError('CSS selectors are not supported on mobile');
    });

    it('throws for unknown a11yRef', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.click('a11yRef', 'e99', new Map(), 5000),
      ).rejects.toThrowError('Unknown a11yRef: e99');
    });

    it('throws for an unknown target type', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.click('bogus' as unknown as 'testId', 'x', new Map(), 5000),
      ).rejects.toThrowError('Unknown target type: bogus');
    });

    it('resolves a11yRef with no-colon stable id as identifier', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'bare-id']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'bare-id',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('resolves a11yRef with unknown prefix as identifier', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'custom:some-value']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'custom:some-value',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('throws when within scope is provided', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.click('testId', 'btn', new Map(), 5000, {
          type: 'testId',
          value: 'parent',
        }),
      ).rejects.toThrowError('not supported on mobile');
    });

    it('resolves label|type stable id via parseStableIdentifier', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'label:OK|type:Button']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          label: 'OK',
          type: 'Button',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('disambiguates same-label elements by type', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([
        ['e1', 'label:OK|type:Button'],
        ['e2', 'label:OK|type:StaticText'],
      ]);

      await driver.click('a11yRef', 'e1', refMap, 5000);
      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          label: 'OK',
          type: 'Button',
        },
        {
          element: makeElement(),
        },
      );

      await driver.click('a11yRef', 'e2', refMap, 5000);
      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          label: 'OK',
          type: 'StaticText',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('resolves value|type stable id with type in query', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'value:0.5 ETH|type:StaticText']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          text: '0.5 ETH',
          type: 'StaticText',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('ignores unknown pipe segments in stable id', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'label:OK|unknown']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        { label: 'OK' },
        {
          element: makeElement(),
        },
      );
    });

    it('falls back to identifier for unknown prefix in stable id', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'custom:something|type:Button']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'custom:something',
          type: 'Button',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('handles stable id with no pipe segments', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'identifier:submit-btn']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'submit-btn',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('treats bare string without colon as identifier', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'rawvalue']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'rawvalue',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('skips non-type keyed pipe segments in stable id', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'label:OK|extra:info|type:Button']]);

      await driver.click('a11yRef', 'e1', refMap, 5000);

      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          label: 'OK',
          type: 'Button',
        },
        {
          element: makeElement(),
        },
      );
    });

    it('throws when timeout budget is exceeded after waitForElement', async () => {
      const backend = createMockBackend({
        waitForElement: vi
          .fn()
          .mockImplementation(
            async () => new Promise((resolve) => setTimeout(resolve, 50)),
          ),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click('testId', 'btn', new Map(), 1),
      ).rejects.toThrowError('Timeout exceeded');
    });

    it('throws when tapElement exceeds remaining budget', async () => {
      const backend = createMockBackend({
        tapElement: vi
          .fn()
          .mockImplementation(
            async () => new Promise((resolve) => setTimeout(resolve, 200)),
          ),
      });
      const driver = new MobilePlatformDriver(backend);

      await expect(
        driver.click('testId', 'btn', new Map(), 50),
      ).rejects.toThrowError('Timeout exceeded during tapElement');
    });
  });

  describe('abort during the target wait', () => {
    it('does not tap when the signal aborts while waiting', async () => {
      const controller = new AbortController();
      const reason = new Error('Tool execution timed out after 30000ms');
      const backend = createMockBackend({
        waitForElement: vi.fn().mockImplementation(async () => {
          controller.abort(reason);
          return makeElement();
        }),
      });
      const driver = new MobilePlatformDriver(backend);

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
      expect(backend.tapElement).not.toHaveBeenCalled();
    });

    it('does not tap or type when the signal aborts while waiting', async () => {
      const controller = new AbortController();
      const backend = createMockBackend({
        waitForElement: vi.fn().mockImplementation(async () => {
          controller.abort(new Error('timed out'));
          return makeElement();
        }),
      });
      const driver = new MobilePlatformDriver(backend);

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
      expect(backend.tapElement).not.toHaveBeenCalled();
      expect(backend.typeText).not.toHaveBeenCalled();
    });

    it('taps and types when the signal is not aborted', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);
      const { signal } = new AbortController();

      await driver.click('testId', 'btn', new Map(), 5000, undefined, signal);
      await driver.type(
        'testId',
        'input',
        'text',
        new Map(),
        5000,
        undefined,
        signal,
      );

      expect(backend.tapElement).toHaveBeenCalledTimes(2);
      expect(backend.typeText).toHaveBeenCalledWith('text');
    });

    it('does not type when the signal aborts during the focus tap', async () => {
      const controller = new AbortController();
      const backend = createMockBackend({
        tapElement: vi.fn().mockImplementation(async () => {
          controller.abort(new Error('timed out'));
          return { success: true, x: 1, y: 1, targetDescription: 'input' };
        }),
      });
      const driver = new MobilePlatformDriver(backend);

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
      expect(backend.typeText).not.toHaveBeenCalled();
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
      expect(backend.tapElement).toHaveBeenCalledWith(
        {
          identifier: 'password-input',
        },
        {
          element: makeElement(),
        },
      );
      expect(backend.typeText).toHaveBeenCalledWith('secret123');
      expect(result).toStrictEqual({
        typed: true,
        target: 'testId:password-input',
        textLength: 9,
      });
    });

    it('throws when within scope is provided', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.type('testId', 'input', 'text', new Map(), 5000, {
          type: 'testId',
          value: 'parent',
        }),
      ).rejects.toThrowError('not supported on mobile');
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

    it('throws when within scope is provided', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.waitForElement('testId', 'el', new Map(), 5000, {
          type: 'testId',
          value: 'parent',
        }),
      ).rejects.toThrowError('not supported on mobile');
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

    it('throws when within scope is provided', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      await expect(
        driver.getText('testId', 'el', new Map(), 5000, {
          type: 'testId',
          value: 'parent',
        }),
      ).rejects.toThrowError('not supported on mobile');
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
        testId: 'submit-btn',
        bounds: { x: 0, y: 0, width: 100, height: 44 },
      });
      expect(nodes[1]).toStrictEqual({
        ref: 'e2',
        role: 'TextField',
        name: 'Email',
        disabled: true,
        textContent: 'user@test.com',
        bounds: { x: 0, y: 0, width: 100, height: 44 },
      });
      expect(refMap.get('e1')).toBe('identifier:submit-btn');
      expect(refMap.get('e2')).toBe('label:Email|type:TextField');
    });

    it('omits bounds for elements with zero-size frames', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Container',
              label: 'Frameless',
              frame: { x: 0, y: 0, width: 0, height: 0 },
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes[0].bounds).toBeUndefined();
    });

    it('assigns sequential refs to nested children, with no path', async () => {
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

      expect(nodes.map((node) => node.ref)).toStrictEqual(['e1', 'e2', 'e3']);
      for (const node of nodes) {
        expect(node).not.toHaveProperty('path');
      }
    });

    it.each(['ios', 'android'] as const)(
      'emits no path on %s',
      async (platform) => {
        const button = platform === 'ios' ? 'Button' : 'android.widget.Button';
        const backend = createMockBackend({
          platform,
          snapshot: vi.fn().mockResolvedValue({
            platform,
            hierarchy: [
              makeElement({
                type: 'Container',
                identifier: 'root',
                children: [
                  makeElement({
                    type: 'Container',
                    identifier: 'row',
                    children: [
                      makeElement({ type: button, label: 'OK' }),
                      makeElement({ type: button, label: 'Cancel' }),
                    ],
                  }),
                ],
              }),
            ],
            raw: '[]',
            timestamp: Date.now(),
          }),
        });
        const driver = new MobilePlatformDriver(backend);

        const screen = await driver.captureScreen();
        const tree = await driver.getAccessibilityTree();

        expect(tree.nodes).toHaveLength(4);
        for (const node of [...tree.nodes, ...screen.nodes]) {
          expect(node).not.toHaveProperty('path');
        }
      },
    );

    describe('layout-only nodes (P1-14)', () => {
      const snapshotWith = (
        platform: 'ios' | 'android',
        hierarchy: UIElement[],
      ): DeviceBackend =>
        createMockBackend({
          platform,
          snapshot: vi.fn().mockResolvedValue({
            platform,
            hierarchy,
            raw: '[]',
            timestamp: Date.now(),
          }),
        });

      it('drops unnamed containers and hoists their children in order', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('android', [
            makeElement({
              type: 'android.widget.FrameLayout',
              children: [
                makeElement({
                  type: 'android.view.ViewGroup',
                  children: [
                    makeElement({
                      type: 'android.widget.TextView',
                      value: 'A',
                    }),
                    makeElement({
                      type: 'android.view.ViewGroup',
                      children: [
                        makeElement({
                          type: 'android.widget.TextView',
                          value: 'B',
                        }),
                      ],
                    }),
                  ],
                }),
                makeElement({ type: 'android.widget.TextView', value: 'C' }),
                // Unnamed, no testId, no kept descendant, and too small
                // to be a tap target (a 1 px divider).
                makeElement({
                  type: 'android.view.ViewGroup',
                  frame: { x: 0, y: 0, width: 1080, height: 1 },
                  children: [makeElement({ type: 'android.view.View' })],
                }),
              ],
            }),
          ]),
        );

        const { nodes, refMap } = await driver.getAccessibilityTree();

        expect(nodes.map(({ ref, name }) => [ref, name])).toStrictEqual([
          ['e1', 'A'],
          ['e2', 'B'],
          ['e3', 'C'],
        ]);
        expect([...refMap]).toStrictEqual([
          ['e1', 'value:A|type:android.widget.TextView'],
          ['e2', 'value:B|type:android.widget.TextView'],
          ['e3', 'value:C|type:android.widget.TextView'],
        ]);
      });

      it('keeps containers with a testId, actionable controls, text and disabled state', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('ios', [
            makeElement({
              type: 'UIView',
              children: [
                makeElement({
                  type: 'RCTViewComponentView',
                  identifier: 'wallet-screen',
                  children: [
                    makeElement({ type: 'StaticText', label: 'Balance' }),
                    makeElement({ type: 'SecureTextField', enabled: false }),
                    makeElement({ type: 'UIActivityIndicatorView' }),
                  ],
                }),
              ],
            }),
          ]),
        );

        const { nodes, refMap } = await driver.getAccessibilityTree();

        expect(nodes).toStrictEqual([
          expect.objectContaining({
            ref: 'e1',
            role: 'RCTViewComponentView',
            testId: 'wallet-screen',
          }),
          expect.objectContaining({ ref: 'e2', name: 'Balance' }),
          expect.objectContaining({
            ref: 'e3',
            role: 'SecureTextField',
            name: '',
            disabled: true,
          }),
          expect.objectContaining({
            ref: 'e4',
            role: 'UIActivityIndicatorView',
          }),
        ]);
        // Only nodes with a testId, label or value can be resolved.
        expect([...refMap.keys()]).toStrictEqual(['e1', 'e2']);
      });

      it('gives a dropped node no ref, so every ref resolves', async () => {
        const backend = snapshotWith('android', [
          makeElement({
            type: 'android.view.ViewGroup',
            children: [
              makeElement({
                type: 'android.widget.Button',
                identifier: 'send',
                label: 'Send',
              }),
            ],
          }),
        ]);
        const driver = new MobilePlatformDriver(backend);

        const { nodes, refMap } = await driver.getAccessibilityTree();

        expect(nodes.map((node) => node.ref)).toStrictEqual(['e1']);
        expect([...refMap]).toStrictEqual([['e1', 'identifier:send']]);
        await driver.click('a11yRef', 'e1', refMap, 1000);
        expect(backend.tapElement).toHaveBeenCalledWith(
          { identifier: 'send' },
          {
            element: makeElement(),
          },
        );
        await expect(
          driver.click('a11yRef', 'e2', refMap, 1000),
        ).rejects.toThrowError('Unknown a11yRef: e2');
      });

      it('marks ambiguity over the kept nodes only', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('ios', [
            makeElement({
              type: 'UIView',
              children: [
                makeElement({ type: 'Button', label: 'OK' }),
                makeElement({
                  type: 'UIView',
                  children: [makeElement({ type: 'Button', label: 'OK' })],
                }),
                makeElement({ type: 'Button', label: 'Cancel' }),
              ],
            }),
          ]),
        );

        const { nodes } = await driver.getAccessibilityTree();

        expect(
          nodes.map(({ ref, name, ambiguous }) => [ref, name, ambiguous]),
        ).toStrictEqual([
          ['e1', 'OK', true],
          ['e2', 'OK', true],
          ['e3', 'Cancel', undefined],
        ]);
      });

      it('lists an unlabelled tap target with bounds but no ref', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('ios', [
            makeElement({
              type: 'UIView',
              children: [
                // A Pressable icon: an unlabelled RN view, 48x48.
                makeElement({
                  type: 'RCTViewComponentView',
                  frame: { x: 10, y: 20, width: 48, height: 48 },
                  children: [makeElement({ type: 'RNSVGPath' })],
                }),
                // Too small: a spacer or divider.
                makeElement({
                  type: 'RCTViewComponentView',
                  frame: { x: 0, y: 80, width: 300, height: 1 },
                }),
                // Not a plain RN view.
                makeElement({
                  type: 'UIView',
                  frame: { x: 0, y: 100, width: 300, height: 300 },
                }),
                makeElement({ type: 'Button', label: 'Send' }),
              ],
            }),
          ]),
        );

        const { nodes, refMap } = await driver.getAccessibilityTree();

        expect(nodes).toStrictEqual([
          {
            ref: 'e1',
            role: 'RCTViewComponentView',
            name: '',
            bounds: { x: 10, y: 20, width: 48, height: 48 },
          },
          expect.objectContaining({ ref: 'e2', name: 'Send' }),
        ]);
        expect([...refMap]).toStrictEqual([['e2', 'label:Send|type:Button']]);
      });

      it('reduces the real Android login snapshot (47 -> 15 nodes)', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('android', androidLoginSnapshot as UIElement[]),
        );

        const { nodes, refMap } = await driver.getAccessibilityTree();

        // After filterAppHierarchy: 47 elements. 32 are layout-only
        // (unnamed FrameLayout/View/ScrollView/WebView/small ViewGroups...);
        // 3 unlabelled ViewGroup leaves are kept as tap targets (no ref).
        expect(
          nodes.map((node) => node.testId ?? (node.name || node.role)),
        ).toStrictEqual([
          'io.metamask:id/action_bar_root',
          'android:id/content',
          'android.view.ViewGroup',
          'npm:@metamask/bitcoin-wallet-snap',
          'android.view.ViewGroup',
          'login',
          'login-download-logs-button',
          'metamask-wordmark',
          'android.view.ViewGroup',
          'login-password-input',
          'log-in-button',
          'Unlock',
          'reset-wallet-button',
          'Forgot password?',
          'fox-animation',
        ]);
        expect(nodes.map((node) => node.ref)).toStrictEqual(
          nodes.map((_node, index) => `e${index + 1}`),
        );
        expect([...refMap.keys()]).toStrictEqual(
          nodes
            .filter((node) => node.testId ?? node.name)
            .map((node) => node.ref),
        );
        expect(
          nodes
            .filter((node) => !refMap.has(node.ref))
            .map((node) => node.bounds),
        ).toStrictEqual([
          { x: 0, y: 0, width: 1080, height: 2400 },
          { x: 0, y: 0, width: 1080, height: 2400 },
          { x: 42, y: 1232, width: 996, height: 126 },
        ]);
        // Before P1-14 (with path): 24154 bytes. Without path and layout-only
        // nodes: about 2 kB.
        expect(JSON.stringify(nodes).length).toBeLessThan(2500);
      });

      it('keeps the buttons, tabs and unlabelled action buttons of the real iOS wallet home (183 -> 67 nodes)', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('ios', iosWalletHomeSnapshot()),
        );

        const { nodes, refMap } = await driver.getAccessibilityTree();

        // 183 elements; 6 are the DevLauncher window (filterAppHierarchy).
        // 57 have a testId or a name; 10 are unlabelled tap targets.
        expect(nodes).toHaveLength(67);
        expect(
          nodes.filter((node) => node.role === 'Button').map((n) => n.name),
        ).toStrictEqual([
          'Open my profile',
          'Agent Account',
          '$<AMT>, $<AMT>, (<PCT>%), Today',
          'Money, $<AMT>, <PCT>%, <PCT>% APY',
          'Tokens, $<AMT>, <PCT>%',
          'Perps, $<AMT>, <PCT>%',
          'Tokens',
          'Perps',
          'Predictions',
          'BTC Price: \u2014, Price to beat: \u2014, Live, --:--',
          'Watchlist',
          'Top traders',
          'DeFi',
          'Import a token',
          'Import an NFT',
          'Contact support',
          'Home',
          'Explore',
          'Money',
          'Social',
          'Trade',
        ]);
        // The 4 unlabelled action buttons (Buy, Swap, Send, Receive) right
        // after `wallet-action-buttons`: listed with bounds, no ref.
        const actions = nodes.findIndex(
          (node) => node.testId === 'wallet-action-buttons',
        );
        const actionButtons = nodes.slice(actions + 1, actions + 5);
        expect(
          actionButtons.map(({ role, name, bounds }) => ({
            role,
            name,
            x: Math.round(bounds?.x ?? -1),
            y: bounds?.y,
          })),
        ).toStrictEqual([
          { role: 'RCTViewComponentView', name: '', x: 16, y: 242 },
          { role: 'RCTViewComponentView', name: '', x: 111, y: 242 },
          { role: 'RCTViewComponentView', name: '', x: 205, y: 242 },
          { role: 'RCTViewComponentView', name: '', x: 300, y: 242 },
        ]);
        for (const button of actionButtons) {
          expect(refMap.has(button.ref)).toBe(false);
        }
        // Every node with a testId or a name has a ref that resolves.
        expect([...refMap.keys()]).toStrictEqual(
          nodes
            .filter((node) => node.testId ?? node.name)
            .map((node) => node.ref),
        );
        expect(refMap.size).toBe(57);
        // P1-14 AC1: at most 15 kB (was 183 kB with path, 55 kB flat).
        expect(JSON.stringify(nodes).length).toBeLessThan(11_000);
      });

      it('writes bounds with a fixed key order', async () => {
        const driver = new MobilePlatformDriver(
          snapshotWith('ios', [
            makeElement({
              type: 'Button',
              label: 'OK',
              // idb returns frame keys in varying order.
              frame: { height: 44, width: 100, y: 20, x: 10 },
            }),
          ]),
        );

        const { nodes } = await driver.getAccessibilityTree();

        expect(Object.keys(nodes[0]?.bounds ?? {})).toStrictEqual([
          'x',
          'y',
          'width',
          'height',
        ]);
        expect(JSON.stringify(nodes[0]?.bounds)).toBe(
          '{"x":10,"y":20,"width":100,"height":44}',
        );
      });
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

      expect(refMap.get('e1')).toBe('value:0.5 ETH|type:StaticText');
    });

    it('flags ambiguous nodes with duplicate stable ids', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({ type: 'Button', label: 'OK' }),
            makeElement({ type: 'Button', label: 'OK' }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes[0].ambiguous).toBe(true);
      expect(nodes[1].ambiguous).toBe(true);
    });

    it('does not flag nodes with same label but different types', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({ type: 'Button', label: 'OK' }),
            makeElement({ type: 'Link', label: 'OK' }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes, refMap } = await driver.getAccessibilityTree();

      expect(refMap.get('e1')).toBe('label:OK|type:Button');
      expect(refMap.get('e2')).toBe('label:OK|type:Link');
      expect(nodes[0].ambiguous).toBeUndefined();
      expect(nodes[1].ambiguous).toBeUndefined();
    });

    it('does not flag identifier-based refs', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({ type: 'Button', identifier: 'ok-btn', label: 'OK' }),
            makeElement({ type: 'Button', label: 'OK' }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const { nodes } = await driver.getAccessibilityTree();

      expect(nodes[0].ambiguous).toBeUndefined();
      expect(nodes[1].ambiguous).toBeUndefined();
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

    it('collects identifiers from nested children', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Window',
              children: [makeElement({ identifier: 'child-btn', label: 'OK' })],
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items).toHaveLength(1);
      expect(items[0].testId).toBe('child-btn');
    });

    it('marks elements outside the viewport as not visible', async () => {
      const backend = createMockBackend({
        getWindowSize: vi.fn().mockResolvedValue({ width: 402, height: 874 }),
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              identifier: 'on-screen-btn',
              label: 'On screen',
              frame: { x: 0, y: 100, width: 402, height: 44 },
            }),
            makeElement({
              type: 'StaticText',
              identifier: 'below-fold-header',
              label: 'Predictions',
              frame: { x: 0, y: 1000, width: 402, height: 44 },
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items[0]).toStrictEqual({
        testId: 'on-screen-btn',
        tag: 'Button',
        text: 'On screen',
        visible: true,
      });
      expect(items[1]).toStrictEqual({
        testId: 'below-fold-header',
        tag: 'StaticText',
        text: 'Predictions',
        visible: false,
      });
    });

    it('marks partially visible elements as visible', async () => {
      const backend = createMockBackend({
        getWindowSize: vi.fn().mockResolvedValue({ width: 402, height: 874 }),
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              identifier: 'peeking-btn',
              frame: { x: 0, y: 800, width: 402, height: 150 },
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items[0].visible).toBe(true);
    });

    it('assumes visibility when the viewport is unavailable', async () => {
      const backend = createMockBackend({
        getWindowSize: vi
          .fn()
          .mockRejectedValue(
            new Error('Unable to determine window size from device'),
          ),
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              identifier: 'somewhere-btn',
              frame: { x: 0, y: 5000, width: 402, height: 44 },
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items[0].visible).toBe(true);
    });

    it('assumes visibility for elements with zero-size frames', async () => {
      const backend = createMockBackend({
        getWindowSize: vi.fn().mockResolvedValue({ width: 402, height: 874 }),
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Container',
              identifier: 'frameless-container',
              frame: { x: 0, y: 0, width: 0, height: 0 },
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const items = await driver.getTestIds();

      expect(items[0].visible).toBe(true);
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
    it('skips base64 encoding by default and omits unavailable dimensions', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.screenshot({ name: 'test-shot' });

      expect(backend.screenshot).toHaveBeenCalledWith(undefined, {
        encode: false,
      });
      expect(result).toStrictEqual({
        path: '/tmp/screenshot.png',
        base64: '',
      });
    });

    it('includes base64 when requested', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.screenshot({
        name: 'test-shot',
        includeBase64: true,
      });

      expect(backend.screenshot).toHaveBeenCalledWith(undefined, {
        encode: true,
      });
      expect(result.base64).toBe('base64data');
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
    it('returns only what it knows for a running app, marked as a stub', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      const state = await driver.getAppState();

      expect(state).toStrictEqual({
        isLoaded: true,
        extensionId: 'io.metamask',
        source: 'stub',
      });
    });

    it('returns isLoaded true for Appium foreground state code', async () => {
      const backend = createMockBackend({
        getAppState: vi.fn().mockResolvedValue({
          bundleId: 'io.metamask',
          state: '4',
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const state = await driver.getAppState();

      expect(state.isLoaded).toBe(true);
      expect(state).not.toHaveProperty('isUnlocked');
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
      expect(state).not.toHaveProperty('isUnlocked');
    });

    it('uses custom bundleId', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend, 'com.example.app');

      await driver.getAppState();

      expect(backend.getAppState).toHaveBeenCalledWith('com.example.app');
    });
  });

  describe('swipe', () => {
    it('delegates direction and optional params', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.swipe('up', 100, 200, 500);

      expect(backend.swipe).toHaveBeenCalledWith('up', 100, 200, 500);
    });

    it('works with direction only', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.swipe('down');

      expect(backend.swipe).toHaveBeenCalledWith(
        'down',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('scrollToElement', () => {
    it('maps the content direction to the opposite finger direction', async () => {
      const backend = createMockBackend({
        scrollToElement: vi.fn().mockResolvedValue(makeElement()),
      });
      const driver = new MobilePlatformDriver(backend);
      const refMap = new Map([['e1', 'identifier:footer']]);

      // Content down (reveal below) = finger up.
      await driver.scrollToElement('a11yRef', 'e1', refMap, 'down', 5);
      await driver.scrollToElement('a11yRef', 'e1', refMap, 'up', 5);

      expect(vi.mocked(backend.scrollToElement).mock.calls).toStrictEqual([
        [{ identifier: 'footer' }, 'up', 5],
        [{ identifier: 'footer' }, 'down', 5],
      ]);
    });

    it('leaves the direction to device-mcp by default (auto)', async () => {
      const backend = createMockBackend({
        scrollToElement: vi.fn().mockResolvedValue(makeElement()),
      });
      const driver = new MobilePlatformDriver(backend);

      await driver.scrollToElement('testId', 'terms-section', new Map());
      await driver.scrollToElement(
        'testId',
        'terms-section',
        new Map(),
        'auto',
      );

      expect(vi.mocked(backend.scrollToElement).mock.calls).toStrictEqual([
        [{ identifier: 'terms-section' }, undefined, undefined],
        [{ identifier: 'terms-section' }, undefined, undefined],
      ]);
    });

    it('returns swipes, inViewport and bounds from a viewport-checking device-mcp', async () => {
      const element = makeElement({
        frame: { x: 16, y: 646, width: 370, height: 24 },
      });
      const backend = createMockBackend({
        scrollToElement: vi.fn().mockResolvedValue({
          element,
          swipes: 1,
          inViewport: true,
        }) as unknown as DeviceBackend['scrollToElement'],
      });
      const driver = new MobilePlatformDriver(backend);

      const outcome = await driver.scrollToElement('testId', 'row', new Map());

      expect(outcome).toStrictEqual({
        swipes: 1,
        inViewport: true,
        bounds: { x: 16, y: 646, width: 370, height: 24 },
      });
    });

    it('returns only the bounds from device-mcp 0.7.0 (element only)', async () => {
      const backend = createMockBackend({
        scrollToElement: vi
          .fn()
          .mockResolvedValue(
            makeElement({ frame: { x: 1, y: 996, width: 2, height: 3 } }),
          ),
      });
      const driver = new MobilePlatformDriver(backend);

      expect(
        await driver.scrollToElement('testId', 'row', new Map()),
      ).toStrictEqual({ bounds: { x: 1, y: 996, width: 2, height: 3 } });
    });

    it('returns nothing for an object without a frame', async () => {
      const backend = createMockBackend({
        scrollToElement: vi
          .fn()
          .mockResolvedValue({}) as unknown as DeviceBackend['scrollToElement'],
      });
      const driver = new MobilePlatformDriver(backend);

      expect(
        await driver.scrollToElement('testId', 'row', new Map()),
      ).toStrictEqual({});
    });

    it('returns nothing for an unexpected backend result', async () => {
      const backend = createMockBackend({
        scrollToElement: vi
          .fn()
          .mockResolvedValue(
            undefined,
          ) as unknown as DeviceBackend['scrollToElement'],
      });
      const driver = new MobilePlatformDriver(backend);

      expect(
        await driver.scrollToElement('testId', 'row', new Map()),
      ).toStrictEqual({});
    });
  });

  describe('longPress', () => {
    it('resolves target and delegates with duration', async () => {
      const backend = createMockBackend({
        longPress: vi.fn().mockResolvedValue({
          success: true,
          x: 50,
          y: 50,
          targetDescription: 'Button',
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      await driver.longPress('testId', 'token-row', new Map(), 2000);

      expect(backend.longPress).toHaveBeenCalledWith(
        { identifier: 'token-row' },
        2000,
      );
    });
  });

  describe('tapCoordinates', () => {
    it('delegates x and y', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.tapCoordinates(150, 300);

      expect(backend.tapCoordinates).toHaveBeenCalledWith(150, 300);
    });
  });

  describe('dismissKeyboard', () => {
    it('delegates to backend', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.dismissKeyboard();

      expect(backend.dismissKeyboard).toHaveBeenCalledOnce();
    });
  });

  describe('dismissAlert', () => {
    it('delegates accept=true', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.dismissAlert(true);

      expect(backend.dismissAlert).toHaveBeenCalledWith(true);
    });

    it('delegates accept=false', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.dismissAlert(false);

      expect(backend.dismissAlert).toHaveBeenCalledWith(false);
    });
  });

  describe('getAlertText', () => {
    it('returns backend result', async () => {
      const backend = createMockBackend({
        getAlertText: vi.fn().mockResolvedValue('Allow location access?'),
      });
      const driver = new MobilePlatformDriver(backend);

      const text = await driver.getAlertText();

      expect(text).toBe('Allow location access?');
    });
  });

  describe('getWindowSize', () => {
    it('returns backend dimensions', async () => {
      const backend = createMockBackend({
        getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
      });
      const driver = new MobilePlatformDriver(backend);

      const size = await driver.getWindowSize();

      expect(size).toStrictEqual({ width: 390, height: 844 });
    });
  });

  describe('openApp', () => {
    it('delegates bundleId', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.openApp('io.metamask');

      expect(backend.openApp).toHaveBeenCalledWith('io.metamask');
    });
  });

  describe('closeApp', () => {
    it('delegates bundleId', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.closeApp('io.metamask');

      expect(backend.closeApp).toHaveBeenCalledWith('io.metamask');
    });
  });

  describe('pressButton', () => {
    it('delegates button name', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.pressButton('home');

      expect(backend.pressButton).toHaveBeenCalledWith('home');
    });
  });

  describe('getDeviceContexts', () => {
    it('returns backend contexts', async () => {
      const backend = createMockBackend({
        getContexts: vi.fn().mockResolvedValue(['NATIVE_APP', 'WEBVIEW_1234']),
      });
      const driver = new MobilePlatformDriver(backend);

      const contexts = await driver.getDeviceContexts();

      expect(contexts).toStrictEqual(['NATIVE_APP', 'WEBVIEW_1234']);
    });
  });

  describe('setDeviceContext', () => {
    it('delegates context name', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.setDeviceContext('WEBVIEW_1234');

      expect(backend.setContext).toHaveBeenCalledWith('WEBVIEW_1234');
    });
  });

  describe('getClipboard', () => {
    it('returns backend clipboard text', async () => {
      const backend = createMockBackend({
        getClipboard: vi.fn().mockResolvedValue('0x1234abcd'),
      });
      const driver = new MobilePlatformDriver(backend);

      const text = await driver.getClipboard();

      expect(text).toBe('0x1234abcd');
    });
  });

  describe('setClipboard', () => {
    it('delegates text', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.setClipboard('0x1234abcd');

      expect(backend.setClipboard).toHaveBeenCalledWith('0x1234abcd');
    });
  });

  describe('startScreenRecording', () => {
    it('delegates with output path', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.startScreenRecording('/tmp/recording.mp4');

      expect(backend.startScreenRecording).toHaveBeenCalledWith(
        '/tmp/recording.mp4',
      );
    });

    it('works without output path', async () => {
      const backend = createMockBackend();
      const driver = new MobilePlatformDriver(backend);

      await driver.startScreenRecording();

      expect(backend.startScreenRecording).toHaveBeenCalledWith(undefined);
    });
  });

  describe('stopScreenRecording', () => {
    it('returns file path from backend', async () => {
      const backend = createMockBackend({
        stopScreenRecording: vi.fn().mockResolvedValue('/tmp/recording.mp4'),
      });
      const driver = new MobilePlatformDriver(backend);

      const path = await driver.stopScreenRecording();

      expect(path).toBe('/tmp/recording.mp4');
    });
  });

  describe('getLogs', () => {
    it('delegates params and returns result', async () => {
      const logsResult = {
        entries: [
          { timestamp: '2025-01-01T00:00:00Z', level: 'info', message: 'ok' },
        ],
        source: 'syslog',
      };
      const backend = createMockBackend({
        getLogs: vi.fn().mockResolvedValue(logsResult),
      });
      const driver = new MobilePlatformDriver(backend);

      const result = await driver.getLogs(30, 'MetaMask');

      expect(backend.getLogs).toHaveBeenCalledWith(30, 'MetaMask');
      expect(result).toStrictEqual(logsResult);
    });
  });

  describe('generateLocators', () => {
    it('snapshots the device and returns locators for interactive elements', async () => {
      const backend = createMockBackend({
        snapshot: vi.fn().mockResolvedValue({
          platform: 'ios',
          hierarchy: [
            makeElement({
              type: 'Button',
              identifier: 'submit',
              label: 'Submit',
            }),
          ],
          raw: '[]',
          timestamp: Date.now(),
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const locators = await driver.generateLocators();

      expect(backend.snapshot).toHaveBeenCalledWith();
      expect(locators).toHaveLength(1);
      expect(locators[0]?.suggestions[0]).toStrictEqual({
        strategy: 'identifier',
        value: 'submit',
        confidence: 'high',
      });
    });

    it('leaves out the status bar and the DevLauncher overlay', async () => {
      const backend = createMockBackend({
        platform: 'android',
        snapshot: vi.fn().mockResolvedValue({
          platform: 'android',
          hierarchy: androidLoginSnapshot,
          raw: '',
          timestamp: 0,
        }),
      });
      const driver = new MobilePlatformDriver(backend);

      const locators = await driver.generateLocators();

      expect(backend.snapshot).toHaveBeenCalledTimes(1);
      const values = locators.flatMap((locator) =>
        locator.suggestions.map((suggestion) => suggestion.value),
      );
      expect(values).toContain('log-in-button');
      expect(values.join(' ')).not.toMatch(/systemui|Tools/u);
    });

    it('returns an empty list when the snapshot has no interactive elements', async () => {
      const driver = new MobilePlatformDriver(createMockBackend());

      const locators = await driver.generateLocators();

      expect(locators).toStrictEqual([]);
    });
  });
});

describe('MobilePlatformDriver refs across layout changes', () => {
  it('keeps mobile refs when only layout-only containers change (P1-14)', async () => {
    const element = (
      type: string,
      extra: Partial<UIElement> = {},
      children?: UIElement[],
    ): UIElement => ({
      type,
      frame: { x: 0, y: 0, width: 10, height: 10 },
      enabled: true,
      ...extra,
      ...(children ? { children } : {}),
    });
    const send = element('android.widget.Button', {
      identifier: 'send',
      label: 'Send',
    });
    const swap = element('android.widget.Button', { label: 'Swap' });
    const readTree = async (hierarchy: UIElement[]) =>
      new MobilePlatformDriver({
        platform: 'android',
        snapshot: async () => ({
          platform: 'android',
          hierarchy,
          raw: '',
          timestamp: 0,
        }),
      } as unknown as DeviceBackend).getAccessibilityTree();

    const previous = await readTree([
      element('android.view.ViewGroup', {}, [send, swap]),
    ]);
    // Two more unnamed wrappers, and an unnamed zero-height spacer.
    const next = await readTree([
      element('android.widget.FrameLayout', {}, [
        element('android.view.ViewGroup', {}, [
          element('android.view.ViewGroup', {}, [send]),
          element('android.view.View', {
            frame: { x: 0, y: 0, width: 10, height: 0 },
          }),
          swap,
        ]),
      ]),
    ]);

    expect(next.nodes).toStrictEqual(previous.nodes);
    expect([...next.refMap]).toStrictEqual([...previous.refMap]);
    expect(previous.nodes.map((node) => node.path)).toStrictEqual([
      undefined,
      undefined,
    ]);
  });
});
