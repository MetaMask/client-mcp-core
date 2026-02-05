/**
 * Unit tests for state tool handler.
 *
 * Tests handleGetState with various scenarios including state snapshot capability,
 * tab tracking, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleGetState } from './state.js';
import type { StateSnapshotCapability } from '../../capabilities/types.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager, createMockPage } from '../test-utils';
import { ErrorCodes } from '../types/errors.js';

describe('state', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      sessionMetadata: {
        schemaVersion: 1,
        sessionId: 'test-session-123',
        createdAt: new Date().toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      },
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

  describe('handleGetState', () => {
    describe('without state snapshot capability', () => {
      it('returns extension state from session manager', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue({
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x1234567890123456789012345678901234567890',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        });
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        // Act
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.state).toStrictEqual({
            isLoaded: true,
            currentUrl: 'chrome-extension://ext-123/home.html',
            extensionId: 'ext-123',
            isUnlocked: true,
            currentScreen: 'home',
            accountAddress: '0x1234567890123456789012345678901234567890',
            networkName: 'Ethereum Mainnet',
            chainId: 1,
            balance: '1.5 ETH',
          });
          expect(result.result.tabs).toStrictEqual({
            active: {
              role: 'extension',
              url: 'chrome-extension://ext-123/home.html',
            },
            tracked: [
              {
                role: 'extension',
                url: 'chrome-extension://ext-123/home.html',
              },
            ],
          });
        }
        expect(mockSessionManager.getExtensionState).toHaveBeenCalled();
      });

      it('includes multiple tracked pages in tabs', async () => {
        // Arrange
        const mockExtensionPage = createMockPage();
        vi.spyOn(mockExtensionPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        const mockDappPage = createMockPage();
        vi.spyOn(mockDappPage, 'url').mockReturnValue(
          'https://app.uniswap.org',
        );

        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(
          mockExtensionPage,
        );
        vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue({
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x1234567890123456789012345678901234567890',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        });
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
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.tabs).toBeDefined();
          expect(result.result.tabs?.tracked).toHaveLength(2);
          expect(result.result.tabs?.tracked).toStrictEqual([
            { role: 'extension', url: 'chrome-extension://ext-123/home.html' },
            { role: 'dapp', url: 'https://app.uniswap.org' },
          ]);
        }
      });

      it('handles active page without tracked page info', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue({
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: false,
          currentScreen: 'home',
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        });
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([]);

        // Act
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.tabs).toBeDefined();
          expect(result.result.tabs?.active.role).toBe('other');
          expect(result.result.tabs?.active.url).toBe(
            'chrome-extension://ext-123/home.html',
          );
        }
      });
    });

    describe('with state snapshot capability', () => {
      it('uses state snapshot capability when provided', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getSessionState').mockReturnValue({
          extensionId: 'ext-123',
          ports: { anvil: 8545 },
        });
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        const mockStateSnapshot: StateSnapshotCapability = {
          getState: vi.fn().mockResolvedValue({
            isLoaded: true,
            currentUrl: 'chrome-extension://ext-123/home.html',
            extensionId: 'ext-123',
            isUnlocked: true,
            currentScreen: 'home',
            accountAddress: '0x1234567890123456789012345678901234567890',
            networkName: 'Localhost 8545',
            chainId: 1337,
            balance: '25 ETH',
          }),
          detectCurrentScreen: vi.fn().mockResolvedValue('home'),
        };

        // Act
        const result = await handleGetState({
          stateSnapshotCapability: mockStateSnapshot,
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.state.chainId).toBe(1337);
          expect(result.result.state.networkName).toBe('Localhost 8545');
          expect(result.result.state.balance).toBe('25 ETH');
        }
        expect(mockStateSnapshot.getState).toHaveBeenCalledWith(mockPage, {
          extensionId: 'ext-123',
          chainId: 1337,
        });
        expect(mockSessionManager.getExtensionState).not.toHaveBeenCalled();
      });

      it('uses chainId 1 when anvil port not present', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockPage, 'url').mockReturnValue(
          'chrome-extension://ext-123/home.html',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getSessionState').mockReturnValue({
          extensionId: 'ext-123',
          ports: {},
        });
        vi.spyOn(mockSessionManager, 'getTrackedPages').mockReturnValue([
          {
            page: mockPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ]);

        const mockStateSnapshot: StateSnapshotCapability = {
          getState: vi.fn().mockResolvedValue({
            isLoaded: true,
            currentUrl: 'chrome-extension://ext-123/home.html',
            extensionId: 'ext-123',
            isUnlocked: true,
            currentScreen: 'home',
            accountAddress: '0x1234567890123456789012345678901234567890',
            networkName: 'Ethereum Mainnet',
            chainId: 1,
            balance: '1.5 ETH',
          }),
          detectCurrentScreen: vi.fn().mockResolvedValue('home'),
        };

        // Act
        const result = await handleGetState({
          stateSnapshotCapability: mockStateSnapshot,
        });

        // Assert
        expect(result.ok).toBe(true);
        expect(mockStateSnapshot.getState).toHaveBeenCalledWith(mockPage, {
          extensionId: 'ext-123',
          chainId: 1,
        });
      });
    });

    describe('error handling', () => {
      it('returns error when no active session', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);

        // Act
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });

      it('returns error when getExtensionState fails', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getExtensionState').mockRejectedValue(
          new Error('Failed to get state'),
        );

        // Act
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_STATE_FAILED);
          expect(result.error.message).toContain('Failed to get state');
        }
      });

      it('returns error when page is closed', async () => {
        // Arrange
        const mockPage = createMockPage();
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getExtensionState').mockRejectedValue(
          new Error('Target page, context or browser has been closed'),
        );

        // Act
        const result = await handleGetState();

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
        }
      });
    });
  });
});
