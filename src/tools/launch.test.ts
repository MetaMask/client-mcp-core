/**
 * Unit tests for launch tool handler.
 *
 * Tests session launch with various states and error scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { launchTool } from './launch.js';
import type { LaunchInput } from './types';
import type { ExtensionState } from '../capabilities/types.js';
import { DriverLifecycle } from '../server/cleanup-session.js';
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

    it('calls setContext before launch when context is provided', async () => {
      const context = createMockContext({ hasActive: false });
      const input: LaunchInput = {
        context: 'prod',
        stateMode: 'onboarding',
      };

      await launchTool(input, context);

      expect(context.sessionManager.setContext).toHaveBeenCalledWith('prod');
      expect(context.sessionManager.launch).toHaveBeenCalledWith(input);
      const setContextOrder = (
        context.sessionManager.setContext as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      const launchOrder = (
        context.sessionManager.launch as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      expect(setContextOrder).toBeLessThan(launchOrder);
    });

    it('does not call setContext when context is not provided', async () => {
      const context = createMockContext({ hasActive: false });
      const input: LaunchInput = { stateMode: 'default' };

      await launchTool(input, context);

      expect(context.sessionManager.setContext).not.toHaveBeenCalled();
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

    it('cleans up and relaunches when force is true', async () => {
      const context = createMockContext({ hasActive: true });
      vi.spyOn(context.sessionManager, 'cleanup').mockResolvedValue(true);
      const dispose = vi.fn().mockResolvedValue(undefined);
      context.sessionManager.getPlatformDriver = () =>
        ({ dispose }) as unknown as NonNullable<ToolContext['driver']>;

      const result = await launchTool(
        { stateMode: 'default', force: true },
        context,
      );

      expect(result.ok).toBe(true);
      expect(context.sessionManager.cleanup).toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(context.sessionManager.launch).mock.invocationCallOrder[0],
      );
      expect(context.sessionManager.launch).toHaveBeenCalled();
    });

    it('relaunches with force while a stuck driver from an earlier session keeps failing', async () => {
      const context = createMockContext({ hasActive: true });
      const lifecycle = new DriverLifecycle();
      const { sessionManager } = context;
      const stuck = vi.fn().mockRejectedValue(new Error('stuck companion'));
      sessionManager.getPlatformDriver = () =>
        ({ dispose: stuck }) as unknown as NonNullable<ToolContext['driver']>;
      const serverContext: ToolContext = {
        ...context,
        cleanupSession: async () => lifecycle.cleanupSession(sessionManager),
      };
      await expect(
        lifecycle.cleanupSession(sessionManager),
      ).rejects.toThrowError('stuck companion');

      const healthy = vi.fn().mockResolvedValue(undefined);
      sessionManager.getPlatformDriver = () =>
        ({ dispose: healthy }) as unknown as NonNullable<ToolContext['driver']>;
      const result = await launchTool(
        { stateMode: 'default', force: true },
        serverContext,
      );

      expect(result.ok).toBe(true);
      expect(sessionManager.launch).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(stuck).toHaveBeenCalledTimes(2);
    });
  });

  describe('launch failures', () => {
    it('disposes an exposed partial-launch driver even if consumer cleanup fails', async () => {
      const context = createMockContext({ hasActive: false });
      const dispose = vi.fn().mockResolvedValue(undefined);
      context.sessionManager.getPlatformDriver = () =>
        ({ dispose }) as unknown as NonNullable<ToolContext['driver']>;
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        Object.assign(new Error('device failed'), {
          code: ErrorCodes.MM_DEPENDENCIES_MISSING,
        }),
      );
      vi.spyOn(context.sessionManager, 'cleanup').mockRejectedValue(
        new Error('cleanup failed'),
      );

      const result = await launchTool({ stateMode: 'default' }, context);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.MM_DEPENDENCIES_MISSING,
          message: 'device failed',
        },
      });
    });

    it('uses the server-owned cleanup for forced and failed launches', async () => {
      const serverCleanup = vi.fn().mockResolvedValue(true);
      const forced = createMockContext({ hasActive: true });
      await launchTool(
        { stateMode: 'default', force: true },
        { ...forced, cleanupSession: serverCleanup },
      );
      expect(serverCleanup).toHaveBeenCalledTimes(1);
      expect(forced.sessionManager.cleanup).not.toHaveBeenCalled();

      const failed = createMockContext({ hasActive: false });
      vi.spyOn(failed.sessionManager, 'launch').mockRejectedValue(
        new Error('device failed'),
      );
      const result = await launchTool(
        { stateMode: 'default' },
        { ...failed, cleanupSession: serverCleanup },
      );
      expect(result.ok).toBe(false);
      expect(serverCleanup).toHaveBeenCalledTimes(2);
    });

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

    it('preserves a known error code thrown by the session manager', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        Object.assign(new Error('idb is not installed'), {
          code: ErrorCodes.MM_DEPENDENCIES_MISSING,
        }),
      );

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_DEPENDENCIES_MISSING);
        expect(result.error.message).toBe('idb is not installed');
      }
    });

    it('falls back to MM_LAUNCH_FAILED for an unknown error code', async () => {
      const context = createMockContext({ hasActive: false });
      vi.spyOn(context.sessionManager, 'launch').mockRejectedValue(
        Object.assign(new Error('device exploded'), {
          code: 'MM_CONSUMER_SPECIFIC_CODE',
        }),
      );

      const result = await launchTool({ stateMode: 'default' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_LAUNCH_FAILED);
        expect(result.error.message).toContain('device exploded');
      }
    });

    it('forwards mobile launch options to the session manager', async () => {
      const context = createMockContext({ hasActive: false });
      const input: LaunchInput = {
        platform: 'ios',
        deviceId: 'UDID-1',
        appBundlePath: '/tmp/MetaMask.app',
        metroPort: 8082,
        reinstall: true,
        resetAppData: true,
        allowFoxCodeMismatch: true,
      };

      const result = await launchTool(input, context);

      expect(result.ok).toBe(true);
      expect(context.sessionManager.launch).toHaveBeenCalledWith(input);
    });
  });
});
