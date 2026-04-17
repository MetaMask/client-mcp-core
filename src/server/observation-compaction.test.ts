import { describe, expect, it, vi } from 'vitest';

import type { A11yNodeTrimmed } from '../tools/types/discovery.js';
import type { StepRecordObservation } from '../tools/types/step-record.js';
import {
  collapseOptionSubtrees,
  compactObservation,
  observationCompactionDeps,
} from './observation-compaction.js';

function createNode(
  ref: string,
  role: string,
  overrides: Partial<A11yNodeTrimmed> = {},
): A11yNodeTrimmed {
  return {
    ref,
    role,
    name: overrides.name ?? `${role}-${ref}`,
    path: overrides.path ?? ['root', ref],
    ...overrides,
  };
}

function createOptionRun(count: number, start = 1): A11yNodeTrimmed[] {
  return Array.from({ length: count }, (_, index) => {
    const refNumber = start + index;
    return createNode(`e${refNumber}`, 'option', {
      name: `Option ${refNumber}`,
      path: ['root', 'combo', `option-${refNumber}`],
    });
  });
}

describe('collapseOptionSubtrees', () => {
  it('collapses 55 options after a combobox into a summary node', () => {
    const combobox = createNode('e1', 'combobox', {
      name: 'Select network',
      path: ['root', 'combobox'],
    });
    const nodes = [combobox, ...createOptionRun(55, 2)];

    const result = collapseOptionSubtrees(nodes);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(combobox);
    expect(result[1]).toStrictEqual({
      ref: 'e2\u2013e56',
      role: 'option',
      name: '55 options (refs e2\u2013e56)',
      path: ['root', 'combo', 'option-2'],
    });
  });

  it('does not collapse runs below the threshold', () => {
    const combobox = createNode('e1', 'combobox');
    const optionOne = createNode('e2', 'option');
    const optionTwo = createNode('e3', 'option');

    const result = collapseOptionSubtrees([combobox, optionOne, optionTwo]);

    expect(result).toHaveLength(3);
    expect(result).toStrictEqual([combobox, optionOne, optionTwo]);
  });

  it('leaves bare options unchanged when no combobox or listbox precedes them', () => {
    const options = createOptionRun(4);

    const result = collapseOptionSubtrees(options);

    expect(result).toStrictEqual(options);
  });

  it('handles multiple combobox and listbox groups independently', () => {
    const firstCombobox = createNode('e1', 'combobox', {
      path: ['root', 'first-combobox'],
    });
    const separator = createNode('e12', 'button', {
      name: 'Continue',
      path: ['root', 'separator'],
    });
    const secondListbox = createNode('e13', 'listbox', {
      path: ['root', 'second-listbox'],
    });
    const nodes = [
      firstCombobox,
      ...createOptionRun(10, 2),
      separator,
      secondListbox,
      ...createOptionRun(5, 14),
    ];

    const result = collapseOptionSubtrees(nodes);

    expect(result).toStrictEqual([
      firstCombobox,
      {
        ref: 'e2\u2013e11',
        role: 'option',
        name: '10 options (refs e2\u2013e11)',
        path: ['root', 'combo', 'option-2'],
      },
      separator,
      secondListbox,
      {
        ref: 'e14\u2013e18',
        role: 'option',
        name: '5 options (refs e14\u2013e18)',
        path: ['root', 'combo', 'option-14'],
      },
    ]);
  });

  it('preserves already-collapsed option summaries as a single entry', () => {
    const combobox = createNode('e1', 'combobox');
    const collapsedSummary = createNode('e2\u2013e6', 'option', {
      name: '5 options (refs e2\u2013e6)',
      path: ['root', 'combo', 'option-2'],
    });

    const result = collapseOptionSubtrees([combobox, collapsedSummary]);

    expect(result).toStrictEqual([combobox, collapsedSummary]);
  });

  it('does not collapse when a non-option node immediately follows the combobox', () => {
    const combobox = createNode('e1', 'combobox');
    const button = createNode('e2', 'button', { name: 'Apply' });
    const options = createOptionRun(3, 3);

    const result = collapseOptionSubtrees([combobox, button, ...options]);

    expect(result).toStrictEqual([combobox, button, ...options]);
  });

  it('treats malformed option range refs as single options during compaction', () => {
    const combobox = createNode('e1', 'combobox');
    const malformedSummary = createNode(`e${'9'.repeat(400)}\u2013e2`, 'option', {
      name: 'Malformed range',
      path: ['root', 'combo', 'option-weird'],
    });
    const optionTwo = createNode('e3', 'option', {
      name: 'Option 3',
      path: ['root', 'combo', 'option-3'],
    });
    const optionThree = createNode('e4', 'option', {
      name: 'Option 4',
      path: ['root', 'combo', 'option-4'],
    });

    const result = collapseOptionSubtrees([
      combobox,
      malformedSummary,
      optionTwo,
      optionThree,
    ]);

    expect(result).toStrictEqual([
      combobox,
      {
        ref: `${malformedSummary.ref}\u2013e4`,
        role: 'option',
        name: `3 options (refs ${malformedSummary.ref}\u2013e4)`,
        path: ['root', 'combo', 'option-weird'],
      },
    ]);
  });
});

describe('compactObservation', () => {
  it('preserves non-a11y fields by reference while returning a new object', () => {
    const state = { connected: true };
    const testIds = [{ testId: 'submit', tag: 'button', visible: true }];
    const priorKnowledge = { schemaVersion: 1, notes: ['cached'] };
    const observation = {
      state,
      testIds,
      a11y: {
        nodes: [createNode('e1', 'combobox'), ...createOptionRun(4, 2)],
      },
      priorKnowledge,
    } as unknown as StepRecordObservation;

    const result = compactObservation(observation);

    expect(result).not.toBe(observation);
    expect(result.state).toBe(state);
    expect(result.testIds).toBe(testIds);
    expect(result.priorKnowledge).toBe(priorKnowledge);
    expect(result.a11y).not.toBe(observation.a11y);
    expect(result.a11y.nodes).toStrictEqual([
      observation.a11y.nodes[0],
      {
        ref: 'e2\u2013e5',
        role: 'option',
        name: '4 options (refs e2\u2013e5)',
        path: ['root', 'combo', 'option-2'],
      },
    ]);
  });

  it('is idempotent when called repeatedly on the same result', () => {
    const observation = {
      state: {},
      testIds: [],
      a11y: {
        nodes: [createNode('e1', 'listbox'), ...createOptionRun(6, 2)],
      },
    } as unknown as StepRecordObservation;

    const first = compactObservation(observation);
    const second = compactObservation(first);

    expect(second).toStrictEqual(first);
  });

  it('falls back to the original observation when compaction throws', () => {
    const observation = {
      state: {},
      testIds: [],
      a11y: { nodes: [createNode('e1', 'combobox')] },
    } as unknown as StepRecordObservation;
    const collapseSpy = vi
      .spyOn(observationCompactionDeps, 'collapseOptionSubtrees')
      .mockImplementation(() => {
        throw new Error('boom');
      });

    const result = compactObservation(observation);

    expect(result).toBe(observation);
    collapseSpy.mockRestore();
  });

  it('handles empty node arrays gracefully', () => {
    const observation = {
      state: {},
      testIds: [],
      a11y: { nodes: [] },
    } as unknown as StepRecordObservation;

    const result = compactObservation(observation);

    expect(result).not.toBe(observation);
    expect(result.a11y.nodes).toStrictEqual([]);
  });
});
