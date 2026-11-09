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
  /**
   * Browser, after a call that waits for animations: false when finite
   * animations were still running when the wait ended. Infinite animations
   * (spinners) and network requests are not checked.
   */
  animationsSettled?: boolean;
};

/**
 * Marker sent in place of an observation when its collection exceeded
 * `OBSERVATION_TIMEOUT_MS`. The action itself succeeded: the screen was not
 * read, so the agent must describe the screen before using refs.
 */
export type ObservationTimeout = {
  timedOut: true;
};

/**
 * Observation delivered in a tool response: a screen snapshot, or the
 * timeout marker when the action succeeded but its observation did not.
 */
export type DeliveredObservation = StepRecordObservation | ObservationTimeout;

/**
 * Tells whether a delivered observation is the timeout marker.
 *
 * @param observation - The delivered observation.
 * @returns True for {@link ObservationTimeout}.
 */
export function isObservationTimeout(
  observation: DeliveredObservation,
): observation is ObservationTimeout {
  return 'timedOut' in observation;
}

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
