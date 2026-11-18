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
 * hidden checkbox or radio with exactly one label.
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
    return wrappingLabel;
  }

  const id = await control.getAttribute('id', { timeout: timeoutMs });
  if (!id) {
    return undefined;
  }
  const forLabel = control.locator(
    `xpath=ancestor::*[last()]//label[@for=${toXPathStringLiteral(id)}]`,
  );
  return (await forLabel.count()) === 1 ? forLabel : undefined;
}
