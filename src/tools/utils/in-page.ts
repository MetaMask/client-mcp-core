/* istanbul ignore file -- @preserve */
/**
 * Functions that run inside the browser page (see `callInIsolatedWorld` in
 * `cdp.ts`). They are sent to the page as source text (`fn.toString()`), so
 * each one must be self-contained: no imports, no references to module
 * scope, and only page globals (`window`, `document`). Helpers are defined
 * inside the function body. Values come in as arguments and go back as
 * JSON-serializable return values.
 *
 * The file is not instrumented for coverage: coverage counters would be
 * part of `fn.toString()` and break the functions in the page. The tests
 * run them from their source text in a separate `vm` context.
 */

/**
 * A `[data-testid]` element as read in the page. `text` is `null` when the
 * element has no `textContent`.
 */
export type InPageTestIdItem = {
  testId: string;
  text: string | null;
  visible: boolean;
};

/**
 * Reports whether the page's animations have settled.
 *
 * Only animations that can end soon and that the user can see are counted:
 * an animation keeps the page unsettled when it is running, it is finite
 * (its computed `iterations` and `endTime` are not `Infinity`), and its
 * effect targets an element whose bounding box has a non-zero size and
 * intersects the viewport. Animations without an effect or without an
 * element target are ignored. Infinite animations (spinners, the fox,
 * skeleton shimmer) never settle, so they are ignored too. A finite
 * animation that is still in a long `delay` phase reports `running`, so it
 * counts as running until it ends or the wait reaches its cap.
 *
 * Runs in the page: must stay self-contained.
 *
 * @returns True when no running, finite, in-viewport animation remains.
 */
export function animationsSettled(): boolean {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  for (const animation of document.getAnimations()) {
    if (animation.playState !== 'running') {
      continue;
    }
    const { effect } = animation;
    if (!effect) {
      continue;
    }
    const timing = effect.getComputedTiming();
    if (timing.iterations === Infinity || timing.endTime === Infinity) {
      continue;
    }
    const target = (effect as Partial<KeyframeEffect>).target ?? null;
    if (!target || typeof target.getBoundingClientRect !== 'function') {
      continue;
    }
    const rect = target.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    const inViewport =
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
    if (hasSize && inViewport) {
      return false;
    }
  }
  return true;
}

/**
 * Polls `predicate` once per animation frame (first check in the next
 * frame) until it returns true or `timeoutMs` passes. A predicate that
 * throws ends the wait, like a settled page. When the document is hidden
 * (Chromium does not run animation frames for hidden pages), each check is
 * scheduled with a 16 ms `setTimeout` instead.
 *
 * Runs in the page: must stay self-contained. The predicate is passed in by
 * composing source text (see `waitForAnimationsToSettle`).
 *
 * @param predicate - The check to poll.
 * @param timeoutMs - Maximum time to wait.
 * @returns True when the predicate passed (or threw), false on timeout.
 */
export async function waitUntilInPage(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const schedule = (callback: () => void): void => {
      if (document.hidden) {
        setTimeout(callback, 16);
      } else {
        requestAnimationFrame(callback);
      }
    };
    const check = (): void => {
      if (done) {
        return;
      }
      let passed: boolean;
      try {
        passed = predicate();
      } catch {
        passed = true;
      }
      if (passed) {
        clearTimeout(timer);
        finish(true);
        return;
      }
      schedule(check);
    };
    schedule(check);
  });
}

/**
 * Collects `[data-testid]` elements in one pass, with the same results as
 * the former per-element Playwright calls (`page.locator('[data-testid]')`
 * then `getAttribute`, `isVisible` and `textContent` on each).
 *
 * Order: like Playwright's CSS engine, the document's matches in DOM order
 * first, then the matches inside each open shadow root (hosts in DOM order,
 * nested roots depth-first). Elements with an empty or missing testId are
 * skipped and do not count towards `limit`.
 *
 * Text: `textContent`, trimmed, cut to `maxTextLength` characters; `null`
 * when the element has no `textContent`.
 *
 * Visibility follows Playwright's `isVisible()` (injected `computeBox`):
 * - `display: contents`: visible when a child element is visible or a child
 * text node has a non-empty box.
 * - otherwise hidden when `element.checkVisibility()` (no options, as
 * Playwright calls it in Chromium) is false, e.g. under `display: none` or
 * `content-visibility: hidden`; hidden when the computed `visibility` is
 * not `visible` (`hidden`, `collapse`); else visible when the bounding box
 * has a non-zero width and height.
 * - `opacity: 0` does not hide an element; neither does being outside the
 * viewport or covered by another element.
 * An element whose visibility cannot be computed is reported not visible.
 *
 * Runs in the page: must stay self-contained.
 *
 * @param limit - Maximum number of items to return.
 * @param maxTextLength - Maximum length of each text preview.
 * @returns The items, in the order described above.
 */
export function collectTestIdsInPage(
  limit: number,
  maxTextLength: number,
): InPageTestIdItem[] {
  const results: InPageTestIdItem[] = [];

  const hasBox = (rect: DOMRect): boolean => rect.width > 0 && rect.height > 0;

  const isVisible = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    if (style.display === 'contents') {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isVisible(child as Element)) {
          return true;
        }
        if (child.nodeType === 3) {
          const range = document.createRange();
          // Playwright's isVisibleTextNode uses selectNodeContents.
          range.selectNodeContents(child);
          if (hasBox(range.getBoundingClientRect())) {
            return true;
          }
        }
      }
      return false;
    }
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility()) {
        return false;
      }
    } else {
      // Playwright's fallback when checkVisibility() is missing.
      const details = element.closest('details,summary');
      if (
        details !== element &&
        details?.nodeName === 'DETAILS' &&
        !(details as HTMLDetailsElement).open
      ) {
        return false;
      }
    }
    if (style.visibility !== 'visible') {
      return false;
    }
    return hasBox(element.getBoundingClientRect());
  };

  // Returns true once `limit` items are collected.
  const visit = (root: ParentNode): boolean => {
    for (const element of Array.from(root.querySelectorAll('[data-testid]'))) {
      if (results.length >= limit) {
        return true;
      }
      const testId = element.getAttribute('data-testid');
      if (!testId) {
        continue;
      }
      let visible: boolean;
      try {
        visible = isVisible(element);
      } catch {
        visible = false;
      }
      const text = element.textContent;
      results.push({
        testId,
        text: text === null ? null : text.trim().substring(0, maxTextLength),
        visible,
      });
    }
    // Second scan, for shadow hosts: Playwright's CSS engine returns a
    // root's own matches first, then the matches of each open shadow root
    // (hosts in DOM order, nested roots depth-first). Keep that order.
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (results.length >= limit) {
        return true;
      }
      if (host.shadowRoot && visit(host.shadowRoot)) {
        return true;
      }
    }
    return results.length >= limit;
  };

  visit(document);
  return results;
}
