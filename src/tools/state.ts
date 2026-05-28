import type { Page } from '@playwright/test';

import { classifyStateError } from './error-classification.js';
import type { GetStateResult, TabInfo } from './types';
import { ErrorCodes } from './types';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type {
  ExtensionState,
  StateSnapshotCapability,
} from '../capabilities/types.js';
import type { ISessionManager } from '../server/session-manager.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Retrieves the extension state using the snapshot capability or driver.
 *
 * @param page - The active Playwright page.
 * @param sessionManager - The session manager instance.
 * @param stateSnapshotCapability - Optional capability for direct state snapshots.
 * @returns The current extension state.
 */
async function getStateWithCapability(
  page: Page,
  sessionManager: ISessionManager,
  stateSnapshotCapability?: StateSnapshotCapability,
): Promise<ExtensionState> {
  if (stateSnapshotCapability) {
    const extensionId = sessionManager.getSessionState()?.extensionId;
    return stateSnapshotCapability.getState(page, {
      extensionId,
      chainId: sessionManager.getSessionState()?.ports?.anvil ? 1337 : 1,
    });
  }

  return sessionManager.getExtensionState();
}

/**
 * Retrieves the extension state and tracked tab information.
 *
 * @param _input - Unused input parameters.
 * @param context - The tool execution context.
 * @returns The extension state and tab details.
 */
export async function getStateTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<GetStateResult>> {
  const missingSession = requireActiveSession<GetStateResult>(context);
  if (missingSession) {
    return missingSession;
  }

  if (!context.driver) {
    return createToolError(
      ErrorCodes.MM_NO_ACTIVE_SESSION,
      'No platform driver available',
    );
  }

  try {
    const stateSnapshotCapability =
      context.workflowContext.stateSnapshot ??
      context.sessionManager.getStateSnapshotCapability?.();

    const state =
      stateSnapshotCapability && context.driver.getPlatform() === 'browser'
        ? await getStateWithCapability(
            context.page,
            context.sessionManager,
            stateSnapshotCapability,
          )
        : await context.driver.getAppState();

    const trackedPages = context.sessionManager.getTrackedPages();
    let activeTab: TabInfo;
    try {
      const activePage = context.sessionManager.getPage();
      const tracked = trackedPages.find(
        (trackedPage) => trackedPage.page === activePage,
      );
      activeTab = {
        role: tracked?.role ?? 'other',
        url: activePage.url(),
      };
    } catch {
      activeTab = { role: 'other', url: '' };
    }

    return createToolSuccess({
      state,
      tabs: {
        active: activeTab,
        tracked: trackedPages.map((trackedPage) => ({
          role: trackedPage.role,
          url: trackedPage.url,
        })),
      },
    });
  } catch (error) {
    const errorInfo = classifyStateError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
