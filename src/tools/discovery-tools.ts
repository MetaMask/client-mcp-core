import { classifyDiscoveryError } from './error-classification.js';
import type {
  AccessibilitySnapshotInput,
  AccessibilitySnapshotResult,
  DescribeScreenInput,
  DescribeScreenResult,
  ListTestIdsInput,
  ListTestIdsResult,
  PriorKnowledgeContext,
} from './types';
import {
  DEFAULT_TESTID_LIMIT,
  OBSERVATION_TESTID_LIMIT,
} from './utils/constants.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
} from './utils/discovery.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Collects visible test IDs from the current page.
 *
 * @param input - The test ID collection options including limit.
 * @param context - The tool execution context.
 * @returns The list of discovered test ID items.
 */
export async function listTestIdsTool(
  input: ListTestIdsInput,
  context: ToolContext,
): Promise<ToolResponse<ListTestIdsResult>> {
  const missingSession = requireActiveSession<ListTestIdsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const limit = input.limit ?? DEFAULT_TESTID_LIMIT;

  try {
    const items = await collectTestIds(context.page, limit);
    const { refMap } = await collectTrimmedA11ySnapshot(context.page);

    context.sessionManager.setRefMap(refMap);

    return createToolSuccess({ items });
  } catch (error) {
    const errorInfo = classifyDiscoveryError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Captures a trimmed accessibility tree snapshot of the current page.
 *
 * @param input - The snapshot options including optional root selector.
 * @param context - The tool execution context.
 * @returns The accessibility snapshot nodes.
 */
export async function accessibilitySnapshotTool(
  input: AccessibilitySnapshotInput,
  context: ToolContext,
): Promise<ToolResponse<AccessibilitySnapshotResult>> {
  const missingSession =
    requireActiveSession<AccessibilitySnapshotResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    const { nodes, refMap } = await collectTrimmedA11ySnapshot(
      context.page,
      input.rootSelector,
    );

    context.sessionManager.setRefMap(refMap);
    await collectTestIds(context.page, OBSERVATION_TESTID_LIMIT);

    return createToolSuccess({ nodes });
  } catch (error) {
    const errorInfo = classifyDiscoveryError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Captures a full screen description including state, test IDs, a11y, and prior knowledge.
 *
 * @param input - The describe-screen options including screenshot flags.
 * @param context - The tool execution context.
 * @returns The composite screen description result.
 */
export async function describeScreenTool(
  input: DescribeScreenInput,
  context: ToolContext,
): Promise<ToolResponse<DescribeScreenResult>> {
  const missingSession = requireActiveSession<DescribeScreenResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    const state = await context.sessionManager.getExtensionState();
    const testIds = await collectTestIds(context.page, DEFAULT_TESTID_LIMIT);
    const { nodes, refMap } = await collectTrimmedA11ySnapshot(context.page);

    context.sessionManager.setRefMap(refMap);

    let screenshot: DescribeScreenResult['screenshot'] = null;

    if (input.includeScreenshot) {
      const screenshotName = input.screenshotName ?? 'describe-screen';
      const result = await context.sessionManager.screenshot({
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

    const sessionMetadata = context.sessionManager.getSessionMetadata();
    const priorKnowledgeContext: PriorKnowledgeContext = {
      currentScreen: state.currentScreen,
      currentUrl: state.currentUrl,
      visibleTestIds: testIds,
      a11yNodes: nodes,
      currentSessionFlowTags: sessionMetadata?.flowTags,
    };

    const priorKnowledge = await context.knowledgeStore.generatePriorKnowledge(
      priorKnowledgeContext,
      context.sessionManager.getSessionId(),
    );

    return createToolSuccess({
      state,
      testIds: { items: testIds },
      a11y: { nodes },
      screenshot,
      priorKnowledge,
    });
  } catch (error) {
    const errorInfo = classifyDiscoveryError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
