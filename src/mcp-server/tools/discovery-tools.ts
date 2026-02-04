import {
  DEFAULT_TESTID_LIMIT,
  OBSERVATION_TESTID_LIMIT,
} from '../constants.js';
import { collectTestIds, collectTrimmedA11ySnapshot } from '../discovery.js';
import {
  knowledgeStore,
  createDefaultObservation,
} from '../knowledge-store.js';
import { getSessionManager } from '../session-manager.js';
import { classifyDiscoveryError } from './error-classification.js';
import { runTool } from './run-tool.js';
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
} from '../types';

/**
 * Handle listing all visible data-testid attributes on the current page.
 *
 * @param input The input containing optional limit for number of items
 * @param options Optional handler options for the operation
 * @returns Promise resolving to list of visible test IDs with metadata
 */
export async function handleListTestIds(
  input: ListTestIdsInput,
  options?: HandlerOptions,
): Promise<McpResponse<ListTestIdsResult>> {
  const limit = input.limit ?? DEFAULT_TESTID_LIMIT;

  return runTool<ListTestIdsInput, ListTestIdsResult>({
    toolName: 'mm_list_testids',
    input,
    options,
    observationPolicy: 'custom',

    /**
     * Execute the list test IDs operation.
     *
     * @param context The workflow context containing the page
     * @returns The result with test ID items and observation data
     */
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

    /**
     * Sanitizes input for recording by extracting only the limit parameter.
     *
     * @returns Sanitized input with limit value
     */
    sanitizeInputForRecording: () => ({ limit }),
  });
}

/**
 * Handle getting a trimmed accessibility tree with deterministic refs.
 *
 * @param input The input containing optional root selector for scoping
 * @param options Optional handler options for the operation
 * @returns Promise resolving to accessibility nodes with deterministic refs
 */
export async function handleAccessibilitySnapshot(
  input: AccessibilitySnapshotInput,
  options?: HandlerOptions,
): Promise<McpResponse<AccessibilitySnapshotResult>> {
  return runTool<AccessibilitySnapshotInput, AccessibilitySnapshotResult>({
    toolName: 'mm_accessibility_snapshot',
    input,
    options,
    observationPolicy: 'custom',

    /**
     * Execute the accessibility snapshot operation.
     *
     * @param context The workflow context containing the page
     * @returns The result with accessibility nodes and observation data
     */
    execute: async (context) => {
      const { nodes, refMap } = await collectTrimmedA11ySnapshot(
        context.page,
        input.rootSelector,
      );

      getSessionManager().setRefMap(refMap);

      const state = await getSessionManager().getExtensionState();
      const testIds = await collectTestIds(
        context.page,
        OBSERVATION_TESTID_LIMIT,
      );

      return {
        result: { nodes },
        observation: createDefaultObservation(state, testIds, nodes),
      };
    },

    classifyError: classifyDiscoveryError,

    /**
     * Sanitizes input for recording by extracting only the root selector.
     *
     * @returns Sanitized input with rootSelector value
     */
    sanitizeInputForRecording: () => ({ rootSelector: input.rootSelector }),
  });
}

/**
 * Handle getting comprehensive screen state with state, testIds, a11y, and optional screenshot.
 *
 * @param input The input containing screenshot options and selector
 * @param options Optional handler options for the operation
 * @returns Promise resolving to comprehensive screen description with prior knowledge
 */
export async function handleDescribeScreen(
  input: DescribeScreenInput,
  options?: HandlerOptions,
): Promise<McpResponse<DescribeScreenResult>> {
  return runTool<DescribeScreenInput, DescribeScreenResult>({
    toolName: 'mm_describe_screen',
    input,
    options,
    observationPolicy: 'custom',

    /**
     * Execute the describe screen operation.
     *
     * @param context The workflow context containing the page
     * @returns The result with state, testIds, a11y, screenshot, and prior knowledge
     */
    execute: async (context) => {
      const sessionManager = getSessionManager();
      const { page } = context;

      const state = await sessionManager.getExtensionState();
      const testIds = await collectTestIds(page, DEFAULT_TESTID_LIMIT);
      const { nodes, refMap } = await collectTrimmedA11ySnapshot(page);

      sessionManager.setRefMap(refMap);

      let screenshot: DescribeScreenResult['screenshot'] = null;

      if (input.includeScreenshot) {
        const screenshotName = input.screenshotName ?? 'describe-screen';
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

    /**
     * Sanitizes input for recording by extracting screenshot-related parameters.
     *
     * @returns Sanitized input with screenshot options
     */
    sanitizeInputForRecording: () => ({
      includeScreenshot: input.includeScreenshot,
      screenshotName: input.screenshotName,
    }),
  });
}
