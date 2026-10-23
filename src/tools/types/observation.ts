import type { TestIdItem, A11yNodeTrimmed } from './discovery.js';
import type { ExtensionState } from '../../capabilities/types.js';

/**
 * Screen snapshot collected after a tool runs: state, visible test IDs and
 * the trimmed accessibility tree.
 */
export type StepRecordObservation = {
  state: ExtensionState;
  testIds: TestIdItem[];
  a11y: {
    nodes: A11yNodeTrimmed[];
    /** Present only in diff-mode compact observations. */
    diff?: {
      added: string[];
      removed: string[];
      unchanged: number;
    };
  };
};

/**
 * Builds an observation from its parts.
 *
 * @param state - Extension or app state snapshot.
 * @param testIds - Visible test IDs.
 * @param a11yNodes - Trimmed accessibility nodes.
 * @returns The observation.
 */
export function createDefaultObservation(
  state: ExtensionState,
  testIds: TestIdItem[] = [],
  a11yNodes: A11yNodeTrimmed[] = [],
): StepRecordObservation {
  return {
    state,
    testIds,
    a11y: { nodes: a11yNodes },
  };
}
