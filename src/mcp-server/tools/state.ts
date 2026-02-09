import type { Page } from '@playwright/test';

import type {
  ExtensionState,
  StateSnapshotCapability,
} from '../../capabilities/types.js';
import type { IPlatformDriver } from '../../platform/types.js';
import { getSessionManager } from '../session-manager.js';
import type { GetStateResult, McpResponse, HandlerOptions } from '../types';
import { classifyStateError } from './error-classification.js';
import { collectObservation } from './helpers.js';
import { runTool } from './run-tool.js';

/**
 * Tool options for state-related operations.
 */
export type StateToolOptions = HandlerOptions & {
  /**
   * Optional capability for taking state snapshots
   */
  stateSnapshotCapability?: StateSnapshotCapability;
};

/**
 * Retrieves the current extension state, using the snapshot capability if available.
 *
 * @param driver The platform driver for state retrieval fallback
 * @param page The Playwright page object to query (browser-only)
 * @param sessionManager The session manager instance
 * @param stateSnapshotCapability Optional capability for detailed state snapshots
 * @returns Promise resolving to the current extension state
 */
async function getState(
  driver: IPlatformDriver,
  page: unknown,
  sessionManager: ReturnType<typeof getSessionManager>,
  stateSnapshotCapability?: StateSnapshotCapability,
): Promise<ExtensionState> {
  if (stateSnapshotCapability && page) {
    const extensionId = sessionManager.getSessionState()?.extensionId;
    return stateSnapshotCapability.getState(page as Page, {
      extensionId,
      chainId: sessionManager.getSessionState()?.ports?.anvil ? 1337 : 1,
    });
  }

  return driver.getAppState();
}

/**
 * Handles the mm_get_state tool to retrieve the current extension state.
 *
 * @param options Tool options including optional state snapshot capability
 * @returns Promise resolving to the current extension state and tab information
 */
export async function handleGetState(
  options?: StateToolOptions,
): Promise<McpResponse<GetStateResult>> {
  return runTool<Record<string, never>, GetStateResult>({
    toolName: 'mm_get_state',
    input: {},
    options,
    observationPolicy: 'custom',

    /**
     * Executes the state retrieval with tab and observation information.
     *
     * @param context The tool execution context containing the page
     * @returns The extension state, tab information, and observation data
     */
    execute: async (context) => {
      if (!context.driver) {
        throw new Error('No platform driver available');
      }
      const sessionManager = getSessionManager();
      const state = await getState(
        context.driver,
        context.page,
        sessionManager,
        options?.stateSnapshotCapability,
      );

      // Tab info is browser-only
      let tabs;
      if (context.driver?.getPlatform() !== 'ios') {
        const trackedPages = sessionManager.getTrackedPages();
        const activePage = sessionManager.getPage();
        const activeTabInfo = trackedPages.find(
          (trackedPage) => trackedPage.page === activePage,
        );
        tabs = {
          active: {
            role: activeTabInfo?.role ?? 'other',
            url: activePage.url(),
          },
          tracked: trackedPages.map((trackedPage) => ({
            role: trackedPage.role,
            url: trackedPage.url,
          })),
        };
      }

      const observation = await collectObservation(
        context.driver,
        'full',
        state,
      );

      return {
        result: { state, tabs },
        observation,
      };
    },

    classifyError: classifyStateError,
  });
}
