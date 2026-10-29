import { describe, expect, it } from 'vitest';

import type { A11yNodeTrimmed, TestIdItem } from './discovery.js';
import { createDefaultObservation } from './observation.js';
import type { ExtensionState } from '../../capabilities/types.js';

const state = {
  isLoaded: true,
  currentUrl: 'chrome-extension://ext/home.html',
  extensionId: 'ext',
  isUnlocked: true,
  currentScreen: 'home',
  accountAddress: null,
  networkName: null,
  chainId: null,
  balance: null,
} as ExtensionState;

describe('createDefaultObservation', () => {
  it('defaults testIds and a11y nodes to empty arrays', () => {
    expect(createDefaultObservation(state)).toStrictEqual({
      state,
      testIds: [],
      a11y: { nodes: [] },
    });
  });

  it('includes the provided testIds and a11y nodes', () => {
    const testIds = [
      { testId: 'send-button', tag: 'button', visible: true },
    ] as TestIdItem[];
    const nodes = [
      { ref: 'e1', role: 'button', name: 'Send', path: [] },
    ] as unknown as A11yNodeTrimmed[];

    expect(createDefaultObservation(state, testIds, nodes)).toStrictEqual({
      state,
      testIds,
      a11y: { nodes },
    });
  });
});
