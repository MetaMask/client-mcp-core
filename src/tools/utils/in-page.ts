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

/**
 * Builds a Playwright selector that matches exactly one element: the
 * element the function is called on (`this`, via `Runtime.callFunctionOn`
 * on the resolved node).
 *
 * Within a scope, tries in order a unique `data-testid`, a unique `id`, and
 * the shortest unique path from the element up to the top of its tree
 * (document or shadow root), anchored at the first ancestor with a unique
 * `data-testid` or `id` when that makes it unique (`#h > button`). The
 * path uses `:nth-of-type` where needed, then, when that is not unique,
 * `:nth-child` on every step. Uniqueness mirrors Playwright's CSS
 * engine: it searches the scope's light descendants and every open shadow
 * root inside them (nested roots too), the scope element itself never
 * matches, and the `>` combinator steps from the top element of a shadow
 * root to its host. A candidate counts as unique when exactly one element
 * matches it this way. Inside a shadow root, when the path up to the top
 * of the root is not unique, it is anchored to the host with `:scope >`.
 *
 * - Element in the document: the scope is the document, and the result is
 * raw CSS (`[data-testid="send"]`, `body > button:nth-of-type(2)`).
 * - Element in an open shadow root: the scope is the host, which needs a
 * unique selector of its own (same rules, recursively for nested shadow
 * roots), and the result chains them: `css=<host> >> css=<inside>`.
 * Playwright resolves the inner part within the host, its open shadow root
 * included.
 * - Element in a closed shadow root, at any depth: Playwright cannot search
 * it, so no selector can reach it, and any other selector (role, text)
 * would only match other elements. Returns the marker
 * `mm-unreachable=closed-shadow-root` (`UNREACHABLE_REF_SELECTOR` in
 * `discovery.ts`), which makes an action on the ref fail at once.
 * - Detached, or in another document: null.
 *
 * Runs in the page: must stay self-contained. It is meant for an isolated
 * world (`callOnNodeInIsolatedWorld`), and reads no page global other than
 * `document` (no `CSS`, `window`, `Element`, `Array.from`), so it also
 * works where a main world scuttles globals (LavaMoat).
 *
 * @returns The selector, the closed-shadow-root marker, or null when no
 * unique selector can be built.
 */
