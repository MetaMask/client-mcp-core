/**
 * Unit tests for state tool handler.
 *
 * Tests handleGetState with various scenarios including state snapshot capability,
 * tab tracking, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';

import { getStateTool } from './state.js';
import type { StateSnapshotCapability } from '../capabilities/types.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { MockSessionManagerOptions } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockPage(url = 'chrome-extension://ext-123/home.html') {
  return {
    url: vi.fn().mockReturnValue(url),
  } as never;
}

function createMockContext(
  options: MockSessionManagerOptions & {
    page?: ReturnType<typeof createMockPage>;
    stateSnapshotCapability?: StateSnapshotCapability;
  } = {},
): ToolContext & {
  sessionManager: ReturnType<typeof createMockSessionManager>;
} {
  const page = createMockPage();
  const sessionManager = createMockSessionManager(options);

  sessionManager.getPage.mockReturnValue(options.page ?? page);
  sessionManager.getStateSnapshotCapability.mockReturnValue(
    options.stateSnapshotCapability,
  );

  return {
    sessionManager,
    page: options.page ?? page,
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext & {
    sessionManager: ReturnType<typeof createMockSessionManager>;
  };
}

describe('getStateTool', () => {
  describe('without state snapshot capability', () => {
    it('returns extension state from session manager', async () => {
      const page = createMockPage('chrome-extension://ext-123/home.html');
      const context = createMockContext({
        hasActive: true,
        page,
        extensionState: {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x1234567890123456789012345678901234567890',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        },
        trackedPages: [
          {
            page,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ],
      });

      const result = await getStateTool({}, context);

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
      expect(context.sessionManager.getExtensionState).toHaveBeenCalled();
    });

    it('includes multiple tracked pages in tabs', async () => {
      const extensionPage = createMockPage(
        'chrome-extension://ext-123/home.html',
      );
      const dappPage = createMockPage('https://app.uniswap.org');
      const context = createMockContext({
        hasActive: true,
        page: extensionPage,
        extensionState: {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x1234567890123456789012345678901234567890',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        },
        trackedPages: [
          {
            page: extensionPage,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
          {
            page: dappPage,
            role: 'dapp',
            url: 'https://app.uniswap.org',
          },
        ],
      });

      const result = await getStateTool({}, context);

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
      const page = createMockPage('chrome-extension://ext-123/home.html');
      const context = createMockContext({
        hasActive: true,
        page,
        extensionState: {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: false,
          currentScreen: 'home',
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        },
        trackedPages: [],
      });

      const result = await getStateTool({}, context);

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
      const page = createMockPage('chrome-extension://ext-123/home.html');
      const stateSnapshotCapability: StateSnapshotCapability = {
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
      const context = createMockContext({
        hasActive: true,
        page,
        sessionState: {
          extensionId: 'ext-123',
          ports: { anvil: 8545 },
        } as never,
        trackedPages: [
          {
            page,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ],
        stateSnapshotCapability,
      });

      const result = await getStateTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.state.chainId).toBe(1337);
        expect(result.result.state.networkName).toBe('Localhost 8545');
        expect(result.result.state.balance).toBe('25 ETH');
      }
      expect(stateSnapshotCapability.getState).toHaveBeenCalledWith(page, {
        extensionId: 'ext-123',
        chainId: 1337,
      });
      expect(context.sessionManager.getExtensionState).not.toHaveBeenCalled();
    });

    it('uses chainId 1 when anvil port not present', async () => {
      const page = createMockPage('chrome-extension://ext-123/home.html');
      const stateSnapshotCapability: StateSnapshotCapability = {
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
      const context = createMockContext({
        hasActive: true,
        page,
        sessionState: {
          extensionId: 'ext-123',
          ports: {},
        } as never,
        trackedPages: [
          {
            page,
            role: 'extension',
            url: 'chrome-extension://ext-123/home.html',
          },
        ],
        stateSnapshotCapability,
      });

      const result = await getStateTool({}, context);

      expect(result.ok).toBe(true);
      expect(stateSnapshotCapability.getState).toHaveBeenCalledWith(page, {
        extensionId: 'ext-123',
        chainId: 1,
      });
    });
  });

  describe('error handling', () => {
    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await getStateTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('returns error when getExtensionState fails', async () => {
      const context = createMockContext({ hasActive: true });
      context.sessionManager.getExtensionState.mockRejectedValue(
        new Error('Failed to get state'),
      );

      const result = await getStateTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_STATE_FAILED);
        expect(result.error.message).toContain('Failed to get state');
      }
    });

    it('returns error when page is closed', async () => {
      const context = createMockContext({ hasActive: true });
      context.sessionManager.getExtensionState.mockRejectedValue(
        new Error('Target page, context or browser has been closed'),
      );

      const result = await getStateTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
      }
    });
  });
});
