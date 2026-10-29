import type { TestIdItem, A11yNodeTrimmed } from './discovery.js';

/**
 * Screen snapshot collected after a tool runs: visible test IDs and the
 * trimmed accessibility tree. It carries no app state; call `get_state` for
 * that.
 */
export type StepRecordObservation = {
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
 * @param testIds - Visible test IDs.
 * @param a11yNodes - Trimmed accessibility nodes.
 * @returns The observation.
 */
export function createDefaultObservation(
  testIds: TestIdItem[] = [],
  a11yNodes: A11yNodeTrimmed[] = [],
): StepRecordObservation {
  return {
    testIds,
    a11y: { nodes: a11yNodes },
  };
}
