/**
 * Unit tests for launch tool handler.
 *
 * Tests session launch with various states and error scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleLaunch } from './launch.js';
import type { ExtensionState } from '../../capabilities/types.js';
import * as sessionManagerModule from '../session-manager.js';
import type { SessionLaunchResult } from '../session-manager.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';
import { ErrorCodes } from '../types';
import type { LaunchInput } from '../types';

describe('handleLaunch', () => {
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

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.sessionId).toBe('test-session-123');
        expect(result.result.extensionId).toBe('ext-123');
        expect(result.result.state).toStrictEqual(mockState);
        expect(result.meta.sessionId).toBe('test-session-123');
      }
      expect(mockSessionManager.launch).toHaveBeenCalledWith(input);
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

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
        environmentMode: 'prod',
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

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

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
        environmentMode: 'e2e',
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.prerequisites).toBeUndefined();
      }
    });

    it('passes through all launch input parameters', async () => {
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
        sessionId: 'custom-session',
        extensionId: 'ext-123',
        state: mockState,
      };

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

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

      const result = await handleLaunch(input);

      expect(result.ok).toBe(true);
      expect(mockSessionManager.launch).toHaveBeenCalledWith(input);
    });
  });

  describe('session already running', () => {
    it('returns error when session already active', async () => {
      const mockSessionManager = createMockSessionManager({
        hasActive: true,
        sessionId: 'existing-session-999',
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SESSION_ALREADY_RUNNING);
        expect(result.error.message).toBe(
          'A session is already running or launch is in progress. Call mm_cleanup first.',
        );
        expect(result.error.details).toStrictEqual({
          currentSessionId: 'existing-session-999',
          launchInProgress: false,
        });
        expect(result.meta.sessionId).toBe('existing-session-999');
      }
      expect(mockSessionManager.launch).not.toHaveBeenCalled();
    });

    it('returns error when launch is in progress', async () => {
      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchInProgress: true,
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SESSION_ALREADY_RUNNING);
        expect(result.error.message).toBe(
          'A session is already running or launch is in progress. Call mm_cleanup first.',
        );
        expect(result.error.details).toStrictEqual({
          currentSessionId: undefined,
          launchInProgress: true,
        });
      }
      expect(mockSessionManager.launch).not.toHaveBeenCalled();
    });
  });

  describe('launch failures', () => {
    it('returns port conflict error for EADDRINUSE', async () => {
      const mockSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(mockSessionManager, 'launch').mockRejectedValue(
        new Error('listen EADDRINUSE: address already in use :::8545'),
      );
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PORT_IN_USE);
        expect(result.error.message).toContain('Port conflict');
        expect(result.error.message).toContain('EADDRINUSE');
        expect(result.error.details).toStrictEqual({ input });
      }
    });

    it('returns port conflict error for port keyword in message', async () => {
      const mockSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(mockSessionManager, 'launch').mockRejectedValue(
        new Error('port 8545 is already in use'),
      );
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_PORT_IN_USE);
        expect(result.error.message).toContain('Port conflict');
      }
    });

    it('returns generic launch failed error for other errors', async () => {
      const mockSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(mockSessionManager, 'launch').mockRejectedValue(
        new Error('Browser failed to start'),
      );
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_LAUNCH_FAILED);
        expect(result.error.message).toContain('Launch failed');
        expect(result.error.message).toContain('Browser failed to start');
        expect(result.error.details).toStrictEqual({ input });
      }
    });

    it('preserves session-already-running error from session manager', async () => {
      const mockSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(mockSessionManager, 'launch').mockRejectedValue(
        new Error(ErrorCodes.MM_SESSION_ALREADY_RUNNING),
      );
      vi.spyOn(mockSessionManager, 'isLaunchInProgress').mockReturnValue(true);
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SESSION_ALREADY_RUNNING);
        expect(result.error.details).toStrictEqual({
          currentSessionId: undefined,
          launchInProgress: true,
        });
      }
    });

    it('handles non-Error exceptions', async () => {
      const mockSessionManager = createMockSessionManager({ hasActive: false });
      vi.spyOn(mockSessionManager, 'launch').mockRejectedValue('string error');
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_LAUNCH_FAILED);
        expect(result.error.message).toContain('Launch failed');
      }
    });
  });

  describe('response metadata', () => {
    it('includes timestamp in response', async () => {
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

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta.timestamp).toBeDefined();
        expect(typeof result.meta.timestamp).toBe('string');
        expect(new Date(result.meta.timestamp).getTime()).toBeGreaterThan(0);
      }
    });

    it('includes durationMs in response', async () => {
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

      const mockSessionManager = createMockSessionManager({
        hasActive: false,
        launchResult: mockLaunchResult,
      });
      vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
        mockSessionManager,
      );

      const input: LaunchInput = { stateMode: 'default' };

      const result = await handleLaunch(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof result.meta.durationMs).toBe('number');
      }
    });
  });
});
