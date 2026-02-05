/**
 * Shared mock factory utilities for unit testing.
 *
 * Provides factory functions that return fresh mock instances following MetaMask testing guidelines:
 * - Each factory call returns NEW object instances (test isolation)
 * - Each factory creates fresh vi.fn() mocks (never reused)
 * - Factories accept options for customization
 * - Sensible defaults so most tests need no options
 */

import { vi } from 'vitest';

import type { ExtensionState } from '../../capabilities/types.js';
import type { KnowledgeStore } from '../knowledge-store.js';
import type { TrackedPage, SessionLaunchResult } from '../session-manager.js';
import type { SessionState } from '../types/session.js';
import type { SessionMetadata } from '../types/step-record.js';

/**
 * Options for customizing mock session manager behavior
 */
export type MockSessionManagerOptions = {
  hasActive?: boolean;
  sessionId?: string;
  sessionState?: SessionState;
  sessionMetadata?: SessionMetadata;
  launchResult?: SessionLaunchResult;
  trackedPages?: TrackedPage[];
  extensionState?: ExtensionState;
  refMap?: Map<string, string>;
  environmentMode?: 'e2e' | 'prod';
};

/**
 * Options for customizing mock knowledge store behavior
 */
export type MockKnowledgeStoreOptions = {
  lastSteps?: Record<string, unknown>[];
  searchResults?: Record<string, unknown>[];
  sessionSummary?: Record<string, unknown>;
  sessions?: Record<string, unknown>[];
};

/**
 * Create a fresh mock ISessionManager instance.
 *
 * Each call returns a NEW object with fresh vi.fn() mocks.
 * Follows the pattern from session-manager.test.ts:15-48.
 *
 * @param options - Customize mock behavior
 * @returns Fresh ISessionManager mock
 */
export function createMockSessionManager(
  options: MockSessionManagerOptions = {},
) {
  return {
    // Session Lifecycle
    hasActiveSession: vi.fn().mockReturnValue(options.hasActive ?? false),
    getSessionId: vi.fn().mockReturnValue(options.sessionId ?? undefined),
    getSessionState: vi.fn().mockReturnValue(options.sessionState ?? undefined),
    getSessionMetadata: vi
      .fn()
      .mockReturnValue(options.sessionMetadata ?? undefined),
    launch: vi.fn().mockResolvedValue(
      options.launchResult ?? {
        sessionId: 'test-session-123',
        extensionId: 'ext-123',
        state: {
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
      },
    ),
    cleanup: vi.fn().mockResolvedValue(true),

    // Page Management
    getPage: vi.fn(),
    setActivePage: vi.fn(),
    getTrackedPages: vi.fn().mockReturnValue(options.trackedPages ?? []),
    classifyPageRole: vi.fn().mockReturnValue('extension'),
    getContext: vi.fn(),

    // Extension State
    getExtensionState: vi.fn().mockResolvedValue(
      options.extensionState ?? {
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
    ),

    // A11y Reference Map
    setRefMap: vi.fn(),
    getRefMap: vi.fn().mockReturnValue(options.refMap ?? new Map()),
    clearRefMap: vi.fn(),
    resolveA11yRef: vi.fn(),

    // Navigation
    navigateToHome: vi.fn().mockResolvedValue(undefined),
    navigateToSettings: vi.fn().mockResolvedValue(undefined),
    navigateToUrl: vi.fn(),
    navigateToNotification: vi.fn(),
    waitForNotificationPage: vi.fn(),

    // Screenshots
    screenshot: vi.fn().mockResolvedValue({
      path: '/path/to/screenshot.png',
      width: 1280,
      height: 720,
    }),

    // Capabilities
    getBuildCapability: vi.fn().mockReturnValue(undefined),
    getFixtureCapability: vi.fn().mockReturnValue(undefined),
    getChainCapability: vi.fn().mockReturnValue(undefined),
    getContractSeedingCapability: vi.fn().mockReturnValue(undefined),
    getStateSnapshotCapability: vi.fn().mockReturnValue(undefined),

    // Environment
    getEnvironmentMode: vi
      .fn()
      .mockReturnValue(options.environmentMode ?? 'e2e'),

    // Context
    setContext: vi.fn().mockReturnValue(undefined),
    getContextInfo: vi.fn().mockReturnValue({
      currentContext: options.environmentMode ?? 'e2e',
      hasActiveSession: options.hasActive ?? false,
      sessionId: options.sessionId ?? null,
      capabilities: { available: [] },
      canSwitchContext: !(options.hasActive ?? false),
    }),
  };
}

/**
 * Create a fresh mock KnowledgeStore instance.
 *
 * Returns an in-memory mock with sensible defaults.
 * Each call creates fresh vi.fn() mocks.
 *
 * @param options - Customize mock behavior
 * @returns Fresh KnowledgeStore mock
 */
export function createMockKnowledgeStore(
  options: MockKnowledgeStoreOptions = {},
): Partial<KnowledgeStore> {
  return {
    recordStep: vi.fn().mockResolvedValue(undefined),
    getLastSteps: vi.fn().mockResolvedValue(options.lastSteps ?? []),
    searchSteps: vi.fn().mockResolvedValue(options.searchResults ?? []),
    summarizeSession: vi.fn().mockResolvedValue(
      options.sessionSummary ?? {
        sessionId: 'test-session-123',
        stepCount: 0,
        recipe: [],
      },
    ),
    listSessions: vi.fn().mockResolvedValue(options.sessions ?? []),
    generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    writeSessionMetadata: vi.fn().mockResolvedValue('test-session-123'),
    getGitInfoSync: vi.fn().mockReturnValue({
      branch: 'main',
      commit: 'abc123',
    }),
  };
}
