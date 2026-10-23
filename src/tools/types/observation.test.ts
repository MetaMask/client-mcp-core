import { describe, expect, it } from 'vitest';

import type { A11yNodeTrimmed, TestIdItem } from './discovery.js';
import { createDefaultObservation } from './observation.js';

describe('createDefaultObservation', () => {
  it('defaults testIds and a11y nodes to empty arrays', () => {
    expect(createDefaultObservation()).toStrictEqual({
      testIds: [],
      a11y: { nodes: [] },
    });
  });

  it('includes the provided testIds and a11y nodes, and no state', () => {
    const testIds = [
      { testId: 'send-button', tag: 'button', visible: true },
    ] as TestIdItem[];
    const nodes = [
      { ref: 'e1', role: 'button', name: 'Send', path: [] },
    ] as unknown as A11yNodeTrimmed[];

    const observation = createDefaultObservation(testIds, nodes);

    expect(observation).toStrictEqual({
      testIds,
      a11y: { nodes },
    });
    expect(observation).not.toHaveProperty('state');
  });
});
