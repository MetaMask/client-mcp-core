import type { Page } from "playwright";
import type {
  GetStateResult,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { getSessionManager } from "../session-manager.js";
import type { StateSnapshotCapability, ExtensionState } from "../../capabilities/types.js";
import { runTool } from "./run-tool.js";
import { classifyStateError } from "./error-classification.js";
import { collectObservation } from "./helpers.js";

export type StateToolOptions = HandlerOptions & {
  stateSnapshotCapability?: StateSnapshotCapability;
};

async function getState(
  page: Page,
  sessionManager: ReturnType<typeof getSessionManager>,
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

export async function handleGetState(
  options?: StateToolOptions,
): Promise<McpResponse<GetStateResult>> {
  return runTool<Record<string, never>, GetStateResult>({
    toolName: "mm_get_state",
    input: {},
    options,
    observationPolicy: "custom",

    execute: async (context) => {
      const sessionManager = getSessionManager();
      const state = await getState(
        context.page,
        sessionManager,
        options?.stateSnapshotCapability,
      );

      const trackedPages = sessionManager.getTrackedPages();
      const activePage = sessionManager.getPage();
      const activeTabInfo = trackedPages.find((p) => p.page === activePage);

      const tabs = {
        active: {
          role: activeTabInfo?.role ?? "other",
          url: activePage.url(),
        },
        tracked: trackedPages.map((p) => ({
          role: p.role,
          url: p.url,
        })),
      };

      const observation = await collectObservation(context.page, "full", state);

      return {
        result: { state, tabs },
        observation,
      };
    },

    classifyError: classifyStateError,
  });
}
