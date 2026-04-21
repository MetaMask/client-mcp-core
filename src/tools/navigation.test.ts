/**
 * Unit tests for navigation tool handlers.
 *
 * Tests handleNavigate, handleWaitForNotification, handleSwitchToTab, and handleCloseTab
 * with various navigation targets, tab operations, and error scenarios.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  navigateTool,
  waitForNotificationTool,
  switchToTabTool,
  closeTabTool,
} from './navigation.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockPage(url = 'about:blank') {
  return {
    url: vi.fn().mockReturnValue(url),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(
  options: {
    hasActive?: boolean;
    page?: ReturnType<typeof createMockPage>;
    trackedPages?: { page: unknown; role: string; url: string }[];
  } = {},
): ToolContext {
  const page = options.page ?? createMockPage();
  const sessionManager = createMockSessionManager({
    hasActive: options.hasActive ?? true,
    trackedPages: options.trackedPages as never,
  });

  return {
    sessionManager,
    page: page as never,
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('navigation', () => {
  describe('navigateTool', () => {
    it('navigates to home screen', async () => {
      const page = createMockPage('chrome-extension://ext-123/home.html');
      const context = createMockContext({ page });

      const result = await navigateTool({ screen: 'home' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.navigated).toBe(true);
        expect(result.result.currentUrl).toBe(
          'chrome-extension://ext-123/home.html',
        );
      }
      expect(context.sessionManager.navigateToHome).toHaveBeenCalled();
    });

    it('navigates to settings screen', async () => {
      const page = createMockPage('chrome-extension://ext-123/settings.html');
      const context = createMockContext({ page });

      const result = await navigateTool({ screen: 'settings' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.currentUrl).toBe(
          'chrome-extension://ext-123/settings.html',
        );
      }
      expect(context.sessionManager.navigateToSettings).toHaveBeenCalled();
    });

    it('navigates to notification screen', async () => {
      const page = createMockPage(
        'chrome-extension://ext-123/notification.html',
      );
      const context = createMockContext({ page });

      const result = await navigateTool({ screen: 'notification' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.currentUrl).toBe(
          'chrome-extension://ext-123/notification.html',
        );
      }
      expect(context.sessionManager.navigateToNotification).toHaveBeenCalled();
    });

    it('navigates to a custom URL', async () => {
      const page = createMockPage('https://app.uniswap.org');
      const context = createMockContext({ page });
      vi.spyOn(context.sessionManager, 'navigateToUrl').mockResolvedValue(
        page as never,
      );

      const result = await navigateTool(
        { screen: 'url', url: 'https://app.uniswap.org' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.currentUrl).toBe('https://app.uniswap.org');
      }
      expect(context.sessionManager.navigateToUrl).toHaveBeenCalledWith(
        'https://app.uniswap.org',
      );
    });

    it('returns error when URL is missing', async () => {
      const context = createMockContext();

      const result = await navigateTool({ screen: 'url' } as never, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('url is required');
      }
    });

    it('returns error for unknown screen', async () => {
      const context = createMockContext();

      const result = await navigateTool(
        { screen: 'invalid' } as never,
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
        expect(result.error.message).toContain('Unknown screen');
      }
    });

    it('classifies navigation failures', async () => {
      const context = createMockContext();
      vi.spyOn(context.sessionManager, 'navigateToHome').mockRejectedValue(
        new Error('Navigation failed'),
      );

      const result = await navigateTool({ screen: 'home' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
      }
    });

    it('returns no active session error when session is missing', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await navigateTool({ screen: 'home' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('waitForNotificationTool', () => {
    it('waits for notification popup with default timeout', async () => {
      const notificationPage = createMockPage(
        'chrome-extension://ext-123/notification.html',
      );
      const context = createMockContext();
      vi.spyOn(
        context.sessionManager,
        'waitForNotificationPage',
      ).mockResolvedValue(notificationPage as never);

      const result = await waitForNotificationTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.found).toBe(true);
        expect(result.result.pageUrl).toBe(
          'chrome-extension://ext-123/notification.html',
        );
      }
      expect(
        context.sessionManager.waitForNotificationPage,
      ).toHaveBeenCalledWith(15000);
    });

    it('uses custom timeout value', async () => {
      const notificationPage = createMockPage(
        'chrome-extension://ext-123/notification.html',
      );
      const context = createMockContext();
      vi.spyOn(
        context.sessionManager,
        'waitForNotificationPage',
      ).mockResolvedValue(notificationPage as never);

      const result = await waitForNotificationTool(
        { timeoutMs: 30000 },
        context,
      );

      expect(result.ok).toBe(true);
      expect(
        context.sessionManager.waitForNotificationPage,
      ).toHaveBeenCalledWith(30000);
    });

    it('classifies notification timeout errors', async () => {
      const context = createMockContext();
      vi.spyOn(
        context.sessionManager,
        'waitForNotificationPage',
      ).mockRejectedValue(new Error('Timeout 15000ms exceeded'));

      const result = await waitForNotificationTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
      }
    });

    it('returns no active session error when session is missing', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await waitForNotificationTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('switchToTabTool', () => {
    it('switches to tab by role', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org');
      const context = createMockContext({
        page: extensionPage,
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          { page: dappPage, role: 'dapp', url: 'https://app.uniswap.org' },
        ],
      });

      const result = await switchToTabTool({ role: 'dapp' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.switched).toBe(true);
        expect(result.result.activeTab.role).toBe('dapp');
        expect(result.result.activeTab.url).toBe('https://app.uniswap.org');
      }
      expect(dappPage.bringToFront).toHaveBeenCalled();
      expect(context.sessionManager.setActivePage).toHaveBeenCalledWith(
        dappPage,
      );
    });

    it('switches to tab by URL prefix', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org/swap');
      const context = createMockContext({
        page: extensionPage,
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: dappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org/swap',
          },
        ],
      });

      const result = await switchToTabTool(
        { url: 'https://app.uniswap.org' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.activeTab.url).toBe(
          'https://app.uniswap.org/swap',
        );
      }
      expect(dappPage.bringToFront).toHaveBeenCalled();
    });

    it('returns invalid input when neither role nor url is provided', async () => {
      const context = createMockContext();

      const result = await switchToTabTool({} as never, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
      }
    });

    it('returns tab not found when no matching tab exists', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const context = createMockContext({
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ],
      });

      const result = await switchToTabTool({ role: 'dapp' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
        expect(result.error.message).toContain('No tab found matching: dapp');
      }
    });
  });

  describe('closeTabTool', () => {
    it('closes tab by role', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org');
      const context = createMockContext({
        page: extensionPage,
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          { page: dappPage, role: 'dapp', url: 'https://app.uniswap.org' },
        ],
      });

      const result = await closeTabTool({ role: 'dapp' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.closed).toBe(true);
        expect(result.result.closedUrl).toBe('https://app.uniswap.org');
      }
      expect(dappPage.close).toHaveBeenCalled();
    });

    it('closes tab by URL prefix', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org/swap');
      const context = createMockContext({
        page: extensionPage,
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: dappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org/swap',
          },
        ],
      });

      const result = await closeTabTool(
        { url: 'https://app.uniswap.org' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.closedUrl).toBe('https://app.uniswap.org/swap');
      }
      expect(dappPage.close).toHaveBeenCalled();
    });

    it('switches to extension tab when closing the active tab', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org');
      const context = createMockContext({
        page: dappPage,
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          { page: dappPage, role: 'dapp', url: 'https://app.uniswap.org' },
        ],
      });

      const result = await closeTabTool({ role: 'dapp' }, context);

      expect(result.ok).toBe(true);
      expect(extensionPage.bringToFront).toHaveBeenCalled();
      expect(context.sessionManager.setActivePage).toHaveBeenCalledWith(
        extensionPage,
      );
      expect(dappPage.close).toHaveBeenCalled();
    });

    it('returns invalid input when neither role nor url is provided', async () => {
      const context = createMockContext();

      const result = await closeTabTool({} as never, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
      }
    });

    it('returns tab not found when no matching tab exists', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const context = createMockContext({
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ],
      });

      const result = await closeTabTool({ role: 'dapp' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
        expect(result.error.message).toContain('No tab found matching: dapp');
      }
    });
  });
});
