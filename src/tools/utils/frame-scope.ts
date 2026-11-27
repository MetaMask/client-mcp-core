import type { Page } from '@playwright/test';

import { FRAME_ATTACH_TIMEOUT_MS, MAX_SNAPSHOT_FRAMES } from './constants.js';
import type { TargetType, WithinScope } from './discovery.js';
import type { WithinTarget } from '../types';

/**
 * Builds the selector of a `data-testid`.
 *
 * @param testId - The test ID.
 * @returns The selector (`[data-testid="<testId>"]`).
 */
export function testIdSelector(testId: string): string {
  return `[data-testid="${testId}"]`;
}

/**
 * Converts a WithinTarget input to the WithinScope format expected by the platform driver.
 *
 * @param within - The optional within target from tool input.
 * @returns The resolved scope, or undefined if no within target is provided.
 */
export function resolveWithinScope(
  within: WithinTarget | undefined,
): WithinScope | undefined {
  if (!within) {
    return undefined;
  }
  if (within.a11yRef) {
    return { type: 'a11yRef', value: within.a11yRef };
  }
  if (within.testId) {
    return { type: 'testId', value: within.testId };
  }
  if (within.selector) {
    return { type: 'selector', value: within.selector };
  }
  return undefined;
}

/**
 * Picks the ref prefix of a snapshot of one iframe, so that its refs can be
 * added to the current ones: the next frame number after those already
 * used, and above `f1` to `f<MAX_SNAPSHOT_FRAMES>`, which page snapshots
 * use. A later page snapshot then never gives one of its iframes the same
 * prefix (`f6` when the refs hold `f1e*` and `f2e*`, `f7` after `f6e*`).
 *
 * @param refMap - The current refs.
 * @returns The prefix (`f6`, `f7`, ...).
 */
export function nextFrameRefPrefix(refMap: Map<string, string>): string {
  let last = 0;
  for (const ref of refMap.keys()) {
    const match = /^f([0-9]+)e/u.exec(ref);
    if (match) {
      last = Math.max(last, Number(match[1]));
    }
  }
  return `f${Math.max(last, MAX_SNAPSHOT_FRAMES) + 1}`;
}

/**
 * Playwright selector step that continues the selector inside the content
 * document of the iframe matched so far. `frameLocator(iframe).locator(x)`
 * builds `<iframe> >> internal:control=enter-frame >> <x>`. It works for
 * out-of-process (cross-origin) iframes too.
 */
export const ENTER_FRAME_SELECTOR = 'internal:control=enter-frame';

/**
 * Builds a selector for an element inside an iframe.
 *
 * @param frameSelector - Playwright selector of the iframe element.
 * @param selector - Playwright selector inside the frame's document.
 * @returns The chained selector.
 */
export function selectorInFrame(
  frameSelector: string,
  selector: string,
): string {
  return `${frameSelector} >> ${ENTER_FRAME_SELECTOR} >> ${selector}`;
}

/**
 * Builds the Playwright selector of a `testId` or `selector` target, the
 * way `resolveTarget` resolves it.
 *
 * @param type - The target type.
 * @param value - The test ID or selector.
 * @returns The selector.
 */
function testIdOrSelector(type: 'testId' | 'selector', value: string): string {
  return type === 'testId' ? testIdSelector(value) : value;
}

/**
 * Playwright selector step that picks the target itself when it is an
 * iframe, else the only iframe inside it. It is part of the frame selector
 * so that the tools' waits wait for an iframe that renders after a
 * navigation; several iframes fail in strict mode.
 */
const IFRAME_OR_SELF_SELECTOR = 'xpath=descendant-or-self::iframe';

/**
 * Builds the Playwright selector of an iframe from the target element.
 *
 * @param selector - The selector of the iframe or of its wrapper.
 * @returns The selector, followed by the iframe step.
 */
function iframeOrSelf(selector: string): string {
  return `${selector} >> ${IFRAME_OR_SELF_SELECTOR}`;
}

/**
 * Returns the selector before the iframe step, when it has one.
 *
 * `describe-screen` reads the frame through CDP, which takes a plain CSS
 * selector, not the Playwright chain that `resolveFrameSelector` builds.
 *
 * @param selector - A frame selector.
 * @returns The selector without the iframe step.
 */
export function frameSelectorBase(selector: string): string {
  const suffix = ` >> ${IFRAME_OR_SELF_SELECTOR}`;
  return selector.endsWith(suffix)
    ? selector.slice(0, -suffix.length)
    : selector;
}

