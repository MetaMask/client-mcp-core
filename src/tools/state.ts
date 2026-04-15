import type { Page } from '@playwright/test';

import { classifyStateError } from './error-classification.js';
import type { GetStateResult } from './types';
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
 * Retrieves the extension state using the snapshot capability or session manager.
 *
 * @param page - The active Playwright page.
 * @param sessionManager - The session manager instance.
 * @param stateSnapshotCapability - Optional capability for direct state snapshots.
 * @returns The current extension state.
 */
async function getState(
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

  try {
    const state = await getState(
      context.page,
      context.sessionManager,
      context.workflowContext.stateSnapshot ??
        context.sessionManager.getStateSnapshotCapability(),
    );

    const trackedPages = context.sessionManager.getTrackedPages();
    const activePage = context.sessionManager.getPage();
    const activeTabInfo = trackedPages.find(
      (trackedPage) => trackedPage.page === activePage,
    );

    return createToolSuccess({
      state,
      tabs: {
        active: {
          role: activeTabInfo?.role ?? 'other',
          url: activePage.url(),
        },
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
