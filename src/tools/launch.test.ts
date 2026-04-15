/**
 * Unit tests for launch tool handler.
 *
 * Tests session launch with various states and error scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { launchTool } from './launch.js';
import type { LaunchInput } from './types';
import type { ExtensionState } from '../capabilities/types.js';
import type { SessionLaunchResult } from '../server/session-manager.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(
  options: {
    hasActive?: boolean;
    launchResult?: SessionLaunchResult;
    environmentMode?: 'e2e' | 'prod';
  } = {},
): ToolContext {
  return {
    sessionManager: createMockSessionManager(options),
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session-123'),
    },
  } as unknown as ToolContext;
}

describe('launchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful launch', () => {
    it('returns session info on successful launch', async () => {
      const mockState: ExtensionState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://ext-123/home.html',
        extensionId: 'ext-123',
        isUnlocked: false,
        currentScreen: 'home',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      };

      const mockLaunchResult: SessionLaunchResult = {
        sessionId: 'test-session-123',
        extensionId: 'ext-123',
        state: mockState,
      };

      const context = createMockContext({
        hasActive: false,
        launchResult: mockLaunchResult,
      });
      const input: LaunchInput = { stateMode: 'default' };

      const result = await launchTool(input, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessionId).toBe('test-session-123');
        expect(result.result.extensionId).toBe('ext-123');
        expect(result.result.state).toStrictEqual(mockState);
      }
      expect(context.sessionManager.launch).toHaveBeenCalledWith(input);
    });

    it('includes prerequisites in prod mode', async () => {
      const mockState: ExtensionState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://ext-456/home.html',
        extensionId: 'ext-456',
        isUnlocked: true,
        currentScreen: 'home',
        accountAddress: '0x1234',
        networkName: 'Ethereum Mainnet',
        chainId: 1,
        balance: '10 ETH',
      };

      const mockLaunchResult: SessionLaunchResult = {
        sessionId: 'prod-session-456',
        extensionId: 'ext-456',
        state: mockState,
      };

      const context = createMockContext({
        hasActive: false,
        launchResult: mockLaunchResult,
        environmentMode: 'prod',
      });

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.prerequisites).toBeDefined();
        expect(result.result.prerequisites).toHaveLength(3);
        expect(result.result.prerequisites?.[0].step).toBe('Unlock Wallet');
        expect(result.result.prerequisites?.[1].step).toBe('Configure Network');
        expect(result.result.prerequisites?.[2].step).toBe('Set Up Accounts');
      }
    });

    it('does not include prerequisites in e2e mode', async () => {
      const mockState: ExtensionState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://ext-123/home.html',
        extensionId: 'ext-123',
        isUnlocked: false,
        currentScreen: 'home',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      };

      const mockLaunchResult: SessionLaunchResult = {
        sessionId: 'e2e-session-789',
        extensionId: 'ext-123',
        state: mockState,
      };

      const context = createMockContext({
        hasActive: false,
        launchResult: mockLaunchResult,
        environmentMode: 'e2e',
      });

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.prerequisites).toBeUndefined();
      }
    });

    it('passes through all launch input parameters', async () => {
      const context = createMockContext({ hasActive: false });
      const input: LaunchInput = {
        stateMode: 'custom',
        fixturePreset: 'test-preset',
        autoBuild: false,
        slowMo: 100,
        goal: 'Test send flow',
        flowTags: ['send', 'transaction'],
        tags: ['smoke-test'],
        seedContracts: ['hst', 'nfts'],
        ports: {
          anvil: 8546,
          fixtureServer: 12346,
        },
      };

      const result = await launchTool(input, context);

      expect(result.ok).toBe(true);
      expect(context.sessionManager.launch).toHaveBeenCalledWith(input);
    });
  });

  describe('session already running', () => {
    it('returns error when session already active', async () => {
      const context = createMockContext({ hasActive: true });

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SESSION_ALREADY_RUNNING);
        expect(result.error.message).toBe(
          'A session is already running. Call cleanup first, or use --force.',
        );
      }
      expect(context.sessionManager.launch).not.toHaveBeenCalled();
    });
  });

  describe('launch failures', () => {
    it('returns port conflict error for EADDRINUSE', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        new Error('listen EADDRINUSE: address already in use :::8545'),
      );

      const input: LaunchInput = { stateMode: 'default' };
      const result = await launchTool(input, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PORT_IN_USE);
        expect(result.error.message).toContain('Port conflict');
        expect(result.error.message).toContain('EADDRINUSE');
      }
    });

    it('returns port conflict error for port keyword in message', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        new Error('port 8545 is already in use'),
      );

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PORT_IN_USE);
        expect(result.error.message).toContain('Port conflict');
      }
    });

    it('returns generic launch failed error for other errors', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        new Error('Browser failed to start'),
      );

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_LAUNCH_FAILED);
        expect(result.error.message).toContain('Launch failed');
        expect(result.error.message).toContain('Browser failed to start');
      }
    });

    it('handles non-Error exceptions', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        'string error',
      );

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_LAUNCH_FAILED);
        expect(result.error.message).toContain('Launch failed');
      }
    });
  });
});
