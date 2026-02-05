/**
 * Unit tests for navigation tool handlers.
 *
 * Tests handleNavigate, handleWaitForNotification, handleSwitchToTab, and handleCloseTab
 * with various navigation targets, tab operations, and error scenarios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  handleNavigate,
  handleWaitForNotification,
  handleSwitchToTab,
  handleCloseTab,
} from './navigation';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager, createMockPage } from '../test-utils';
import { ErrorCodes } from '../types';

describe('navigation', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
    // Mock knowledge store to prevent "not initialized" errors
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
      getGitInfoSync: vi
        .fn()
        .mockReturnValue({ branch: 'main', commit: 'abc123' }),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleNavigate', () => {
    describe('with home screen', () => {
      it('navigates to home screen', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'navigateToHome').mockResolvedValue(
          undefined,
        );

        // Act
        const result = await handleNavigate({ screen: 'home' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.navigated).toBe(true);
          expect(result.result.currentUrl).toBe(
            'chrome-extension://ext-123/home.html',
          );
        }
        expect(mockSessionManager.navigateToHome).toHaveBeenCalled();
      });
    });

    describe('with settings screen', () => {
      it('navigates to settings screen', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/settings.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'navigateToSettings').mockResolvedValue(
          undefined,
        );

        // Act
        const result = await handleNavigate({ screen: 'settings' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.navigated).toBe(true);
          expect(result.result.currentUrl).toBe(
            'chrome-extension://ext-123/settings.html',
          );
        }
        expect(mockSessionManager.navigateToSettings).toHaveBeenCalled();
      });
    });

    describe('with notification screen', () => {
      it('navigates to notification screen', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/notification.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(
          mockSessionManager,
          'navigateToNotification',
        ).mockResolvedValue(undefined);

        // Act
        const result = await handleNavigate({ screen: 'notification' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.navigated).toBe(true);
          expect(result.result.currentUrl).toBe(
            'chrome-extension://ext-123/notification.html',
          );
        }
        expect(mockSessionManager.navigateToNotification).toHaveBeenCalled();
      });
    });

    describe('with URL screen', () => {
      it('navigates to custom URL', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue('https://app.uniswap.org');
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'navigateToUrl').mockResolvedValue(
          mockPage,
        );

        // Act
        const result = await handleNavigate({
          screen: 'url',
          url: 'https://app.uniswap.org',
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.navigated).toBe(true);
          expect(result.result.currentUrl).toBe('https://app.uniswap.org');
        }
        expect(mockSessionManager.navigateToUrl).toHaveBeenCalledWith(
          'https://app.uniswap.org',
        );
      });

      it('returns error when URL is missing', async () => {
        // Act
        const result = await handleNavigate({ screen: 'url' } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('url is required');
        }
      });
    });

    describe('with invalid screen', () => {
      it('returns error for unknown screen', async () => {
        // Act
        const result = await handleNavigate({ screen: 'invalid' } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Unknown screen');
        }
      });
    });

    describe('with navigation errors', () => {
      it('returns error when navigation fails', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'navigateToHome').mockRejectedValue(
          new Error('Navigation failed'),
        );

        // Act
        const result = await handleNavigate({ screen: 'home' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
        }
      });

      it('returns error when page closed during navigation', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'navigateToSettings').mockRejectedValue(
          new Error('Target page, context or browser has been closed'),
        );

        // Act
        const result = await handleNavigate({ screen: 'settings' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
          expect(result.error.message).toContain(
            'Page closed during navigation',
          );
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);

        // Act
        const result = await handleNavigate({ screen: 'home' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });

  describe('handleWaitForNotification', () => {
    describe('with default timeout', () => {
      it('waits for notification popup', async () => {
        // Arrange
        const mockNotificationPage = createMockPage();
        vi.spyOn(mockNotificationPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/notification.html',
        );
        vi.spyOn(
          mockSessionManager,
          'waitForNotificationPage',
        ).mockResolvedValue(mockNotificationPage);

        // Act
        const result = await handleWaitForNotification({});

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.found).toBe(true);
          expect(result.result.pageUrl).toBe(
            'chrome-extension://ext-123/notification.html',
          );
        }
        expect(mockSessionManager.waitForNotificationPage).toHaveBeenCalledWith(
          15000,
        );
      });
    });

    describe('with custom timeout', () => {
      it('uses custom timeout value', async () => {
        // Arrange
        const mockNotificationPage = createMockPage();
        vi.spyOn(mockNotificationPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/notification.html',
        );
        vi.spyOn(
          mockSessionManager,
          'waitForNotificationPage',
        ).mockResolvedValue(mockNotificationPage);

        // Act
        const result = await handleWaitForNotification({ timeoutMs: 30000 });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.found).toBe(true);
        }
        expect(mockSessionManager.waitForNotificationPage).toHaveBeenCalledWith(
          30000,
        );
      });
    });

    describe('with timeout errors', () => {
      it('returns error when notification not found within timeout', async () => {
        // Arrange
        vi.spyOn(
          mockSessionManager,
          'waitForNotificationPage',
        ).mockRejectedValue(new Error('Timeout 15000ms exceeded'));

        // Act
        const result = await handleWaitForNotification({});

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
        }
      });

      it('returns error when browser closed during wait', async () => {
        // Arrange
        vi.spyOn(
          mockSessionManager,
          'waitForNotificationPage',
        ).mockRejectedValue(new Error('browser has been closed'));

        // Act
        const result = await handleWaitForNotification({});

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
          expect(result.error.message).toContain(
            'Browser closed while waiting for notification',
          );
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);

        // Act
        const result = await handleWaitForNotification({});

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });

  describe('handleSwitchToTab', () => {
    describe('with role matching', () => {
      it('switches to tab by role', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockExtensionPage, 'bringToFront').mockResolvedValue(
          undefined,
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org',
        );
        vi.spyOn(mockDappPage, 'bringToFront').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockDappPage);
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org',
          },
        ]);
        vi.spyOn(mockSessionManager, 'setActivePage');

        // Act
        const result = await handleSwitchToTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.switched).toBe(true);
          expect(result.result.activeTab.role).toBe('dapp');
          expect(result.result.activeTab.url).toBe('https://app.uniswap.org');
        }
        expect(mockDappPage.bringToFront).toHaveBeenCalled();
        expect(mockSessionManager.setActivePage).toHaveBeenCalledWith(
          mockDappPage,
        );
      });
    });

    describe('with URL matching', () => {
      it('switches to tab by URL prefix', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockExtensionPage, 'bringToFront').mockResolvedValue(
          undefined,
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org/swap',
        );
        vi.spyOn(mockDappPage, 'bringToFront').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockDappPage);
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org/swap',
          },
        ]);
        vi.spyOn(mockSessionManager, 'setActivePage');

        // Act
        const result = await handleSwitchToTab({
          url: 'https://app.uniswap.org',
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.switched).toBe(true);
          expect(result.result.activeTab.url).toBe(
            'https://app.uniswap.org/swap',
          );
        }
        expect(mockDappPage.bringToFront).toHaveBeenCalled();
      });
    });

    describe('with invalid input', () => {
      it('returns error when neither role nor url provided', async () => {
        // Act
        const result = await handleSwitchToTab({} as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain(
            'Either role or url must be provided',
          );
        }
      });
    });

    describe('with tab not found', () => {
      it('returns error when no matching tab found by role', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        // Act
        const result = await handleSwitchToTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
          expect(result.error.message).toContain('No tab found matching: dapp');
        }
      });

      it('returns error when no matching tab found by URL', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        // Act
        const result = await handleSwitchToTab({
          url: 'https://app.uniswap.org',
        });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);

        // Act
        const result = await handleSwitchToTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });

  describe('handleCloseTab', () => {
    describe('with role matching', () => {
      it('closes tab by role', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org',
        );
        vi.spyOn(mockDappPage, 'close').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(
          mockExtensionPage,
        );
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org',
          },
        ]);

        // Act
        const result = await handleCloseTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.closed).toBe(true);
          expect(result.result.closedUrl).toBe('https://app.uniswap.org');
        }
        expect(mockDappPage.close).toHaveBeenCalled();
      });
    });

    describe('with URL matching', () => {
      it('closes tab by URL prefix', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org/swap',
        );
        vi.spyOn(mockDappPage, 'close').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(
          mockExtensionPage,
        );
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org/swap',
          },
        ]);

        // Act
        const result = await handleCloseTab({ url: 'https://app.uniswap.org' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.closed).toBe(true);
          expect(result.result.closedUrl).toBe('https://app.uniswap.org/swap');
        }
        expect(mockDappPage.close).toHaveBeenCalled();
      });
    });

    describe('with active tab closure', () => {
      it('switches to extension tab when closing active tab', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockExtensionPage, 'bringToFront').mockResolvedValue(
          undefined,
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org',
        );
        vi.spyOn(mockDappPage, 'close').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockDappPage);
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org',
          },
        ]);
        vi.spyOn(mockSessionManager, 'setActivePage');

        // Act
        const result = await handleCloseTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.closed).toBe(true);
        }
        expect(mockExtensionPage.bringToFront).toHaveBeenCalled();
        expect(mockSessionManager.setActivePage).toHaveBeenCalledWith(
          mockExtensionPage,
        );
        expect(mockDappPage.close).toHaveBeenCalled();
      });

      it('does not switch when closing non-active tab', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockExtensionPage, 'bringToFront').mockResolvedValue(
          undefined,
        );

        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org',
        );
        vi.spyOn(mockDappPage, 'close').mockResolvedValue(undefined);

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(
          mockExtensionPage,
        );
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: mockDappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org',
          },
        ]);
        vi.spyOn(mockSessionManager, 'setActivePage');

        // Act
        const result = await handleCloseTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(true);
        expect(mockExtensionPage.bringToFront).not.toHaveBeenCalled();
        expect(mockSessionManager.setActivePage).not.toHaveBeenCalled();
        expect(mockDappPage.close).toHaveBeenCalled();
      });
    });

    describe('with invalid input', () => {
      it('returns error when neither role nor url provided', async () => {
        // Act
        const result = await handleCloseTab({} as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain(
            'Either role or url must be provided',
          );
        }
      });
    });

    describe('with tab not found', () => {
      it('returns error when no matching tab found by role', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        // Act
        const result = await handleCloseTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
          expect(result.error.message).toContain('No tab found matching: dapp');
        }
      });

      it('returns error when no matching tab found by URL', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockExtensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        // Act
        const result = await handleCloseTab({ url: 'https://app.uniswap.org' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);

        // Act
        const result = await handleCloseTab({ role: 'dapp' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });
});
