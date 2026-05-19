import type { Locator, Page } from '@playwright/test';

import type { WithinScope } from './discovery.js';
import type { InteractionDiagnostics } from '../types/tool-outputs.js';

/**
 * Builds a simple Playwright locator from a target type and value at page level.
 *
 * a11yRef targets cannot be reconstructed without a refMap, so they return
 * undefined.
 *
 * @param scope - The Playwright page or locator to search within.
 * @param targetType - The type of target identifier.
 * @param targetValue - The target value.
 * @returns A locator, or undefined if the target cannot be resolved.
 */
function buildLocator(
  scope: Page | Locator,
  targetType: string,
  targetValue: string,
): Locator | undefined {
  switch (targetType) {
    case 'testId':
      return scope.locator(`[data-testid="${targetValue}"]`);
    case 'selector':
      return scope.locator(targetValue);
    default:
      // a11yRef needs a refMap we don't have here — fall back to undefined
      return undefined;
  }
}

/**
 * Builds a Playwright locator from the target type and value, optionally
 * scoped within a parent element.
 *
 * This mirrors the resolution logic in discovery.ts but avoids importing
 * the full discovery module (which depends on a refMap) by handling only
 * testId and CSS-selector targets.  a11yRef targets cannot be reconstructed
 * without a refMap, so they return undefined.
 *
 * When a `within` scope is provided, the locator is chained through the
 * parent's `.first()` to match the same scoping strategy used by
 * `waitForTarget()` in discovery.ts.
 *
 * @param page - The Playwright page.
 * @param targetType - The type of target identifier.
 * @param targetValue - The target value.
 * @param within - Optional parent scope to restrict element search.
 * @returns A locator, or undefined if the target cannot be resolved.
 */
function reconstructLocator(
  page: Page,
  targetType: string,
  targetValue: string,
  within?: WithinScope,
): Locator | undefined {
  if (within) {
    const parentLocator = buildLocator(page, within.type, within.value);
    if (!parentLocator) {
      // Can't reconstruct parent (a11yRef) — fall back to page-level
      return buildLocator(page, targetType, targetValue);
    }
    return buildLocator(parentLocator.first(), targetType, targetValue);
  }
  return buildLocator(page, targetType, targetValue);
}

/**
 * Checks whether a bounding box is entirely outside the page viewport.
 *
 * @param page - The Playwright page.
 * @param box - The element's bounding box, or undefined/null if unavailable.
 * @returns True if the element is offscreen.
 */
function isOffscreen(
  page: Page,
  box:
    | { x: number; y: number; width: number; height: number }
    | null
    | undefined,
): boolean {
  if (box === undefined || box === null) {
    return false;
  }
  try {
    const viewport = page.viewportSize();
    if (!viewport) {
      return false;
    }
    return (
      box.x + box.width <= 0 ||
      box.y + box.height <= 0 ||
      box.x >= viewport.width ||
      box.y >= viewport.height
    );
  } catch {
    return false;
  }
}

/**
 * Collects post-timeout diagnostic information about a target element.
 *
 * When the provided locator is undefined (common on visibility-timeout paths),
 * the function attempts to reconstruct one from `targetType` and `targetValue`
 * so that element-level diagnostics (matchCount, visibility, etc.) are still
 * populated rather than returning a bare `{ suspectedCause: 'unknown' }`.
 *
 * All Playwright queries are wrapped in a 2-second hard cap via Promise.race.
 * Returns whatever was collected before the cap fires.
 *
 * @param page - The Playwright page.
 * @param locator - The locator for the target element, or undefined if unavailable.
 * @param targetType - The type of target identifier used (a11yRef, testId, selector).
 * @param targetValue - The target value used.
 * @param timeoutMs - The original timeout budget in ms.
 * @param elapsedMs - Time actually spent before timeout.
 * @param phase - Which phase timed out ('visibility-parent' | 'visibility-target' | 'action').
 * @param within - Optional parent scope used for the original interaction.
 * @returns Populated InteractionDiagnostics object.
 */
