/**
 * Generic Session Manager Interface for Browser Extension MCP Servers.
 *
 * This module defines the interface that concrete session managers must implement.
 * The interface abstracts browser session management, page tracking, and extension state.
 *
 * Extension-specific implementations (e.g., MetaMaskSessionManager) should implement
 * this interface and be injected into the core tool handlers.
 */

import type { Page, BrowserContext } from '@playwright/test';

import type { TabRole, SessionState, SessionMetadata } from './types';
import type { EnvironmentMode } from '../capabilities/context.js';
import type {
  ExtensionState,
  BuildCapability,
  FixtureCapability,
  ChainCapability,
  ContractSeedingCapability,
  StateSnapshotCapability,
  ScreenshotResult,
} from '../capabilities/types.js';

/**
 * Represents a tracked browser page with its role and URL.
 */
export type TrackedPage = {
  /**
   *
   */
  role: TabRole;
  /**
   *
   */
  url: string;
  /**
   *
   */
  page: Page;
};

/**
 * Configuration for launching a new browser session.
 */
export type SessionLaunchInput = {
  /** State initialization mode */
  stateMode?: 'default' | 'onboarding' | 'custom';
  /** Name of a preset fixture to use when stateMode is 'custom' */
  fixturePreset?: string;
  /** Custom fixture data when stateMode is 'custom' */
  fixture?: Record<string, unknown>;
  /** Goal description for this session (used in knowledge store) */
  goal?: string;
  /** Flow tags for categorizing this session */
  flowTags?: string[];
  /** Free-form tags for ad-hoc filtering */
  tags?: string[];
  /** Path to extension directory */
  extensionPath?: string;
  /** Whether to auto-build extension if not found */
  autoBuild?: boolean;
  /** Slow down actions for debugging (ms) */
  slowMo?: number;
  /** Port configuration */
  ports?: {
    /**
     *
     */
    anvil?: number;
    /**
     *
     */
    fixtureServer?: number;
  };
  /** Smart contracts to deploy on launch */
  seedContracts?: string[];
};

/**
 * Result of launching a new session.
 */
export type SessionLaunchResult = {
  /**
   *
   */
  sessionId: string;
  /**
   *
   */
  extensionId: string;
  /**
   *
   */
  state: ExtensionState;
};

/**
 * Screenshot options.
 */
export type SessionScreenshotOptions = {
  /**
   *
   */
  name: string;
  /**
   *
   */
  fullPage?: boolean;
  /**
   *
   */
  selector?: string;
};

/**
 * Interface for session manager implementations.
 *
 * This interface defines the contract that extension-specific session managers
 * must fulfill. Tool handlers depend on this interface, allowing them to work
 * with any compliant session manager implementation.
 */
