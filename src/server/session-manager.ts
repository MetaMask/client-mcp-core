/**
 * Generic Session Manager Interface for Browser Extension HTTP Servers.
 *
 * This module defines the interface that concrete session managers must implement.
 * The interface abstracts browser session management, page tracking, and extension state.
 *
 * Extension-specific implementations (e.g., MetaMaskSessionManager) should implement
 * this interface and be injected into the core tool handlers.
 */

import type { Page, BrowserContext } from '@playwright/test';

import type {
  EnvironmentMode,
  WorkflowContext,
} from '../capabilities/context.js';
import type {
  ExtensionState,
  BuildCapability,
  FixtureCapability,
  ChainCapability,
  ContractSeedingCapability,
  StateSnapshotCapability,
  ScreenshotResult,
} from '../capabilities/types.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { TabRole, SessionState, SessionMetadata } from '../tools/types';

/**
 * Represents a tracked browser page with its role and URL.
 */
export type TrackedPage = {
  role: TabRole;
  url: string;
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
    anvil?: number;
    fixtureServer?: number;
  };
  /** Smart contracts to deploy on launch */
  seedContracts?: string[];
  /** Platform to launch on (defaults to 'browser') */
  platform?: 'browser' | 'ios' | 'android';
  /** iOS simulator device UDID (required when platform is 'ios') */
  simulatorDeviceId?: string;
  /** Path to .app bundle (required when platform is 'ios') */
  appBundlePath?: string;
  /** Android device ID (required when platform is 'android') */
  androidDeviceId?: string;
  /**
   * Metro inspector proxy port for iOS Hermes CDP (default 8081 when omitted).
   *
   * Cross-repo contract: the consumer's launch() implementation is
   * responsible for forwarding this value to its IOSPlatformDriver
   * constructor (e.g., `new IOSPlatformDriver({ metroPort })`). The
   * driver exposes the value via getMetroPort(), which hermes_cdp
   * reads when its per-call metroPort input is omitted.
   *
   * Multi-worktree setup: each worktree's daemon owns its own Metro
   * instance on a distinct port to avoid cross-worktree collisions.
   */
  metroPort?: number;
  /** Uninstall and reinstall the app bundle. Destructive to app container. */
  reinstall?: boolean;
  /** Clear app data/container. Destructive to wallet state. */
  resetAppData?: boolean;
  /** Bypass fox_code compatibility guard. Use with caution. */
  allowFoxCodeMismatch?: boolean;
};

/**
 * Result of launching a new session.
 */
export type SessionLaunchResult = {
  sessionId: string;
  extensionId: string;
  state: ExtensionState;
};

/**
 * Screenshot options.
 */
export type SessionScreenshotOptions = {
  name: string;
  fullPage?: boolean;
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
   * Check if a launch operation is currently in progress.
   */
  isLaunchInProgress(): boolean;

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

  /**
   * Get the platform driver for the current session (if available).
   * Optional — will be set for iOS sessions or handled by the server.
   */
  getPlatformDriver?(): IPlatformDriver | undefined;

  /**
   * Set the platform driver for the current session.
   * Called by launch logic when platform is 'ios'.
   */
  setPlatformDriver?(driver: IPlatformDriver): void;

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
   * Set the workflow context created by the server's context factory.
   *
   * Called by `createServer` during startup so that the session manager has
   * access to the same capability objects that tools receive. Implementations
   * should store the context and expose its capabilities through the
   * individual capability getters.
   *
   * @param context - The workflow context produced by the configured `contextFactory`.
   */
  setWorkflowContext(context: WorkflowContext): void;

  /**
   * Get the current environment mode.
   *
   * @returns 'e2e' for testing environment, 'prod' for production-like environment
   */
  getEnvironmentMode(): EnvironmentMode;

  /**
   * Set the current context (e2e or prod).
   *
   * @param context The target context mode.
   * @param options Optional context-specific configuration passed through
   * by the consumer implementation.
   * @throws Error with code MM_CONTEXT_SWITCH_BLOCKED if session is active
   */
  setContext(context: 'e2e' | 'prod', options?: Record<string, unknown>): void;

  /**
   * Get current context information.
   */
  getContextInfo(): {
    currentContext: 'e2e' | 'prod';
    hasActiveSession: boolean;
    sessionId: string | null;
    capabilities: {
      available: string[];
    };
    canSwitchContext: boolean;
  };
};