export async function collectInteractionDiagnostics(
  page: Page,
  locator: Locator | undefined,
  targetType: string,
  targetValue: string,
  timeoutMs: number,
  elapsedMs: number,
  phase: string,
  within?: WithinScope,
): Promise<InteractionDiagnostics> {
  // Per-call cap prevents any single Playwright query from blocking
  // diagnostics collection.  Abandoned promises (where the cap fires
  // before the Playwright call resolves) are tracked and awaited at
  // the end so no dangling work outlives this function — preserving
  // the request-queue serialization contract.
  const PER_CALL_CAP_MS = 500;
  const abandoned: Promise<unknown>[] = [];

  const base: InteractionDiagnostics = {
    phase,
    targetType,
    targetValue,
    timeoutMs,
    elapsedMs,
  };

  // Check page-closed first — avoids firing Playwright queries against
  // a closed page which would hang until their default timeout.
  try {
    if (page.isClosed()) {
      return { ...base, suspectedCause: 'page-closed' };
    }
  } catch {
    return { ...base, suspectedCause: 'page-closed' };
  }

  const effectiveLocator =
    locator ?? reconstructLocator(page, targetType, targetValue, within);

  if (!effectiveLocator) {
    return { ...base, suspectedCause: 'unknown' };
  }

  /**
   * Races a locator query against a timeout cap, returning `undefined` on timeout.
   *
   * @param fn - Async function to execute with the timeout cap.
   * @returns The result of `fn`, or `undefined` if the timeout fires first.
   */
  async function queryWithCap<TResult>(
    fn: () => Promise<TResult>,
  ): Promise<TResult | undefined> {
    const fnPromise = fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      fnPromise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PER_CALL_CAP_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (result === undefined) {
      abandoned.push(fnPromise.catch(() => undefined));
    }
    return result;
  }

  const collected: Partial<InteractionDiagnostics> = {};

  try {
    const count = await queryWithCap(async () => effectiveLocator.count());
    if (count !== undefined) {
      collected.matchCount = count;
      collected.elementFound = count > 0;
    }
  } catch {
    // non-fatal
  }

  if (collected.elementFound === false) {
    await Promise.allSettled(abandoned);
    return { ...base, ...collected, suspectedCause: 'element-not-found' };
  }

  if (collected.elementFound === undefined) {
    await Promise.allSettled(abandoned);
    return { ...base, ...collected, suspectedCause: 'unknown' };
  }

  try {
    const visible = await queryWithCap(async () =>
      effectiveLocator.first().isVisible(),
    );
    if (visible !== undefined) {
      collected.elementVisible = visible;
    }
  } catch {
    // non-fatal
  }

  try {
    const enabled = await queryWithCap(async () =>
      effectiveLocator.first().isEnabled(),
    );
    if (enabled !== undefined) {
      collected.elementEnabled = enabled;
    }
  } catch {
    // non-fatal
  }

  try {
    const box = await queryWithCap(async () =>
      effectiveLocator.first().boundingBox(),
    );
    // queryWithCap returns undefined on timeout; boundingBox returns null
    // when the element is not in the viewport — both are valid signals.
    if (box !== undefined) {
      collected.boundingBox = box;
    }
  } catch {
    // non-fatal
  }

  // Derive suspectedCause from collected facts
  const { elementFound, elementVisible, elementEnabled, boundingBox } =
    collected;

  if (elementFound && elementVisible && elementEnabled === false) {
    collected.suspectedCause = 'element-not-actionable';
  } else if (elementFound && elementVisible && elementEnabled) {
    if (isOffscreen(page, boundingBox)) {
      collected.suspectedCause = 'element-offscreen';
    }
  }

  await Promise.allSettled(abandoned);

  return {
    ...base,
    ...collected,
    suspectedCause: collected.suspectedCause ?? 'unknown',
  };
}