export type ISessionManager = {
  // -----------------------------------------------------------------------------
  // Session Lifecycle
  // -----------------------------------------------------------------------------

  /**
   * Check if there is an active session.
   */
  hasActiveSession(): boolean;

  /**
   * Get the current session ID, or undefined if no session.
   */
  getSessionId(): string | undefined;

  /**
   * Get the current session state.
   */
  getSessionState(): SessionState | undefined;

  /**
   * Get the current session metadata.
   */
  getSessionMetadata(): SessionMetadata | undefined;

  /**
   * Launch a new browser session.
   *
   * @throws If a session is already active
   */
  launch(input: SessionLaunchInput): Promise<SessionLaunchResult>;

  /**
   * Clean up the current session (browser, services, etc.).
   *
   * @returns true if cleanup was performed, false if no session was active
   */
  cleanup(): Promise<boolean>;

  // -----------------------------------------------------------------------------
  // Page Management
  // -----------------------------------------------------------------------------

  /**
   * Get the current active page.
   *
   * @throws If no active session
   */
  getPage(): Page;

  /**
   * Set the active page for subsequent interactions.
   */
  setActivePage(page: Page): void;

  /**
   * Get all tracked pages in the current session.
   */
  getTrackedPages(): TrackedPage[];

  /**
   * Classify a page's role based on its URL.
   */
  classifyPageRole(page: Page, extensionId?: string): TabRole;

  /**
   * Get the browser context.
   *
   * @throws If no active session
   */
  getContext(): BrowserContext;

  // -----------------------------------------------------------------------------
  // Extension State
  // -----------------------------------------------------------------------------

  /**
   * Get the current extension state.
   *
   * @throws If no active session
   */
  getExtensionState(): Promise<ExtensionState>;

  // -----------------------------------------------------------------------------
  // A11y Reference Map
  // -----------------------------------------------------------------------------

  /**
   * Set the accessibility reference map (e1 -> selector).
   */
  setRefMap(map: Map<string, string>): void;

  /**
   * Get the current accessibility reference map.
   */
  getRefMap(): Map<string, string>;

  /**
   * Clear the accessibility reference map.
   */
  clearRefMap(): void;

  /**
   * Resolve an a11y ref (e.g., "e5") to a selector.
   */
  resolveA11yRef(ref: string): string | undefined;

  // -----------------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------------

  /**
   * Navigate to the extension home page.
   */
  navigateToHome(): Promise<void>;

  /**
   * Navigate to the extension settings page.
   */
  navigateToSettings(): Promise<void>;

  /**
   * Navigate to an external URL (opens new tab).
   */
  navigateToUrl(url: string): Promise<Page>;

  /**
   * Navigate to the notification page.
   */
  navigateToNotification(): Promise<Page>;

  /**
   * Wait for a notification page to appear.
   */
  waitForNotificationPage(timeoutMs: number): Promise<Page>;

  // -----------------------------------------------------------------------------
  // Screenshots
  // -----------------------------------------------------------------------------

  /**
   * Take a screenshot of the current page.
   */
  screenshot(options: SessionScreenshotOptions): Promise<ScreenshotResult>;

  // -----------------------------------------------------------------------------
  // Capabilities (Optional - Extension-Specific)
  // -----------------------------------------------------------------------------

  /**
   * Get the build capability (if available).
   */
  getBuildCapability(): BuildCapability | undefined;

  /**
   * Get the fixture capability (if available).
   */
  getFixtureCapability(): FixtureCapability | undefined;

  /**
   * Get the chain capability (if available).
   */
  getChainCapability(): ChainCapability | undefined;

  /**
   * Get the contract seeding capability (if available).
   */
  getContractSeedingCapability(): ContractSeedingCapability | undefined;

  /**
   * Get the state snapshot capability (if available).
   */
  getStateSnapshotCapability(): StateSnapshotCapability | undefined;

  // -----------------------------------------------------------------------------
  // Environment Configuration
  // -----------------------------------------------------------------------------

  /**
   * Get the current environment mode.
   *
   * @returns 'e2e' for testing environment, 'prod' for production-like environment
   */
  getEnvironmentMode(): EnvironmentMode;

  /**
   * Set the current context (e2e or prod).
   *
   * @throws Error with code MM_CONTEXT_SWITCH_BLOCKED if session is active
   */
  setContext?(context: 'e2e' | 'prod'): void;

  /**
   * Get current context information.
   */
  getContextInfo?(): {
    /**
     *
     */
    currentContext: 'e2e' | 'prod';
    /**
     *
     */
    hasActiveSession: boolean;
    /**
     *
     */
    sessionId: string | null;
    /**
     *
     */
    capabilities: {
      /**
       *
       */
      available: string[];
    };
    /**
     *
     */
    canSwitchContext: boolean;
  };
};

/**
 * Session manager instance holder.
 *
 * In the core package, this is undefined by default.
 * Extension implementations should call setSessionManager() to inject
 * their concrete implementation.
 */
let _sessionManager: ISessionManager | undefined;

/**
 * Set the session manager instance.
 *
 * This should be called by extension-specific code during server initialization.
 *
 * @param manager The session manager implementation to inject
 */
export function setSessionManager(manager: ISessionManager): void {
  _sessionManager = manager;
}

/**
 * Get the session manager instance.
 *
 * @throws Error if no session manager has been set
 * @returns The session manager instance
 */
export function getSessionManager(): ISessionManager {
  if (!_sessionManager) {
    throw new Error(
      'Session manager not initialized. Call setSessionManager() first.',
    );
  }
  return _sessionManager;
}

/**
 * Check if a session manager has been set.
 *
 * @returns True if a session manager is set, false otherwise
 */
export function hasSessionManager(): boolean {
  return _sessionManager !== undefined;
}
