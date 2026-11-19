import type { Locator } from '@playwright/test';

/**
 * A checkbox or radio no larger than this (in CSS pixels) on either side is
 * treated as visually hidden, like the common screen-reader-only pattern
 * (`width: 1px; height: 1px; clip: rect(0 0 0 0)`).
 */
export const HIDDEN_CONTROL_MAX_SIZE_PX = 1;

const CHECKABLE_INPUT_XPATH =
  'xpath=self::input[@type="checkbox" or @type="radio"]';

/**
 * A click on the centre of a label with a link or button inside can hit that
 * element instead of toggling the input, so such labels are not clicked.
 */
const INTERACTIVE_DESCENDANT_XPATH =
  'xpath=.//*[self::a[@href] or self::button or self::select or self::textarea or @role="link" or @role="button"]';

/**
 * Quotes a value as an XPath 1.0 string literal.
 *
 * @param value The value to quote.
 * @returns The XPath string literal.
 */
export function toXPathStringLiteral(value: string): string {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  const parts = value.split('"').map((part) => `"${part}"`);
  return `concat(${parts.join(`, '"', `)})`;
}

/**
 * Finds the label to click in place of a visually hidden checkbox or radio.
 *
 * Toggle and checkbox components often keep the real input (and its test id)
 * at 1x1 pixel under decorative elements, so Playwright's click on it never
 * passes the hit-target check and waits out the whole timeout. Clicking the
 * input's label toggles it the way a user does.
 *
 * Only Playwright locator calls are used, so this works on pages where
 * LavaMoat restricts scripts in the main world.
 *
 * @param locator The resolved click target.
 * @param timeoutMs The timeout for reading the target's attributes.
 * @returns The label locator, or undefined when the target is not a visually
 * hidden checkbox or radio with exactly one label, or when that label has a
 * link, button or other interactive element inside.
 */
export async function findLabelForHiddenControl(
  locator: Locator,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (
    !box ||
    (box.width > HIDDEN_CONTROL_MAX_SIZE_PX &&
      box.height > HIDDEN_CONTROL_MAX_SIZE_PX)
  ) {
    return undefined;
  }

  const control = locator.locator(CHECKABLE_INPUT_XPATH);
  if ((await control.count()) !== 1) {
    return undefined;
  }

  const wrappingLabel = control.locator('xpath=ancestor::label[1]');
  if ((await wrappingLabel.count()) === 1) {
    return withoutInteractiveContent(wrappingLabel);
  }

  const id = await control.getAttribute('id', { timeout: timeoutMs });
  if (!id) {
    return undefined;
  }
  const forLabel = control.locator(
    `xpath=ancestor::*[last()]//label[@for=${toXPathStringLiteral(id)}]`,
  );
  if ((await forLabel.count()) !== 1) {
    return undefined;
  }
  return withoutInteractiveContent(forLabel);
}

/**
 * Returns the label unless it has an interactive element inside.
 *
 * @param label The label to check.
 * @returns The label, or undefined when it has interactive content.
 */
async function withoutInteractiveContent(
  label: Locator,
): Promise<Locator | undefined> {
  const interactive = label.locator(INTERACTIVE_DESCENDANT_XPATH);
  return (await interactive.count()) > 0 ? undefined : label;
}
