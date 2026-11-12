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
 * An element as read by `inspectCapturedElementInPage`.
 */
export type InPageElementInspection = {
  /** Lowercase tag name. */
  tagName: string;
  /** Every attribute, by name, in DOM order. */
  attributes: Record<string, string>;
  /** `readOnly` of an input or textarea, or `aria-readonly="true"`. */
  readOnly: boolean;
  /** Computed value of each requested property (`''` when unknown). */
  styles: Record<string, string>;
  /**
   * Computed opacity of the element times that of every ancestor (shadow
   * hosts included), rounded to 3 decimals: what the user sees, also when
   * an ancestor fades the element.
   */
  effectiveOpacity: number;
};

/**
 * Starts recording the element that the next Playwright locator call on the
 * page resolves to. Before it runs a locator call, Playwright dispatches
 * `eventType` (its bubbling, composed `__playwright_mark_target__` event) on
 * the resolved element. A capture listener on the document records the
 * first such element under `key` in this world's global object, then
 * removes itself. `inspectCapturedElementInPage` reads the record.
 *
 * Runs in the page: must stay self-contained.
 *
 * @param eventType - The event Playwright dispatches on the target.
 * @param key - Where to keep the record in this world's global object.
 */
export function captureMarkedElementInPage(
  eventType: string,
  key: string,
): void {
  const capture: { element: unknown; stop: () => void } = {
    element: null,
    stop: () => undefined,
  };
  const listener = (event: Event): void => {
    capture.stop();
    // The first entry is the element itself, also inside an open shadow
    // root, where `target` is retargeted to the host.
    capture.element = event.composedPath()[0] ?? event.target;
  };
  capture.stop = (): void =>
    document.removeEventListener(eventType, listener, true);
  (globalThis as unknown as Record<string, unknown>)[key] = capture;
  document.addEventListener(eventType, listener, true);
}

/**
 * Reads the element recorded under `key` by `captureMarkedElementInPage`,
 * then drops the record and stops its listener, so each record is read
 * once.
 *
 * Style names are read with `getPropertyValue`: camelCase names
 * (`backgroundColor`) are read as their CSS property (`background-color`),
 * custom properties (`--x`) as given. Results keep the requested names.
 *
 * Runs in the page: must stay self-contained.
 *
 * @param key - The key given to `captureMarkedElementInPage`.
 * @param styleNames - The computed style properties to read.
 * @returns The inspection, or null when no element was recorded.
 */
export function inspectCapturedElementInPage(
  key: string,
  styleNames: string[],
): InPageElementInspection | null {
  const store = globalThis as unknown as Record<string, unknown>;
  const capture = store[key] as
    | { element: unknown; stop: () => void }
    | undefined;
  delete store[key];
  if (!capture) {
    return null;
  }
  capture.stop();
  const element = capture.element as Element | null;
  if (element?.nodeType !== 1) {
    return null;
  }

  const attributes: Record<string, string> = {};
  for (const { name, value } of Array.from(element.attributes)) {
    attributes[name] = value;
  }

  const computed = window.getComputedStyle(element);
  const styles: Record<string, string> = {};
  for (const name of styleNames) {
    const property = name.startsWith('--')
      ? name
      : name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    styles[name] = computed.getPropertyValue(property);
  }

  let effectiveOpacity = 1;
  for (let current: Element | null = element; current; ) {
    const opacity = parseFloat(window.getComputedStyle(current).opacity);
    if (!Number.isNaN(opacity)) {
      effectiveOpacity *= opacity;
    }
    const parent: Node | null = current.parentNode;
    current =
      current.parentElement ??
      (parent?.nodeType === 11 ? (parent as ShadowRoot).host : null);
  }

  return {
    tagName: element.localName,
    attributes,
    readOnly:
      (element as HTMLInputElement).readOnly ||
      element.getAttribute('aria-readonly') === 'true',
    styles,
    effectiveOpacity: Math.round(effectiveOpacity * 1000) / 1000,
  };
}

/**
 * Reports whether the page's animations have settled.
 *
 * Only animations that will end are counted: an animation keeps the page
 * unsettled when it is running, it is finite (its computed `iterations` and
 * `endTime` are not `Infinity`), and its effect targets an element.
 * Animations without an effect or without an element target are ignored.
 * Infinite animations (spinners, the fox, skeleton shimmer) never settle, so
 * they are ignored too. The target's position and size are not checked: an
 * element that slides in from outside the viewport (drawer, bottom sheet) or
 * grows from zero size (accordion) is still moving even while it is not
 * visible yet. A finite animation that is still in a long `delay` phase
 * reports `running`, so it counts as running until it ends or the wait
 * reaches its cap.
 *
 * Runs in the page: must stay self-contained.
 *
 * @returns True when no running, finite animation of an element remains.
 */
export function animationsSettled(): boolean {
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
    // An element target (it has a layout box API). Other targets are ignored.
    if (target && typeof target.getBoundingClientRect === 'function') {
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

/**
 * Result of `stampRefInPage`.
 *
 * - `stamped`: the token was added.
 * - `unreachable`: the element is inside a closed shadow root, which no
 * Playwright selector can search; nothing was written.
 * - `detached`: not an element of the document (detached, in a fragment, or
 * not an element); nothing was written.
 */
export type InPageStampResult = 'stamped' | 'unreachable' | 'detached';

/**
 * Adds `token` to the whitespace-separated token list in `attribute` of the
 * element the function is called on (`this`, via `Runtime.callFunctionOn`
 * on the resolved node), so that `[attribute~="token"]` matches exactly
 * this element. The tokens of earlier snapshots stay, newest last, up to
 * `keep` tokens: a later snapshot (an observation, or a request that timed
 * out and kept running) does not make the refs of an earlier one stale.
 *
 * Playwright's CSS engine searches open shadow roots, so elements inside
 * them are stamped too. Elements inside a closed shadow root, at any depth,
 * are not.
 *
 * Runs in the page: must stay self-contained. It is meant for an isolated
 * world (`callOnNodeInIsolatedWorld`), and reads no page global other than
 * `document`, so it also works where a main world scuttles globals
 * (LavaMoat).
 *
 * @param attribute - The attribute holding the tokens.
 * @param token - The token of this ref (no whitespace).
 * @param keep - Maximum number of tokens kept on the element.
 * @returns The result (see `InPageStampResult`).
 */
export function stampRefInPage(
  this: Element,
  attribute: string,
  token: string,
  keep: number,
): InPageStampResult {
  if (!this || this.nodeType !== 1) {
    return 'detached';
  }
  let root: Node = this.getRootNode();
  while (root.nodeType === 11) {
    const shadowRoot = root as ShadowRoot;
    if (!shadowRoot.host) {
      return 'detached';
    }
    if (shadowRoot.mode !== 'open') {
      return 'unreachable';
    }
    root = shadowRoot.host.getRootNode();
  }
  if (root !== document) {
    return 'detached';
  }
  const tokens = (this.getAttribute(attribute) ?? '')
    .split(' ')
    .filter((existing) => existing !== '' && existing !== token);
  tokens.push(token);
  this.setAttribute(attribute, tokens.slice(-keep).join(' '));
  return 'stamped';
}
