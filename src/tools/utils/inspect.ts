import type { Locator, Page } from '@playwright/test';

import { callInIsolatedWorld } from './cdp.js';
import {
  captureMarkedElementInPage,
  inspectCapturedElementInPage,
} from './in-page.js';
import type { InPageElementInspection } from './in-page.js';

/**
 * Event that Playwright dispatches on the element a locator call resolves
 * to, before it runs the call (`markTargetElements` in its injected
 * script). Not a public API: when it stops firing, `inspectLocator` fails
 * with a clear error instead of reading another element.
 */
export const PLAYWRIGHT_MARK_TARGET_EVENT = '__playwright_mark_target__';

/** Time allowed to drop a capture after a failure. */
const DROP_CAPTURE_TIMEOUT_MS = 1_000;

export type ElementInspection = InPageElementInspection & {
  /** Playwright's `isDisabled()`: native, fieldset or `aria-disabled`. */
  disabled: boolean;
};

let inspectionCounter = 0;

/**
 * Reads the attributes, read-only and disabled flags, and computed styles
 * of the element a locator resolves to.
 *
 * The element is read in the page's isolated world (see
 * `callInIsolatedWorld`), as the Extension's main world may not allow page
 * code. Playwright resolves the locator (refs, test IDs, selectors, `within`
 * scopes) in its own world, so the isolated world learns which element it
 * is from the event Playwright dispatches on it: a capture is started, then
 * `locator.isDisabled()` (a read with no side effects) makes Playwright
 * dispatch it, then the captured element is read.
 *
 * @param page - The page that owns the locator.
 * @param locator - The resolved target.
 * @param styles - Computed style properties to read.
 * @param timeoutMs - Budget for the whole inspection.
 * @returns The inspection.
 */
export async function inspectLocator(
  page: Page,
  locator: Locator,
  styles: string[],
  timeoutMs: number,
): Promise<ElementInspection> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) {
      throw new Error(
        `Timeout ${timeoutMs}ms exceeded while inspecting the element`,
      );
    }
    return ms;
  };

  inspectionCounter += 1;
  const key = `__mm_inspect_${inspectionCounter}`;
  const inspectSource = inspectCapturedElementInPage.toString();

  await callInIsolatedWorld<void>(
    page,
    captureMarkedElementInPage.toString(),
    [PLAYWRIGHT_MARK_TARGET_EVENT, key],
    remaining(),
  );

  let disabled: boolean;
  let inspection: InPageElementInspection | null;
  try {
    disabled = await locator.isDisabled({ timeout: remaining() });
    inspection = await callInIsolatedWorld<InPageElementInspection | null>(
      page,
      inspectSource,
      [key, styles],
      remaining(),
    );
  } catch (error) {
    // Reading the capture also drops it and stops its listener.
    await callInIsolatedWorld(
      page,
      inspectSource,
      [key, []],
      DROP_CAPTURE_TIMEOUT_MS,
    ).catch(() => undefined);
    throw error;
  }

  if (!inspection) {
    throw new Error(
      'Could not inspect the element: Playwright did not report the element it resolved ' +
        `("${PLAYWRIGHT_MARK_TARGET_EVENT}" event). This Playwright version may not support inspect.`,
    );
  }
  return { ...inspection, disabled };
}