/**
 * Whether a selector carries the iframe step of a frame scope.
 *
 * @param selector - A target or frame selector.
 * @returns True when `resolveFrameSelector` or `selectorInFrame` built it.
 */
export function isFrameSelector(selector: string): boolean {
  return selector.includes(` >> ${IFRAME_OR_SELF_SELECTOR}`);
}

/**
 * Resolves the iframe of a frame scope to a Playwright selector. A ref of
 * the iframe element (from a snapshot of its page) resolves through the
 * ref map. A test ID or selector resolves to the element itself when it is
 * an iframe, or to the only iframe inside it, as on the MetaMask Extension
 * chart. The iframe step is part of the selector, so the caller's wait
 * covers an iframe that renders after a navigation.
 *
 * @param frame - The iframe, as a ref, test ID or selector.
 * @param refMap - Map of a11y refs to selectors.
 * @returns The selector of the iframe element.
 */
export function resolveFrameSelector(
  frame: WithinScope,
  refMap: Map<string, string>,
): string {
  if (frame.type === 'a11yRef') {
    const selector = refMap.get(frame.value);
    if (!selector) {
      throw new Error(
        `Unknown a11yRef: ${frame.value}. ` +
          `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
      );
    }
    return selector;
  }

  return iframeOrSelf(testIdOrSelector(frame.type, frame.value));
}

/**
 * Resolves a frame scope to the plain CSS selector of its iframe, for
 * `describe-screen`, which reads the frame through CDP. A test ID or
 * selector that is a wrapper around one iframe is waited for, so an iframe
 * that renders late is found.
 *
 * @param frame - The iframe, as a ref, test ID or selector.
 * @param refMap - Map of a11y refs to selectors.
 * @param page - The Playwright page, to find the iframe inside a wrapper.
 * @returns The plain CSS selector of the iframe element.
 */
export async function resolveFrameElementSelector(
  frame: WithinScope,
  refMap: Map<string, string>,
  page: Page,
): Promise<string> {
  const selector = resolveFrameSelector(frame, refMap);
  const base = frameSelectorBase(selector);
  if (base === selector) {
    return selector;
  }

  const iframe = page.locator(selector);
  try {
    await iframe.first().waitFor({
      state: 'attached',
      timeout: FRAME_ATTACH_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Frame not found: no iframe matches ${base}`);
    }
    throw error;
  }
  const iframeCount = await iframe.count();
  if (iframeCount > 1) {
    throw new Error(
      `Frame not found: ${base} resolves to ${iframeCount} iframes; ` +
        `target one by its ref from describe-screen, or with a selector ` +
        `that matches one (for example selector:${base} iframe:nth-of-type(1))`,
    );
  }
  const target = page.locator(base).first();
  const isIframe = (await target.and(page.locator('iframe')).count()) > 0;
  return isIframe ? base : `${base} iframe`;
}

/**
 * Moves a target, and its `within` parent, into an iframe: a `testId` or
 * `selector` becomes a selector inside the frame's document. With
 * `within`, only the parent is moved; the target is then searched inside
 * the parent, which is already in the frame.
 *
 * Refs are not moved: a ref from a snapshot already points into its frame
 * (`f1e3`), so a frame scope with a ref target or a ref `within` is
 * rejected instead of guessing which document it means.
 *
 * @param target - The target.
 * @param target.targetType - The target type.
 * @param target.targetValue - The target value.
 * @param within - The optional parent scope.
 * @param frameSelector - Playwright selector of the iframe element.
 * @returns The target and parent scope inside the frame.
 */
export function scopeTargetToFrame(
  target: { targetType: TargetType; targetValue: string },
  within: WithinScope | undefined,
  frameSelector: string,
): {
  target: { targetType: TargetType; targetValue: string };
  within: WithinScope | undefined;
} {
  const { targetType, targetValue } = target;
  const withinType = within?.type;
  if (targetType === 'a11yRef' || withinType === 'a11yRef') {
    throw new Error(
      'frame cannot be used with a ref: refs from a snapshot already point into their frame. Drop frame, or target the element by testId or selector',
    );
  }
  if (within && withinType !== undefined) {
    return {
      target,
      within: {
        type: 'selector',
        value: selectorInFrame(
          frameSelector,
          testIdOrSelector(withinType, within.value),
        ),
      },
    };
  }
  return {
    target: {
      targetType: 'selector',
      targetValue: selectorInFrame(
        frameSelector,
        testIdOrSelector(targetType, targetValue),
      ),
    },
    within: undefined,
  };
}
