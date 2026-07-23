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
import { ErrorCodes } from './types';
import { DEFAULT_TESTID_LIMIT } from './utils/constants.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Validates that the platform driver is available, returning it or an error.
 *
 * @param context - The tool execution context.
 * @returns The driver if available, or an error response.
 */
function requireDriver<TResult>(
  context: ToolContext,
):
  | { driver: NonNullable<ToolContext['driver']> }
  | { error: ToolResponse<TResult> } {
  if (!context.driver) {
    return {
      error: createToolError(
        ErrorCodes.MM_NO_ACTIVE_SESSION,
        'No platform driver available',
      ),
    };
  }
  return { driver: context.driver };
}

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
  const driverResult = requireDriver<ListTestIdsResult>(context);
  if ('error' in driverResult) {
    return driverResult.error;
  }
  const { driver } = driverResult;

  const limit = input.limit ?? DEFAULT_TESTID_LIMIT;

  try {
    const items = await driver.getTestIds(limit);
    const { refMap } = await driver.getAccessibilityTree();
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
  const driverResult = requireDriver<AccessibilitySnapshotResult>(context);
  if ('error' in driverResult) {
    return driverResult.error;
  }
  const { driver } = driverResult;

  try {
    const { nodes, refMap } = await driver.getAccessibilityTree(
      input.rootSelector,
    );
    context.sessionManager.setRefMap(refMap);
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
  const driverResult = requireDriver<DescribeScreenResult>(context);
  if ('error' in driverResult) {
    return driverResult.error;
  }
  const { driver } = driverResult;

  try {
    const state = await driver.getAppState();
    const testIds = await driver.getTestIds(DEFAULT_TESTID_LIMIT);
    const { nodes, refMap } = await driver.getAccessibilityTree();

    context.sessionManager.setRefMap(refMap);

    const trackedPages = context.sessionManager.getTrackedPages();
    let activeTab: DescribeScreenResult['activeTab'];
    try {
      const activePage = context.sessionManager.getPage();
      const activeTracked = trackedPages.find((tp) => tp.page === activePage);
      activeTab = activeTracked
        ? { role: activeTracked.role, url: activePage.url() }
        : undefined;
    } catch {
      activeTab = undefined;
    }

    let screenshot: DescribeScreenResult['screenshot'] = null;

    if (input.includeScreenshot) {
      const screenshotName = input.screenshotName ?? 'describe-screen';
      const result = await driver.screenshot({
        name: screenshotName,
        fullPage: true,
        includeBase64: input.includeScreenshotBase64,
      });

      screenshot = {
        path: result.path,
        ...(result.width === undefined ? {} : { width: result.width }),
        ...(result.height === undefined ? {} : { height: result.height }),
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
      activeTab,
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
