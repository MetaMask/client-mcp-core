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
    if (context.driver) {
      const items = await context.driver.getTestIds(limit);
      const { refMap } = await context.driver.getAccessibilityTree();
      context.sessionManager.setRefMap(refMap);
      return createToolSuccess({ items });
    }

    const items = await collectTestIds(context.page, limit);
    const { refMap } = await collectTrimmedA11ySnapshot(context.page);
    context.sessionManager.setRefMap(refMap);
    return createToolSuccess({ items });
  } catch (error) {
    const errorInfo = classifyDiscoveryError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

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
    if (context.driver) {
      const { nodes, refMap } = await context.driver.getAccessibilityTree(
        input.rootSelector,
      );
      context.sessionManager.setRefMap(refMap);
      return createToolSuccess({ nodes });
    }

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

export async function describeScreenTool(
  input: DescribeScreenInput,
  context: ToolContext,
): Promise<ToolResponse<DescribeScreenResult>> {
  const missingSession = requireActiveSession<DescribeScreenResult>(context);
  if (missingSession) {
    return missingSession;
  }

  try {
    const state = context.driver
      ? await context.driver.getAppState()
      : await context.sessionManager.getExtensionState();

    const testIds = context.driver
      ? await context.driver.getTestIds(DEFAULT_TESTID_LIMIT)
      : await collectTestIds(context.page, DEFAULT_TESTID_LIMIT);

    const { nodes, refMap } = context.driver
      ? await context.driver.getAccessibilityTree()
      : await collectTrimmedA11ySnapshot(context.page);

    context.sessionManager.setRefMap(refMap);

    const trackedPages = context.sessionManager.getTrackedPages();
    const activePage = context.sessionManager.getPage();
    const activeTracked = trackedPages.find((tp) => tp.page === activePage);
    const activeTab = activeTracked
      ? { role: activeTracked.role, url: activePage.url() }
      : undefined;

    let screenshot: DescribeScreenResult['screenshot'] = null;

    if (input.includeScreenshot) {
      const screenshotName = input.screenshotName ?? 'describe-screen';
      const result = context.driver
        ? await context.driver.screenshot({
            name: screenshotName,
            fullPage: true,
            includeBase64: input.includeScreenshotBase64,
          })
        : await context.sessionManager.screenshot({
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
