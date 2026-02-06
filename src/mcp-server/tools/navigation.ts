import { DEFAULT_INTERACTION_TIMEOUT_MS } from '../constants.js';
import { getSessionManager } from '../session-manager.js';
import {
  classifyNavigationError,
  classifyTabError,
  classifyNotificationError,
} from './error-classification.js';
import { runTool } from './run-tool.js';
import type {
  NavigateInput,
  NavigateResult,
  WaitForNotificationInput,
  WaitForNotificationResult,
  SwitchToTabInput,
  SwitchToTabResult,
  CloseTabInput,
  CloseTabResult,
  McpResponse,
  HandlerOptions,
} from '../types';
import { ErrorCodes } from '../types';
import { createErrorResponse } from '../utils';

/**
 * Handles navigation to a specific screen or URL.
 *
 * @param input The navigate input containing target screen and optional URL
 * @param options Optional handler configuration
 * @returns Promise resolving to navigate result with current URL information
 */
export async function handleNavigate(
  input: NavigateInput,
  options?: HandlerOptions,
): Promise<McpResponse<NavigateResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (input.screen === 'url' && !input.url) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'url is required when screen is "url"',
      { input },
      sessionId,
      startTime,
    );
  }

  const validScreens = ['home', 'settings', 'url', 'notification'];
  if (!validScreens.includes(input.screen)) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      `Unknown screen: ${String(input.screen)}`,
      { input },
      sessionId,
      startTime,
    );
  }

  return runTool<NavigateInput, NavigateResult>({
    toolName: 'mm_navigate',
    input,
    options,

    /**
     * Executes the navigation action to the target screen.
     *
     * @param context The tool execution context containing page and reference map
     * @returns Promise resolving to navigate result with success status and URL
     */
    execute: async (context) => {
      switch (input.screen) {
        case 'home':
          await sessionManager.navigateToHome();
          break;
        case 'settings':
          await sessionManager.navigateToSettings();
          break;
        case 'url':
          await sessionManager.navigateToUrl(input.url as string);
          break;
        case 'notification':
          await sessionManager.navigateToNotification();
          break;
        default:
          throw new Error(`Unsupported screen: ${String(input.screen)}`);
      }

      return {
        navigated: true,
        currentUrl: context.page.url(),
      };
    },

    classifyError: classifyNavigationError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with screen and URL information
     */
    sanitizeInputForRecording: () => ({
      screen: input.screen,
      url: input.url,
    }),
  });
}

/**
 * Handles waiting for a notification popup to appear.
 *
 * @param input The wait input containing timeout options
 * @param options Optional handler configuration
 * @returns Promise resolving to wait result with notification page URL
 */
export async function handleWaitForNotification(
  input: WaitForNotificationInput,
  options?: HandlerOptions,
): Promise<McpResponse<WaitForNotificationResult>> {
  const sessionManager = getSessionManager();
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  return runTool<WaitForNotificationInput, WaitForNotificationResult>({
    toolName: 'mm_wait_for_notification',
    input,
    options,

    /**
     * Executes the wait action for notification popup.
     *
     * @returns Promise resolving to wait result with notification page URL
     */
    execute: async () => {
      const notificationPage =
        await sessionManager.waitForNotificationPage(timeoutMs);
      const pageUrl = notificationPage.url();

      return {
        found: true,
        pageUrl,
      };
    },

    classifyError: classifyNotificationError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with timeout information
     */
    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}

/**
 * Handles switching to a different tab by role or URL.
 *
 * @param input The switch input containing tab role or URL to match
 * @param options Optional handler configuration
 * @returns Promise resolving to switch result with active tab information
 */
export async function handleSwitchToTab(
  input: SwitchToTabInput,
  options?: HandlerOptions,
): Promise<McpResponse<SwitchToTabResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (!input.role && !input.url) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'Either role or url must be provided',
      { input },
      sessionId,
      startTime,
    );
  }

  return runTool<SwitchToTabInput, SwitchToTabResult>({
    toolName: 'mm_switch_to_tab',
    input,
    options,

    /**
     * Executes the tab switch action.
     *
     * @param _context The tool execution context containing page and reference map
     * @returns Promise resolving to switch result with active tab information
     */
    execute: async (_context) => {
      const trackedPages = sessionManager.getTrackedPages();
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
      sessionManager.setActivePage(targetPage.page);

      const updatedTrackedPages = sessionManager.getTrackedPages();
      const activeTabInfo = updatedTrackedPages.find(
        (trackedPage) => trackedPage.page === targetPage.page,
      );

      return {
        switched: true,
        activeTab: {
          role: activeTabInfo?.role ?? 'other',
          url: targetPage.page.url(),
        },
      };
    },

    classifyError: classifyTabError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with role and URL information
     */
    sanitizeInputForRecording: () => ({
      role: input.role,
      url: input.url,
    }),
  });
}

/**
 * Handles closing a tab by role or URL.
 *
 * @param input The close input containing tab role or URL to match
 * @param options Optional handler configuration
 * @returns Promise resolving to close result with closed tab URL
 */
export async function handleCloseTab(
  input: CloseTabInput,
  options?: HandlerOptions,
): Promise<McpResponse<CloseTabResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (!input.role && !input.url) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'Either role or url must be provided',
      { input },
      sessionId,
      startTime,
    );
  }

  return runTool<CloseTabInput, CloseTabResult>({
    toolName: 'mm_close_tab',
    input,
    options,

    /**
     * Executes the tab close action.
     *
     * @param context The tool execution context containing page and reference map
     * @returns Promise resolving to close result with closed tab URL
     */
    execute: async (context) => {
      const trackedPages = sessionManager.getTrackedPages();
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

      const currentActivePage = context.page;
      if (targetPage.page === currentActivePage) {
        const extensionPage = trackedPages.find(
          (trackedPage) => trackedPage.role === 'extension',
        );
        if (extensionPage) {
          await extensionPage.page.bringToFront();
          sessionManager.setActivePage(extensionPage.page);
        }
      }

      await targetPage.page.close();

      return {
        closed: true,
        closedUrl,
      };
    },

    classifyError: classifyTabError,

    /**
     * Sanitizes input for knowledge store recording.
     *
     * @returns Sanitized input object with role and URL information
     */
    sanitizeInputForRecording: () => ({
      role: input.role,
      url: input.url,
    }),
  });
}
