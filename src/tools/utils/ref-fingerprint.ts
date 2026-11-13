/**
 * Text fingerprints of refs: a ref follows its DOM node, and React can reuse
 * a node for other content (a "Next" button that becomes "Confirm"), so a
 * ref also checks the text its element had at the snapshot.
 */

/**
 * Longest whitespace-normalized text that gets a fingerprint. Longer text
 * belongs to containers whose content changes for unrelated reasons; their
 * refs follow the node only.
 */
export const MAX_FINGERPRINT_TEXT_LENGTH = 100;

/**
 * A number-like value, with an optional sign, currency symbol and percent
 * sign (`+3.92%`, `$3,201.22`, `00:59`).
 */
const NUMBER_PATTERN = /[+\-−]?[$€£¥]?\d+(?:[.,:]\d+)*%?/gu;

/**
 * A number with one of these marks is a live value (price, balance, fee,
 * percent change, countdown) and is masked. A plain integer is kept: it
 * tells "Account 1" from "Account 2".
 */
const LIVE_MARKS = /[.,:%$€£¥]/u;

/** Regex source that matches a masked live value: any run without letters or spaces. */
const LIVE_VALUE_SOURCE = '[^\\sA-Za-z]*';

/** Regex source between two words. */
const SPACE_SOURCE = '\\s+';

/**
 * Escapes one character of the text for the fingerprint regex. Every ASCII
 * character other than letters and digits becomes `\xHH`: the regex sits
 * inside a Playwright selector, where quotes and `>` are selector syntax.
 *
 * @param char - One code point of the text.
 * @returns The regex source for it.
 */
function escapeChar(char: string): string {
  if (char === ' ') {
    return SPACE_SOURCE;
  }
  const code = char.codePointAt(0) ?? 0;
  if (code > 127 || /[A-Za-z0-9]/u.test(char)) {
    return char;
  }
  return `\\x${code.toString(16).padStart(2, '0')}`;
}

/**
 * Builds the fingerprint of an element's text: a regex, in Playwright's
 * `/source/` form for `internal:has-text`, that matches the whole text
 * with any whitespace and with live values masked. Playwright tests it
 * against the element's text nodes (`elementText().full`), the text
 * `stampRefInPage` returns.
 *
 * @param text - The element's text at the snapshot.
 * @returns The fingerprint, or undefined for an empty or long text (no check).
 */
export function buildTextFingerprint(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '' || normalized.length > MAX_FINGERPRINT_TEXT_LENGTH) {
    return undefined;
  }
  const escapeLiteral = (literal: string): string =>
    [...literal].map(escapeChar).join('');

  let source = '';
  let last = 0;
  for (const match of normalized.matchAll(NUMBER_PATTERN)) {
    if (!LIVE_MARKS.test(match[0])) {
      continue;
    }
    source +=
      escapeLiteral(normalized.slice(last, match.index)) + LIVE_VALUE_SOURCE;
    last = match.index + match[0].length;
  }
  source += escapeLiteral(normalized.slice(last));
  return `/^\\s*${source}\\s*$/`;
}

/**
 * Turns a fingerprint back into readable text for error messages, with `…`
 * for each masked value.
 *
 * @param fingerprint - A fingerprint from `buildTextFingerprint`.
 * @returns The text, for example `Earn … …`.
 */
export function describeTextFingerprint(fingerprint: string): string {
  return fingerprint
    .slice('/^\\s*'.length, -'\\s*$/'.length)
    .split(LIVE_VALUE_SOURCE)
    .join('…')
    .split(SPACE_SOURCE)
    .join(' ')
    .replace(/\\x([0-9a-f]{2})/gu, (_match, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}
