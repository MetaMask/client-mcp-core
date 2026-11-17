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
 * used (`f3` when the refs hold `f1e*` and `f2e*`).
 *
 * @param refMap - The current refs.
 * @returns The prefix (`f1`, `f2`, ...).
 */
export function nextFrameRefPrefix(refMap: Map<string, string>): string {
  let last = 0;
  for (const ref of refMap.keys()) {
    const match = /^f([0-9]+)e/u.exec(ref);
    if (match) {
      last = Math.max(last, Number(match[1]));
    }
  }
  return `f${last + 1}`;
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
 * Resolves the iframe of a frame scope to a Playwright selector. A ref of
 * the iframe element (from a snapshot of its page) resolves through the
 * ref map.
 *
 * @param frame - The iframe, as a ref, test ID or selector.
 * @param refMap - Map of a11y refs to selectors.
 * @returns The selector of the iframe element.
 */
export function resolveFrameSelector(
  frame: WithinScope,
  refMap: Map<string, string>,
): string {
  if (frame.type !== 'a11yRef') {
    return testIdOrSelector(frame.type, frame.value);
  }
  const selector = refMap.get(frame.value);
  if (!selector) {
    throw new Error(
      `Unknown a11yRef: ${frame.value}. ` +
        `Available refs: ${Array.from(refMap.keys()).join(', ')}`,
    );
  }
  return selector;
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
