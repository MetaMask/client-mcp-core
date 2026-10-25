import type { UIElement } from '@metamask/device-mcp';
import { describe, it, expect } from 'vitest';

import androidLoginSnapshot from './__fixtures__/android-login-snapshot.json';
import {
  filterAppHierarchy,
  resourceIdPackage,
  viewportFromHierarchy,
} from './mobile-hierarchy.js';

function el(
  type: string,
  overrides: Partial<UIElement> = {},
  children?: UIElement[],
): UIElement {
  return {
    type,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    enabled: true,
    ...overrides,
    ...(children ? { children } : {}),
  };
}

function identifiers(elements: UIElement[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: UIElement[]): void => {
    for (const node of nodes) {
      if (node.identifier) {
        ids.push(node.identifier);
      }
      walk(node.children ?? []);
    }
  };
  walk(elements);
  return ids;
}

function labels(elements: UIElement[]): string[] {
  const out: string[] = [];
  const walk = (nodes: UIElement[]): void => {
    for (const node of nodes) {
      if (node.label) {
        out.push(node.label);
      }
      walk(node.children ?? []);
    }
  };
  walk(elements);
  return out;
}

/**
 * Shaped like a real Android (adb, uiautomator) snapshot of MetaMask: a
 * status bar window from System UI, then the app window, which holds the
 * Expo DevLauncher "Tools" button in a Compose view and the React Native
 * screen (proof/p1-08/android/describe-screen.txt).
 *
 * @returns The hierarchy.
 */
function androidSnapshot(): UIElement[] {
  const frame = (x: number, y: number, width: number, height: number) => ({
    frame: { x, y, width, height },
  });
  return [
    el('android.widget.FrameLayout', frame(0, 0, 1080, 63), [
      el(
        'android.widget.FrameLayout',
        {
          identifier: 'com.android.systemui:id/status_bar_container',
          ...frame(0, 0, 1080, 63),
        },
        [
          el(
            'android.widget.FrameLayout',
            {
              identifier: 'com.android.systemui:id/status_bar',
              ...frame(0, 0, 1080, 63),
            },
            [
              el('android.widget.TextView', {
                identifier: 'com.android.systemui:id/clock',
                value: '12:46 AM',
              }),
              el('android.widget.FrameLayout', {
                identifier: 'com.android.systemui:id/wifi_combo',
              }),
            ],
          ),
        ],
      ),
      el('android.view.View', { label: 'Battery 100 percent.' }),
    ]),
    el('android.widget.FrameLayout', frame(0, 0, 1080, 2400), [
      el(
        'android.widget.LinearLayout',
        {
          identifier: 'io.metamask:id/action_bar_root',
          ...frame(0, 0, 1080, 2400),
        },
        [
          el(
            'android.widget.FrameLayout',
            { identifier: 'android:id/content', ...frame(0, 0, 1080, 2400) },
            [
              el('androidx.compose.ui.platform.ComposeView', {}, [
                el('android.view.View', {}, [
                  el('android.widget.ImageView', {
                    label: 'Tools',
                    ...frame(937, 140, 68, 68),
                  }),
                ]),
              ]),
              el('android.view.ViewGroup', {}, [
                el('android.view.ViewGroup', { identifier: 'wallet-screen' }),
                el('android.widget.Button', {
                  identifier: 'tab-bar-item-Wallet',
                  label: 'Wallet',
                }),
                el('android.widget.TextView', { value: 'Tools' }),
              ]),
            ],
          ),
        ],
      ),
    ]),
  ];
}

/**
 * Shaped like a real iOS (idb describe-all) snapshot of a development build:
 * the app element, then the DevLauncher window with the gear image and its
 * "Tools" text (proof/p1-26/ios/launch.txt).
 *
 * @returns The hierarchy.
 */
