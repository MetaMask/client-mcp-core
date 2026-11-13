import type { TargetType, WithinScope } from './discovery.js';

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
  return type === 'testId' ? `[data-testid="${value}"]` : value;
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
