import {
  classifyNavigationError,
  classifyNotificationError,
  classifyTabError,
} from './error-classification.js';
import type {
  CloseTabInput,
  CloseTabResult,
  NavigateInput,
  NavigateResult,
  SwitchToTabInput,
  SwitchToTabResult,
  WaitForNotificationInput,
  WaitForNotificationResult,
} from './types';
import { ErrorCodes } from './types';
import { DEFAULT_INTERACTION_TIMEOUT_MS } from './utils/constants.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Navigates the browser to a specified screen or URL.
 *
 * @param input - The navigation target screen and optional URL.
 * @param context - The tool execution context.
 * @returns The navigation result with the current URL.
 */
export async function navigateTool(
  input: NavigateInput,
  context: ToolContext,
): Promise<ToolResponse<NavigateResult>> {
  const missingSession = requireActiveSession<NavigateResult>(context);
  if (missingSession) {
    return missingSession;
  }

  if (input.screen === 'url' && !input.url) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'url is required when screen is "url"',
    );
  }

  const validScreens = ['home', 'settings', 'url', 'notification'];
  if (!validScreens.includes(input.screen)) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      `Unknown screen: ${String(input.screen)}`,
    );
  }

  try {
    switch (input.screen) {
      case 'home':
        await context.sessionManager.navigateToHome();
        break;
      case 'settings':
        await context.sessionManager.navigateToSettings();
        break;
      case 'url':
        await context.sessionManager.navigateToUrl(input.url as string);
        break;
      case 'notification':
        await context.sessionManager.navigateToNotification();
        break;
      default:
        throw new Error(`Unsupported screen: ${String(input.screen)}`);
    }

    return createToolSuccess({
      navigated: true,
      currentUrl: context.page.url(),
    });
  } catch (error) {
    const errorInfo = classifyNavigationError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Waits for a notification page to appear within a timeout.
 *
 * @param input - The notification wait options including timeout.
 * @param context - The tool execution context.
 * @returns The notification page URL when found.
 */
export async function waitForNotificationTool(
  input: WaitForNotificationInput,
  context: ToolContext,
): Promise<ToolResponse<WaitForNotificationResult>> {
  const missingSession =
    requireActiveSession<WaitForNotificationResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  try {
    const notificationPage =
      await context.sessionManager.waitForNotificationPage(timeoutMs);

    return createToolSuccess({
      found: true,
      pageUrl: notificationPage.url(),
    });
  } catch (error) {
    const errorInfo = classifyNotificationError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Switches the active page to a tab matching the given role or URL.
 *
 * @param input - The tab selection criteria (role or URL).
 * @param context - The tool execution context.
 * @returns The active tab info after switching.
 */
export async function switchToTabTool(
  input: SwitchToTabInput,
  context: ToolContext,
): Promise<ToolResponse<SwitchToTabResult>> {
  const missingSession = requireActiveSession<SwitchToTabResult>(context);
  if (missingSession) {
    return missingSession;
  }

  if (!input.role && !input.url) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'Either role or url must be provided',
    );
  }

  try {
    const trackedPages = context.sessionManager.getTrackedPages();
    const targetPage = trackedPages.find((trackedPage) => {
      if (input.role) {
        return trackedPage.role === input.role;
      }
      if (input.url) {
        return trackedPage.url.startsWith(input.url);
      }
      return false;
    });

    if (!targetPage) {
      const availableTabs = trackedPages.map((trackedPage) => ({
        role: trackedPage.role,
        url: trackedPage.url,
      }));
      throw new Error(
        `No tab found matching: ${input.role ?? input.url}. Available tabs: ${JSON.stringify(availableTabs)}`,
      );
    }

    await targetPage.page.bringToFront();
    context.sessionManager.setActivePage(targetPage.page);

    const activeTabInfo = context.sessionManager
      .getTrackedPages()
      .find((trackedPage) => trackedPage.page === targetPage.page);

    return createToolSuccess({
      switched: true,
      activeTab: {
        role: activeTabInfo?.role ?? 'other',
        url: targetPage.page.url(),
      },
    });
  } catch (error) {
    const errorInfo = classifyTabError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Closes a browser tab matching the given role or URL.
 *
 * @param input - The tab selection criteria (role or URL).
 * @param context - The tool execution context.
 * @returns The close result with the closed tab URL.
 */
export async function closeTabTool(
  input: CloseTabInput,
  context: ToolContext,
): Promise<ToolResponse<CloseTabResult>> {
  const missingSession = requireActiveSession<CloseTabResult>(context);
  if (missingSession) {
    return missingSession;
  }

  if (!input.role && !input.url) {
    return createToolError(
      ErrorCodes.MM_INVALID_INPUT,
      'Either role or url must be provided',
    );
  }

  try {
    const trackedPages = context.sessionManager.getTrackedPages();
    const targetPage = trackedPages.find((trackedPage) => {
      if (input.role) {
        return trackedPage.role === input.role;
      }
      if (input.url) {
        return trackedPage.url.startsWith(input.url);
      }
      return false;
    });

    if (!targetPage) {
      throw new Error(`No tab found matching: ${input.role ?? input.url}`);
    }

    const closedUrl = targetPage.url;

    if (targetPage.page === context.page) {
      const otherPages = trackedPages.filter(
        (trackedPage) => trackedPage.page !== targetPage.page,
      );
      const fallbackPage =
        otherPages.find((trackedPage) => trackedPage.role === 'extension') ??
        otherPages[0];

      if (fallbackPage) {
        await fallbackPage.page.bringToFront();
        context.sessionManager.setActivePage(fallbackPage.page);
      }
    }

    await targetPage.page.close();

    return createToolSuccess({
      closed: true,
      closedUrl,
    });
  } catch (error) {
    const errorInfo = classifyTabError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