export function buildUniqueSelectorInPage(this: Element): string | null {
  // Copies a NodeList or HTMLCollection without the page's `Array.from`.
  const toArray = <TItem>(list: ArrayLike<TItem>): TItem[] => {
    const items: TItem[] = [];
    let index = 0;
    while (index < list.length) {
      items.push(list[index]);
      index += 1;
    }
    return items;
  };

  // CSSOM "serialize an identifier" (what `CSS.escape` returns), inline:
  // the page's `CSS` global may be scuttled (LavaMoat) and must not be read.
  const escapeCss = (value: string): string => {
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      const char = value.charAt(index);
      if (code === 0) {
        result += '\uFFFD';
      } else if (
        (code >= 0x1 && code <= 0x1f) ||
        code === 0x7f ||
        (index === 0 && code >= 0x30 && code <= 0x39) ||
        (index === 1 &&
          code >= 0x30 &&
          code <= 0x39 &&
          value.charCodeAt(0) === 0x2d)
      ) {
        result += `\\${code.toString(16)} `;
      } else if (index === 0 && value.length === 1 && code === 0x2d) {
        result += `\\${char}`;
      } else if (
        code >= 0x80 ||
        code === 0x2d ||
        code === 0x5f ||
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a)
      ) {
        result += char;
      } else {
        result += `\\${char}`;
      }
    }
    return result;
  };

  type Scope = Document | Element;

  const parentOrHost = (element: Element): Element | null => {
    if (element.parentElement) {
      return element.parentElement;
    }
    const parent = element.parentNode;
    return parent?.nodeType === 11
      ? ((parent as ShadowRoot).host ?? null)
      : null;
  };

  // The roots Playwright's CSS engine searches from a scope: the scope, the
  // scope's own open shadow root, and every open shadow root inside them.
  const searchRoots = (scope: Scope): ParentNode[] => {
    const roots: ParentNode[] = [];
    const add = (root: ParentNode): void => {
      roots.push(root);
      for (const element of toArray(root.querySelectorAll('*'))) {
        if (element.shadowRoot) {
          add(element.shadowRoot);
        }
      }
    };
    add(scope);
    const ownShadowRoot =
      scope.nodeType === 1 ? (scope as Element).shadowRoot : null;
    if (ownShadowRoot) {
      add(ownShadowRoot);
    }
    return roots;
  };

  // Whether exactly one element of the scope matches the compounds joined
  // with `>`.
  const isUnique = (
    scope: Scope,
    roots: ParentNode[],
    compounds: string[],
  ): boolean => {
    const last = compounds.length - 1;
    let count = 0;
    for (const root of roots) {
      for (const candidate of toArray(root.querySelectorAll(compounds[last]))) {
        let current: Element | null = candidate;
        let matches = candidate !== scope;
        for (let index = last - 1; matches && index >= 0; index -= 1) {
          current = parentOrHost(current as Element);
          // `:scope` matches only the scope element (Playwright's scope
          // engine); other compounds never match it.
          matches =
            current !== null &&
            (compounds[index] === ':scope'
              ? current === scope
              : current !== scope && current.matches(compounds[index]));
        }
        if (matches) {
          count += 1;
          if (count > 1) {
            return false;
          }
        }
      }
    }
    return count === 1;
  };

  const selectorInScope = (element: Element, scope: Scope): string | null => {
    const roots = searchRoots(scope);
    const unique = (compounds: string[]): boolean => {
      try {
        return isUnique(scope, roots, compounds);
      } catch {
        // Invalid selector (unexpected): not usable.
        return false;
      }
    };

    // A unique `[data-testid="..."]`, else a unique `#id`, for an element.
    const anchorOf = (target: Element): string | null => {
      const testId = target.getAttribute('data-testid');
      if (testId) {
        const candidate = `[data-testid="${escapeCss(testId)}"]`;
        if (unique([candidate])) {
          return candidate;
        }
      }
      if (target.id) {
        const candidate = `#${escapeCss(target.id)}`;
        if (unique([candidate])) {
          return candidate;
        }
      }
      return null;
    };

    // Path from the element up to the top element of the tree
    // (parentElement is null at the top of a shadow root), returned as soon
    // as it is unique. Each step first tries to anchor the path at the
    // ancestor's unique testid or id (`#h > button`). Siblings come from
    // parentNode, so the top elements of a shadow root get positions too.
    // `byChild` uses `:nth-child` on every step instead of `:nth-of-type`
    // only when needed: it tells apart elements that `:nth-of-type` does
    // not, such as a slotted light child and a shadow child of one host
    // (both are children of the host for the `>` combinator).
    const walk = (byChild: boolean): string | null => {
      const compounds: string[] = [];
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        if (current !== element) {
          const anchor = anchorOf(current);
          if (anchor && unique([anchor, ...compounds])) {
            return [anchor, ...compounds].join(' > ');
          }
        }
        const { localName } = current;
        if (!localName) {
          return null;
        }
        const parent = current.parentNode;
        const siblings = parent ? toArray(parent.children) : [];
        const sameType = siblings.filter(
          (sibling) => sibling.localName === localName,
        );
        if (byChild) {
          compounds.unshift(
            `${localName}:nth-child(${siblings.indexOf(current) + 1})`,
          );
        } else {
          compounds.unshift(
            sameType.length > 1
              ? `${localName}:nth-of-type(${sameType.indexOf(current) + 1})`
              : localName,
          );
        }
        if (unique(compounds)) {
          return compounds.join(' > ');
        }
      }
      // Inside a shadow root, anchor the path to the host: `:scope > ...`
      // steps from the top element of the shadow root to the host.
      if (scope.nodeType === 1) {
        compounds.unshift(':scope');
        if (unique(compounds)) {
          return compounds.join(' > ');
        }
      }
      return null;
    };

    return anchorOf(element) ?? walk(false) ?? walk(true);
  };

  // Set when the element is inside a closed shadow root.
  let unreachable = false;

  // Selector parts from the document down to the element, one per tree
  // (document, then each open shadow root), or null.
  const selectorParts = (element: Element): string[] | null => {
    const root = element.getRootNode();
    if (root === document) {
      const selector = selectorInScope(element, document);
      return selector === null ? null : [selector];
    }
    if (root.nodeType !== 11 || !(root as ShadowRoot).host) {
      return null;
    }
    if ((root as ShadowRoot).mode !== 'open') {
      unreachable = true;
      return null;
    }
    const { host } = root as ShadowRoot;
    const hostParts = selectorParts(host);
    if (hostParts === null) {
      return null;
    }
    const selector = selectorInScope(element, host);
    return selector === null ? null : [...hostParts, selector];
  };

  if (!this || this.nodeType !== 1) {
    return null;
  }
  const parts = selectorParts(this);
  if (unreachable) {
    // Must equal UNREACHABLE_REF_SELECTOR in discovery.ts.
    return 'mm-unreachable=closed-shadow-root';
  }
  if (parts === null) {
    return null;
  }
  return parts.length === 1
    ? parts[0]
    : parts.map((part) => `css=${part}`).join(' >> ');
}
