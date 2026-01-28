/**
 * Constants for MCP server tool operations.
 * Centralized to ensure consistency and easy tuning.
 */

// ============================================================================
// Timeouts
// ============================================================================

/** Default timeout for user interactions (click, type, wait_for) - 15 seconds */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 15000;

// ============================================================================
// Limits
// ============================================================================

/** Default limit for testId collection in discovery tools */
export const DEFAULT_TESTID_LIMIT = 150;

/** Limit for testIds collected during observation (lighter weight) */
export const OBSERVATION_TESTID_LIMIT = 50;

/** Maximum length for text content preview in discovery */
export const TEXT_PREVIEW_MAX_LENGTH = 100;
