import { describe, it, expect } from 'vitest';

import { isBusyNode, isScreenBusy, screenSignature } from './screen-settle.js';
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
