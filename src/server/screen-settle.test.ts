import { describe, it, expect } from 'vitest';

import {
  isBusyNode,
  isScreenBusy,
  isScreenInTransition,
  screenSignature,
} from './screen-settle.js';
import type { A11yNodeTrimmed } from '../tools/types/discovery.js';

const node = (
  role: string,
  name: string,
  extra: Partial<A11yNodeTrimmed> = {},
): A11yNodeTrimmed => ({ ref: 'e1', role, name, path: [], ...extra });

describe('isBusyNode', () => {
  it('matches the React Native busy label (Android unlock proof)', () => {
    // From proof/p1-08/android/click-unlock.txt: the login button while the
    // wallet unlocks.
    expect(
      isBusyNode(
        node('android.widget.Button', 'Unlock, busy', {
          disabled: true,
          testId: 'log-in-button',
        }),
      ),
    ).toBe(true);
  });

  it('matches the busy label on iOS element types', () => {
    expect(isBusyNode(node('Button', 'Unlock, busy'))).toBe(true);
    expect(isBusyNode(node('Button', 'Confirm,busy'))).toBe(true);
    expect(isBusyNode(node('Button', 'Send, Busy'))).toBe(true);
  });

  it('matches Android progress bars', () => {
    expect(isBusyNode(node('android.widget.ProgressBar', ''))).toBe(true);
    expect(
      isBusyNode(node('androidx.core.widget.ContentLoadingProgressBar', '')),
    ).toBe(true);
  });

  it('matches iOS activity and progress indicators (Appium and idb types)', () => {
    expect(isBusyNode(node('ActivityIndicator', ''))).toBe(true);
    expect(isBusyNode(node('ProgressIndicator', ''))).toBe(true);
    expect(isBusyNode(node('UIActivityIndicatorView', ''))).toBe(true);
  });

  it('does not match other nodes', () => {
    expect(isBusyNode(node('ActivityIndicatorContainer', ''))).toBe(false);
    expect(isBusyNode(node('StaticText', 'ProgressIndicator'))).toBe(false);
    expect(isBusyNode(node('android.widget.Button', 'Unlock'))).toBe(false);
    expect(isBusyNode(node('android.widget.TextView', 'busy'))).toBe(false);
    expect(isBusyNode(node('android.widget.TextView', 'Busy day'))).toBe(false);
    expect(isBusyNode(node('android.widget.TextView', 'Not busy now'))).toBe(
      false,
    );
    // The spinner in the proof has no busy role or label; the button does.
    expect(
      isBusyNode(
        node('android.view.ViewGroup', '', { testId: 'spinner-animated-view' }),
      ),
    ).toBe(false);
    expect(isBusyNode(node('_UIScrollViewScrollIndicator', ''))).toBe(false);
  });
});

describe('isScreenBusy', () => {
  it('is true when any node is busy', () => {
    expect(
      isScreenBusy([node('Text', 'Welcome'), node('Button', 'Unlock, busy')]),
    ).toBe(true);
    expect(isScreenBusy([node('Text', 'Welcome')])).toBe(false);
    expect(isScreenBusy([])).toBe(false);
  });
});

describe('isScreenInTransition', () => {
  /**
   * Builds a screen of `count` nodes, each with its own test ID and ref.
   *
   * @param prefix - The test ID prefix.
   * @param count - The number of nodes.
   * @returns The accessibility nodes.
   */
  const screen = (prefix: string, count: number): A11yNodeTrimmed[] =>
    Array.from({ length: count }, (_, index) => ({
      ref: `e${index + 1}`,
      role: 'android.view.ViewGroup',
      name: `${prefix}-${index + 1}`,
      path: [],
      testId: `${prefix}-${index + 1}`,
    }));

  it('matches the torn-down screen measured after an Android navigating tap', () => {
    // P1-32: wallet home (242 nodes) came back as 64 nodes with
    // `wallet-screen` still present; the new screen was complete ~440 ms
    // later. Scaled down here.
    const home = screen('wallet', 40);
    expect(isScreenInTransition(home, home.slice(0, 12))).toBe(true);
  });

  it('does not match an unchanged screen', () => {
    const home = screen('wallet', 40);
    expect(isScreenInTransition(home, screen('wallet', 40))).toBe(false);
  });

  it('does not match a screen that grew', () => {
    expect(
      isScreenInTransition(screen('wallet', 40), screen('wallet', 60)),
    ).toBe(false);
  });

  it('does not match a small drop on a small screen', () => {
    // 30 -> 24 nodes: a hidden row, not a teardown.
    expect(
      isScreenInTransition(screen('drawer', 30), screen('drawer', 24)),
    ).toBe(false);
  });

  it('does not match a screen that only shrank a little', () => {
    // 40 -> 30 keeps 75% of the nodes (the live-content case on iOS: Explore
    // went from 183 to 146 nodes).
    expect(
      isScreenInTransition(screen('explore', 40), screen('explore', 30)),
    ).toBe(false);
  });

  it('does not match a smaller screen with its own test IDs', () => {
    // Home 242 -> profile drawer 24: the drawer brings new test IDs.
    const home = screen('wallet', 40);
    const drawer = screen('profile-drawer', 12);
    expect(isScreenInTransition(home, drawer)).toBe(false);
  });

  it('does not match when most of the new test IDs are new', () => {
    const home = screen('wallet', 40);
    const mixed = [...home.slice(0, 2), ...screen('explore', 10)];
    expect(isScreenInTransition(home, mixed)).toBe(false);
  });

  it('matches a big drop with no test IDs at all', () => {
    const home = screen('wallet', 40);
    const bare = home.slice(0, 5).map(({ testId: _testId, ...rest }) => rest);
    expect(isScreenInTransition(home, bare)).toBe(true);
  });

  it('does not match when the last screen had no test IDs', () => {
    const bare = screen('wallet', 40).map(
      ({ testId: _testId, ...rest }) => rest,
    );
    expect(isScreenInTransition(bare, screen('wallet', 12))).toBe(false);
  });

  it('matches a big drop to an empty tree', () => {
    // An empty snapshot after a tap is the extreme case of a teardown.
    expect(isScreenInTransition(screen('wallet', 40), [])).toBe(true);
  });
});

describe('screenSignature', () => {
  it('ignores refs', () => {
    expect(screenSignature([{ ...node('Button', 'Go'), ref: 'e1' }])).toBe(
      screenSignature([{ ...node('Button', 'Go'), ref: 'e9' }]),
    );
    expect(screenSignature([node('Button', 'Go')])).not.toBe(
      screenSignature([node('Button', 'Stop')]),
    );
  });
});
