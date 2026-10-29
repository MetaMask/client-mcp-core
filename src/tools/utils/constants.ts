/**
 * Constants for HTTP daemon tool operations.
 * Centralized to ensure consistency and easy tuning.
 */

// ============================================================================
// Timeouts
// ============================================================================

/** Default timeout for user interactions (click, type, wait_for) - 15 seconds */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 15000;

/** Maximum time the RequestQueue finally block waits for a hung task to settle */
export const QUEUE_SETTLE_TIMEOUT_MS = 5_000;

/** Upper bound for any queued task timeout (largest schema timeout + budget). */
export const MAX_QUEUE_TIMEOUT_MS = 600_000;

/**
 * Cap on the wait for animations to settle after a mutating browser call.
 * Only running, finite animations of elements are waited for (also off
 * screen or at zero size, e.g. a drawer sliding in); infinite ones (spinners,
 * the fox, skeleton shimmer) are ignored. A long finite animation anywhere on
 * the page (a slow off-screen carousel, a Web Animations API animation on a
 * hidden element) can add up to this cap to a mutating call.
 */
export const ANIMATION_SETTLE_TIMEOUT_MS = 1_000;

/**
 * Extra time the daemon gives the in-page animation wait before it stops
 * waiting itself (covers a page whose timers are throttled or frozen).
 */
export const ANIMATION_SETTLE_GRACE_MS = 250;

/**
 * Cap on the in-page testId collection call. After it, collection falls
 * back to per-element locator calls.
 */
export const TESTID_COLLECT_TIMEOUT_MS = 5_000;

/** Maximum interval between idle-shutdown checks */
export const MAX_IDLE_CHECK_INTERVAL_MS = 60_000;

/** Hard timeout for post-tool observation collection (testIds, a11y) */
export const OBSERVATION_TIMEOUT_MS = 8_000;

/**
 * Mobile observation settle: after a mutating or batch tool, when a snapshot
 * still shows the last screen the agent received or a busy element, wait
 * this long and take the snapshot again.
 */
export const MOBILE_SETTLE_MS = 300;

/**
 * Mobile observation settle: no wait starts that would end later than this
 * after the first snapshot (waits and snapshots both count).
 */
export const MOBILE_SETTLE_MAX_MS = 2_000;

/** Mobile observation settle: maximum number of extra snapshots. */
export const MOBILE_SETTLE_MAX_SNAPSHOTS = 3;

/**
 * Mobile observation settle: extra snapshots allowed because the screen
 * still equals the last screen the agent received (no busy element). Busy
 * screens are retried up to `MOBILE_SETTLE_MAX_SNAPSHOTS`.
 */
export const MOBILE_SETTLE_UNCHANGED_RETRIES = 1;

/**
 * Mobile observation settle: when the first snapshot took at least this long
 * (an Android `am instrument` capture can take seconds), the UI already had
 * that time to change, so an unchanged screen is not retried. A busy screen
 * still is.
 */
export const MOBILE_SETTLE_SLOW_CAPTURE_MS = 1_000;

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

// ============================================================================
// Mobile accessibility tree
// ============================================================================

/**
 * Types of progress indicators, matched as a suffix of the element type
 * (the mobile node `role`). Used by the screen settle to detect a busy
 * screen, and by the mobile tree filter to keep these elements:
 *
 * - Android (adb/Appium `class`): `android.widget.ProgressBar` and
 * subclasses whose class name ends in `ProgressBar`.
 * - iOS via Appium XCUITest: `XCUIElementTypeActivityIndicator` and
 * `XCUIElementTypeProgressIndicator`, reported without the
 * `XCUIElementType` prefix (`ActivityIndicator`, `ProgressIndicator`).
 * - iOS via idb `describe-all`: the element `type`, either the AX role
 * without `AX` (`ProgressIndicator`) or the UIKit class name
 * (`UIActivityIndicatorView`, used by React Native `ActivityIndicator`).
 */
export const MOBILE_BUSY_TYPE =
  /(?:ProgressBar|ActivityIndicator(?:View)?|ProgressIndicator)$/u;

/**
 * Minimum frame size (width and height, in snapshot units: iOS points,
 * Android pixels) of an unlabelled tap target kept in the mobile tree.
 */
export const MOBILE_TAP_TARGET_MIN_SIZE = 24;
