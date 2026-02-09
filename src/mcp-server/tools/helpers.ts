import type { ExtensionState } from '../../capabilities/types.js';
import type { IPlatformDriver } from '../../platform/types.js';
import { OBSERVATION_TESTID_LIMIT } from '../constants.js';
import { createDefaultObservation } from '../knowledge-store.js';
import { getSessionManager } from '../session-manager.js';
import type { TestIdItem, StepRecordObservation } from '../types';
import { debugWarn } from '../utils';

/**
 * Level of detail to collect for observation data.
 * - "full": Collect state, testIds, and a11y tree
 * - "minimal": Collect state only (no testIds or a11y)
 * - "none": Return empty observation
 */
export type ObservationLevel = 'full' | 'minimal' | 'none';

/**
 * Collect observation data from the current page state.
 *
 * @param driver - The platform driver to collect observation from
 * @param level - Level of detail to collect (full, minimal, or none)
 * @param presetState - Optional pre-fetched extension state to use instead of querying
 * @returns Observation data with state, testIds, and accessibility tree
 */
export async function collectObservation(
  driver: IPlatformDriver | undefined,
  level: ObservationLevel,
  presetState?: ExtensionState,
): Promise<StepRecordObservation> {
  const sessionManager = getSessionManager();

  if (level === 'none') {
    return createDefaultObservation({} as ExtensionState, [], []);
  }

  const state =
    presetState ??
    (driver
      ? await driver.getAppState()
      : await sessionManager.getExtensionState());

  if (level === 'minimal') {
    return createDefaultObservation(state, [], []);
  }

  if (!driver) {
    debugWarn('collectObservation', 'Driver not provided for full observation');
    return createDefaultObservation(state, [], []);
  }

  try {
    const testIds: TestIdItem[] = await driver.getTestIds(
      OBSERVATION_TESTID_LIMIT,
    );
    const { nodes, refMap } = await driver.getAccessibilityTree();
    sessionManager.setRefMap(refMap);
    return createDefaultObservation(state, testIds, nodes);
  } catch (error) {
    debugWarn('collectObservation', error);
    return createDefaultObservation(state, [], []);
  }
}
