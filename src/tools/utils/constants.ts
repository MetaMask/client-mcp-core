/**
 * Constants for HTTP daemon tool operations.
 * Centralized to ensure consistency and easy tuning.
 */

// ============================================================================
// Timeouts
// ============================================================================

/** Default timeout for user interactions (click, type, wait_for) - 15 seconds */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 15000;

/** Buffer added to a tool's own timeout to account for queue scheduling overhead */
export const QUEUE_OVERHEAD_BUFFER_MS = 5_000;

/** Buffer for timeout diagnostics collection after a tool times out */
export const DIAGNOSTICS_BUFFER_MS = 2_000;

/** Timeout for waiting for CSS/Web animations to settle after a mutation */
export const ANIMATION_SETTLE_TIMEOUT_MS = 3_000;

/** Maximum interval between idle-shutdown checks */
export const MAX_IDLE_CHECK_INTERVAL_MS = 60_000;

/** Timeout for graceful HTTP server close during daemon shutdown */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Timeout for best-effort cleanup request when stopping a daemon */
export const BEST_EFFORT_CLEANUP_TIMEOUT_MS = 5_000;

// ============================================================================
// Limits
// ============================================================================

/** Default limit for testId collection in discovery tools */
export const DEFAULT_TESTID_LIMIT = 150;

/** Limit for testIds collected during observation (lighter weight) */
export const OBSERVATION_TESTID_LIMIT = 50;

/** Maximum length for text content preview in discovery */
export const TEXT_PREVIEW_MAX_LENGTH = 100;

/** Minimum number of option nodes under a combobox/listbox to trigger collapsing */
export const OPTION_COLLAPSE_MIN_COUNT = 3;
