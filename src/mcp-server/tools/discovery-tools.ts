import type {
  ListTestIdsInput,
  ListTestIdsResult,
  AccessibilitySnapshotInput,
  AccessibilitySnapshotResult,
  DescribeScreenInput,
  DescribeScreenResult,
  McpResponse,
  PriorKnowledgeContext,
  HandlerOptions,
} from "../types/index.js";
import { getSessionManager } from "../session-manager.js";
import {
  knowledgeStore,
  createDefaultObservation,
} from "../knowledge-store.js";
import { collectTestIds, collectTrimmedA11ySnapshot } from "../discovery.js";
import { DEFAULT_TESTID_LIMIT, OBSERVATION_TESTID_LIMIT } from "../constants.js";
import { runTool } from "./run-tool.js";
import { classifyDiscoveryError } from "./error-classification.js";

export async function handleListTestIds(
  input: ListTestIdsInput,
  options?: HandlerOptions,
): Promise<McpResponse<ListTestIdsResult>> {
  const limit = input.limit ?? DEFAULT_TESTID_LIMIT;

  return runTool<ListTestIdsInput, ListTestIdsResult>({
    toolName: "mm_list_testids",
    input,
    options,
    observationPolicy: "custom",

    execute: async (context) => {
      const items = await collectTestIds(context.page, limit);
      const state = await getSessionManager().getExtensionState();
      const { nodes, refMap } = await collectTrimmedA11ySnapshot(context.page);

      getSessionManager().setRefMap(refMap);

      return {
        result: { items },
        observation: createDefaultObservation(state, items, nodes),
      };
    },

    classifyError: classifyDiscoveryError,

    sanitizeInputForRecording: () => ({ limit }),
  });
}

export async function handleAccessibilitySnapshot(
  input: AccessibilitySnapshotInput,
  options?: HandlerOptions,
): Promise<McpResponse<AccessibilitySnapshotResult>> {
  return runTool<AccessibilitySnapshotInput, AccessibilitySnapshotResult>({
    toolName: "mm_accessibility_snapshot",
    input,
    options,
    observationPolicy: "custom",

    execute: async (context) => {
      const { nodes, refMap } = await collectTrimmedA11ySnapshot(
        context.page,
        input.rootSelector,
      );

      getSessionManager().setRefMap(refMap);

      const state = await getSessionManager().getExtensionState();
      const testIds = await collectTestIds(context.page, OBSERVATION_TESTID_LIMIT);

      return {
        result: { nodes },
        observation: createDefaultObservation(state, testIds, nodes),
      };
    },

    classifyError: classifyDiscoveryError,

    sanitizeInputForRecording: () => ({ rootSelector: input.rootSelector }),
  });
}

export async function handleDescribeScreen(
  input: DescribeScreenInput,
  options?: HandlerOptions,
): Promise<McpResponse<DescribeScreenResult>> {
  return runTool<DescribeScreenInput, DescribeScreenResult>({
    toolName: "mm_describe_screen",
    input,
    options,
    observationPolicy: "custom",

    execute: async (context) => {
      const sessionManager = getSessionManager();
      const page = context.page;

      const state = await sessionManager.getExtensionState();
      const testIds = await collectTestIds(page, DEFAULT_TESTID_LIMIT);
      const { nodes, refMap } = await collectTrimmedA11ySnapshot(page);

      sessionManager.setRefMap(refMap);

      let screenshot: DescribeScreenResult["screenshot"] = null;

      if (input.includeScreenshot) {
        const screenshotName = input.screenshotName ?? "describe-screen";
        const result = await sessionManager.screenshot({
          name: screenshotName,
          fullPage: true,
        });

        screenshot = {
          path: result.path,
          width: result.width,
          height: result.height,
          base64: input.includeScreenshotBase64 ? result.base64 : null,
        };
      }

      const sessionMetadata = sessionManager.getSessionMetadata();
      const priorKnowledgeContext: PriorKnowledgeContext = {
        currentScreen: state.currentScreen,
        currentUrl: state.currentUrl,
        visibleTestIds: testIds,
        a11yNodes: nodes,
        currentSessionFlowTags: sessionMetadata?.flowTags,
      };

      const priorKnowledge = await knowledgeStore.generatePriorKnowledge(
        priorKnowledgeContext,
        context.sessionId,
      );

      const observation = createDefaultObservation(
        state,
        testIds,
        nodes,
        priorKnowledge,
      );

      return {
        result: {
          state,
          testIds: { items: testIds },
          a11y: { nodes },
          screenshot,
          priorKnowledge,
        },
        observation,
      };
    },

    classifyError: classifyDiscoveryError,

    sanitizeInputForRecording: () => ({
      includeScreenshot: input.includeScreenshot,
      screenshotName: input.screenshotName,
    }),
  });
}