function iosSnapshot(): UIElement[] {
  const screen = { frame: { x: 0, y: 0, width: 402, height: 874 } };
  return [
    el('Other', { label: 'MetaMask', ...screen }, [
      el('Application', screen, [
        el('Button', { identifier: 'log-in-button', label: 'Unlock' }),
        el('StaticText', { label: 'Tools' }),
      ]),
      el('Application', screen, [
        el('UITransitionView', screen, [
          el('UIDropShadowView', screen, [
            el('_UIHostingView', screen, [
              el('SwiftUI.AccessibilityNode', screen, [
                el('Image', {
                  identifier: 'gearshape.fill',
                  label: 'Gear Shape, Filled',
                }),
                el('StaticText', { label: 'Tools' }),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ];
}

describe('resourceIdPackage', () => {
  it.each([
    ['com.android.systemui:id/clock', 'com.android.systemui'],
    ['io.metamask:id/action_bar_root', 'io.metamask'],
    ['android:id/content', 'android'],
    ['wallet-screen', undefined],
    ['npm:@metamask/solana-wallet-snap', undefined],
    ['asset-ETH', undefined],
  ])('reads the package of %s', (identifier, expected) => {
    expect(resourceIdPackage(identifier)).toBe(expected);
  });
});

describe('filterAppHierarchy', () => {
  describe('android', () => {
    it('drops the status bar window with its subtree (AC2)', () => {
      const filtered = filterAppHierarchy(androidSnapshot(), {
        platform: 'android',
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.frame.height).toBe(2400);
      expect(identifiers(filtered)).toStrictEqual([
        'io.metamask:id/action_bar_root',
        'android:id/content',
        'wallet-screen',
        'tab-bar-item-Wallet',
      ]);
      // The unidentified battery node goes with its window.
      expect(labels(filtered)).not.toContain('Battery 100 percent.');
    });

    describe('real snapshot: login screen (proof/p1-13/before/android)', () => {
      const snapshot = androidLoginSnapshot as UIElement[];
      const count = (elements: UIElement[]): number =>
        elements.reduce(
          (total, node) => total + 1 + count(node.children ?? []),
          0,
        );

      it('reduces to the app window, with no System UI test IDs', () => {
        const filtered = filterAppHierarchy(snapshot, { platform: 'android' });

        // Input: status bar window (34 nodes, 22 systemui ids, some under
        // ComposeViews without ids) + app window (54 nodes, trimmed).
        expect(snapshot).toHaveLength(2);
        expect(count(snapshot)).toBe(88);
        expect(
          identifiers(snapshot).filter((id) => id.includes('systemui')),
        ).toHaveLength(22);

        expect(filtered).toStrictEqual([
          // The app window minus the DevLauncher "Tools" ImageView and the
          // 6 unnamed containers that held only it (LinearLayout >
          // ComposeView > 4 Views).
          expect.objectContaining({ frame: snapshot[1]?.frame }),
        ]);
        expect(count(filtered)).toBe(54 - 7);
        expect(
          identifiers(filtered).filter((id) => id.includes('systemui')),
        ).toStrictEqual([]);
        expect(identifiers(filtered)).toStrictEqual([
          'io.metamask:id/action_bar_root',
          'android:id/content',
          'npm:@metamask/bitcoin-wallet-snap',
          'login',
          'login-download-logs-button',
          'metamask-wordmark',
          'login-password-input',
          'log-in-button',
          'reset-wallet-button',
          'fox-animation',
        ]);
      });

      it('keeps only the bar filter with excludeDevOverlay: false', () => {
        const filtered = filterAppHierarchy(snapshot, {
          platform: 'android',
          excludeDevOverlay: false,
        });

        expect(filtered).toStrictEqual([snapshot[1]]);
      });
    });

    it('keeps a System UI window that is not a bar (biometric prompt)', () => {
      const [statusBar, app] = androidSnapshot() as [UIElement, UIElement];
      const biometric = el(
        'android.widget.FrameLayout',
        { frame: { x: 0, y: 1500, width: 1080, height: 900 } },
        [
          el('android.widget.TextView', {
            identifier: 'com.android.systemui:id/biometric_title',
            value: 'Unlock MetaMask',
          }),
          el('android.widget.Button', {
            identifier: 'com.android.systemui:id/button_use_credential',
            label: 'Use PIN',
          }),
        ],
      );

      const filtered = filterAppHierarchy([statusBar, app, biometric], {
        platform: 'android',
      });

      expect(filtered).toHaveLength(2);
      expect(filtered[1]).toBe(biometric);
      expect(
        identifiers(filtered).filter((id) => id.includes('systemui')),
      ).toStrictEqual([
        'com.android.systemui:id/biometric_title',
        'com.android.systemui:id/button_use_credential',
      ]);
    });

    it('keeps a bar-shaped window that holds an app identifier', () => {
      const banner = el(
        'android.widget.FrameLayout',
        { frame: { x: 0, y: 0, width: 1080, height: 63 } },
        [
          el('android.view.View', {
            identifier: 'com.android.systemui:id/status_bar',
          }),
          el('android.widget.TextView', { identifier: 'toast-message' }),
        ],
      );
      const app = el('android.widget.FrameLayout', {
        frame: { x: 0, y: 0, width: 1080, height: 2400 },
        identifier: 'io.metamask:id/action_bar_root',
      });

      expect(
        filterAppHierarchy([banner, app], { platform: 'android' }),
      ).toStrictEqual([banner, app]);
    });

    it('keeps a bar-shaped window with no identifiers', () => {
      const bar = el(
        'android.widget.FrameLayout',
        { frame: { x: 0, y: 0, width: 1080, height: 63 } },
        [el('android.view.View', { label: 'Battery 100 percent.' })],
      );
      const app = el('android.widget.FrameLayout', {
        frame: { x: 0, y: 0, width: 1080, height: 2400 },
      });

      expect(
        filterAppHierarchy([bar, app], { platform: 'android' }),
      ).toStrictEqual([bar, app]);
    });

    it('drops the navigation bar and a side navigation bar (landscape)', () => {
      const navBar = (frame: UIElement['frame']): UIElement =>
        el('android.widget.FrameLayout', { frame }, [
          el('android.widget.FrameLayout', {
            identifier: 'com.android.systemui:id/navigation_bar_frame',
          }),
          el('android.widget.ImageView', {
            identifier: 'com.android.systemui:id/home_handle',
          }),
        ]);
      const portraitApp = el('android.widget.FrameLayout', {
        frame: { x: 0, y: 0, width: 1080, height: 2400 },
        identifier: 'wallet-screen',
      });
      const landscapeApp = el('android.widget.FrameLayout', {
        frame: { x: 0, y: 0, width: 2270, height: 1080 },
        identifier: 'wallet-screen',
      });

      expect(
        filterAppHierarchy(
          [portraitApp, navBar({ x: 0, y: 2270, width: 1080, height: 130 })],
          { platform: 'android' },
        ),
      ).toStrictEqual([portraitApp]);
      expect(
        filterAppHierarchy(
          [landscapeApp, navBar({ x: 2270, y: 0, width: 130, height: 1080 })],
          { platform: 'android' },
        ),
      ).toStrictEqual([landscapeApp]);
    });

    it('drops a status-bar-only snapshot', () => {
      const [statusBar] = androidSnapshot() as [UIElement];

      expect(
        filterAppHierarchy([statusBar], { platform: 'android' }),
      ).toStrictEqual([]);
    });

    it('keeps windows when the snapshot gives no screen size or a window has no size', () => {
      const statusBarIds = [
        el('android.widget.FrameLayout', {
          identifier: 'com.android.systemui:id/status_bar',
        }),
      ];
      const offOrigin = el(
        'android.widget.FrameLayout',
        { frame: { x: 0, y: 2270, width: 1080, height: 130 } },
        statusBarIds,
      );
      const sizeless = el(
        'android.widget.FrameLayout',
        { frame: { x: 0, y: 0, width: 0, height: 0 } },
        statusBarIds,
      );
      const app = el('android.widget.FrameLayout', {
        frame: { x: 0, y: 0, width: 1080, height: 2400 },
      });

      expect(
        filterAppHierarchy([offOrigin], { platform: 'android' }),
      ).toStrictEqual([offOrigin]);
      expect(
        filterAppHierarchy([sizeless, app], { platform: 'android' }),
      ).toStrictEqual([sizeless, app]);
    });

    it('drops only status and navigation bar ids from a flat hierarchy', () => {
      const flat = [
        el('android.widget.FrameLayout', {
          identifier: 'com.android.systemui:id/status_bar',
        }),
        el('android.widget.TextView', {
          identifier: 'com.android.systemui:id/clock',
          value: '8:28 AM',
        }),
        el('android.widget.FrameLayout', {
          identifier: 'com.android.systemui:id/navigation_bar_frame',
        }),
        el('android.widget.FrameLayout', {
          identifier: 'com.android.systemui:id/nav_bar_container',
        }),
        el('android.widget.Button', {
          identifier: 'com.android.systemui:id/button_use_credential',
        }),
        el('android.widget.Button', { identifier: 'log-in-button' }),
      ];

      expect(
        identifiers(filterAppHierarchy(flat, { platform: 'android' })),
      ).toStrictEqual([
        'com.android.systemui:id/clock',
        'com.android.systemui:id/button_use_credential',
        'log-in-button',
      ]);
    });

    it('keeps elements of other packages that are not System UI', () => {
      const dialog = el('android.widget.FrameLayout', {}, [
        el('android.widget.Button', {
          identifier:
            'com.android.permissioncontroller:id/permission_allow_button',
          label: 'Allow',
        }),
      ]);

      const filtered = filterAppHierarchy([dialog], { platform: 'android' });

      expect(identifiers(filtered)).toStrictEqual([
        'com.android.permissioncontroller:id/permission_allow_button',
      ]);
    });

    it('drops the DevLauncher Tools button in a Compose view only', () => {
      const filtered = filterAppHierarchy(androidSnapshot(), {
        platform: 'android',
      });

      // The React Native "Tools" text (a value, not a Compose ImageView)
      // stays; the overlay ImageView is gone.
      expect(labels(filtered)).toStrictEqual(['Wallet']);
    });

    it('keeps the DevLauncher Tools button when excludeDevOverlay is false', () => {
      const filtered = filterAppHierarchy(androidSnapshot(), {
        platform: 'android',
        excludeDevOverlay: false,
      });

      expect(labels(filtered)).toContain('Tools');
    });

    it('does not filter System UI ids on iOS', () => {
      const node = el('Button', { identifier: 'com.android.systemui:id/x' });

      expect(
        filterAppHierarchy([node], {
          platform: 'ios',
          excludeDevOverlay: false,
        }),
      ).toStrictEqual([node]);
    });
  });

  describe('ios', () => {
    it('drops the DevLauncher gear and its Tools text', () => {
      const filtered = filterAppHierarchy(iosSnapshot(), { platform: 'ios' });

      expect(identifiers(filtered)).toStrictEqual(['log-in-button']);
      // The app's own "Tools" text (not after the gear) is kept; the empty
      // DevLauncher window is removed.
      expect(labels(filtered)).toStrictEqual(['MetaMask', 'Unlock', 'Tools']);
      expect(filtered[0]?.children).toHaveLength(1);
    });

    it('keeps the overlay when excludeDevOverlay is false', () => {
      const snapshot = iosSnapshot();

      const filtered = filterAppHierarchy(snapshot, {
        platform: 'ios',
        excludeDevOverlay: false,
      });

      expect(filtered).toStrictEqual(snapshot);
    });

    it('drops the overlay from a flat idb list', () => {
      const flat = [
        el('Other', { label: 'MetaMask' }),
        el('Button', { identifier: 'log-in-button' }),
        el('Image', { identifier: 'gearshape.fill' }),
        el('StaticText', { label: 'Tools' }),
      ];

      const filtered = filterAppHierarchy(flat, { platform: 'ios' });

      expect(
        filtered.map((node) => node.identifier ?? node.label),
      ).toStrictEqual(['MetaMask', 'log-in-button']);
    });
  });

  it('returns unchanged subtrees by reference and does not modify the input', () => {
    const snapshot = androidSnapshot();
    const before = JSON.stringify(snapshot);

    const filtered = filterAppHierarchy(snapshot, { platform: 'android' });

    expect(JSON.stringify(snapshot)).toBe(before);
    const appContent = filtered[0]?.children?.[0]?.children?.[0];
    const reactRoot = appContent?.children?.[0];
    expect(reactRoot).toBe(
      snapshot[1]?.children?.[0]?.children?.[0]?.children?.[1],
    );
  });
});

describe('viewportFromHierarchy', () => {
  it('reads the iOS viewport from the first element', () => {
    expect(viewportFromHierarchy(iosSnapshot(), 'ios')).toStrictEqual({
      width: 402,
      height: 874,
    });
  });

  it('ignores later top-level iOS elements (flat idb list)', () => {
    const flat = [
      el('Other', { frame: { x: 0, y: 0, width: 402, height: 874 } }),
      el('UIView', { frame: { x: 0, y: 0, width: 402, height: 2938 } }),
    ];

    expect(viewportFromHierarchy(flat, 'ios')).toStrictEqual({
      width: 402,
      height: 874,
    });
  });

  it('reads the Android viewport from the largest top-level window', () => {
    expect(viewportFromHierarchy(androidSnapshot(), 'android')).toStrictEqual({
      width: 1080,
      height: 2400,
    });
  });

  it('reads the Android viewport as the extent of all top-level windows', () => {
    const windows = [
      el('Window', { frame: { x: 0, y: 0, width: 1080, height: 63 } }),
      el('Window', { frame: { x: 0, y: 63, width: 1080, height: 2207 } }),
      el('Window', { frame: { x: 0, y: 2270, width: 1080, height: 130 } }),
    ];

    expect(viewportFromHierarchy(windows, 'android')).toStrictEqual({
      width: 1080,
      height: 2400,
    });
  });

  it('includes an off-origin Android window in the extent', () => {
    const windows = [
      el('Window', { frame: { x: 0, y: 0, width: 1080, height: 63 } }),
      el('Dialog', { frame: { x: 40, y: 1500, width: 1000, height: 900 } }),
    ];

    expect(viewportFromHierarchy(windows, 'android')).toStrictEqual({
      width: 1080,
      height: 2400,
    });
  });

  it('reads a status-bar-only Android snapshot as the bar', () => {
    const [statusBar] = androidSnapshot() as [UIElement];

    expect(viewportFromHierarchy([statusBar], 'android')).toStrictEqual({
      width: 1080,
      height: 63,
    });
  });

  it.each([
    ['empty', []],
    [
      'zero-size',
      [el('Other', { frame: { x: 0, y: 0, width: 0, height: 0 } })],
    ],
    [
      'off-origin',
      [el('Dialog', { frame: { x: 40, y: 600, width: 1000, height: 800 } })],
    ],
  ])('returns undefined for a %s root', (_name, hierarchy) => {
    expect(viewportFromHierarchy(hierarchy, 'android')).toBeUndefined();
    expect(viewportFromHierarchy(hierarchy, 'ios')).toBeUndefined();
  });
});
