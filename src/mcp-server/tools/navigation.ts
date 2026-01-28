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
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createErrorResponse } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";
import { DEFAULT_INTERACTION_TIMEOUT_MS } from "../constants.js";
import { runTool } from "./run-tool.js";
import {
  classifyNavigationError,
  classifyTabError,
  classifyNotificationError,
} from "./error-classification.js";

export async function handleNavigate(
  input: NavigateInput,
  options?: HandlerOptions,
): Promise<McpResponse<NavigateResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (input.screen === "url" && !input.url) {
    return createErrorResponse(
      ErrorCodes.MM_INVALID_INPUT,
      'url is required when screen is "url"',
      { input },
      sessionId,
      startTime,
    );
  }

  const validScreens = ["home", "settings", "url", "notification"];
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
    toolName: "mm_navigate",
    input,
    options,

    execute: async (context) => {
      switch (input.screen) {
        case "home":
          await sessionManager.navigateToHome();
          break;
        case "settings":
          await sessionManager.navigateToSettings();
          break;
        case "url":
          await sessionManager.navigateToUrl(input.url!);
          break;
        case "notification":
          await sessionManager.navigateToNotification();
          break;
      }

      return {
        navigated: true,
        currentUrl: context.page.url(),
      };
    },

    classifyError: classifyNavigationError,

    sanitizeInputForRecording: () => ({
      screen: input.screen,
      url: input.url,
    }),
  });
}

export async function handleWaitForNotification(
  input: WaitForNotificationInput,
  options?: HandlerOptions,
): Promise<McpResponse<WaitForNotificationResult>> {
  const sessionManager = getSessionManager();
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;

  return runTool<WaitForNotificationInput, WaitForNotificationResult>({
    toolName: "mm_wait_for_notification",
    input,
    options,

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

    sanitizeInputForRecording: () => ({ timeoutMs }),
  });
}

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
      "Either role or url must be provided",
      { input },
      sessionId,
      startTime,
    );
  }

  return runTool<SwitchToTabInput, SwitchToTabResult>({
    toolName: "mm_switch_to_tab",
    input,
    options,

    execute: async (context) => {
      const trackedPages = sessionManager.getTrackedPages();
      const targetPage = trackedPages.find((p) => {
        if (input.role) {
          return p.role === input.role;
        }
        if (input.url) {
          return p.url.startsWith(input.url);
        }
        return false;
      });

      if (!targetPage) {
        const availableTabs = trackedPages.map((p) => ({
          role: p.role,
          url: p.url,
        }));
        throw new Error(
          `No tab found matching: ${input.role ?? input.url}. Available tabs: ${JSON.stringify(availableTabs)}`,
        );
      }

      await targetPage.page.bringToFront();
      sessionManager.setActivePage(targetPage.page);

      const updatedTrackedPages = sessionManager.getTrackedPages();
      const activeTabInfo = updatedTrackedPages.find(
        (p) => p.page === targetPage.page,
      );

      return {
        switched: true,
        activeTab: {
          role: activeTabInfo?.role ?? "other",
          url: context.page.url(),
        },
      };
    },

    classifyError: classifyTabError,

    sanitizeInputForRecording: () => ({
      role: input.role,
      url: input.url,
    }),
  });
}

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
      "Either role or url must be provided",
      { input },
      sessionId,
      startTime,
    );
  }

  return runTool<CloseTabInput, CloseTabResult>({
    toolName: "mm_close_tab",
    input,
    options,

    execute: async (context) => {
      const trackedPages = sessionManager.getTrackedPages();
      const targetPage = trackedPages.find((p) => {
        if (input.role) {
          return p.role === input.role;
        }
        if (input.url) {
          return p.url.startsWith(input.url);
        }
        return false;
      });

      if (!targetPage) {
        throw new Error(`No tab found matching: ${input.role ?? input.url}`);
      }

      const closedUrl = targetPage.url;

      const currentActivePage = context.page;
      if (targetPage.page === currentActivePage) {
        const extensionPage = trackedPages.find((p) => p.role === "extension");
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

    sanitizeInputForRecording: () => ({
      role: input.role,
      url: input.url,
    }),
  });
}
