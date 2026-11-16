import { describe, expect, it } from 'vitest';

import {
  buildTextFingerprint,
  describeTextFingerprint,
  MAX_FINGERPRINT_TEXT_LENGTH,
} from './ref-fingerprint.js';

/**
 * Tests a fingerprint the way Playwright's `internal:has-text` does: the
 * `/source/flags` form compiled with `new RegExp`.
 *
 * @param fingerprint - The fingerprint.
 * @param text - The element's text now.
 * @returns Whether the text still matches.
 */
function matches(fingerprint: string | undefined, text: string): boolean {
  if (fingerprint === undefined) {
    throw new Error('no fingerprint');
  }
  const lastSlash = fingerprint.lastIndexOf('/');
  return new RegExp(
    fingerprint.slice(1, lastSlash),
    fingerprint.slice(lastSlash + 1),
  ).test(text);
}

describe('buildTextFingerprint', () => {
  it.each([
    ['Earn $2.42 +3.92%', 'Earn $2.43 -0.10%'],
    ['ETH 1.5 $3,201.22', 'ETH 1.49 $3,188.04'],
    ['Resend in 00:59', 'Resend in 00:58'],
    ['Fee 0.0012 ETH', 'Fee 0.0013 ETH'],
    ['Next', '  Next\n'],
    ['Swap  now', 'Swap\n now'],
  ])('keeps matching when a live value changes: %j → %j', (before, after) => {
    expect(matches(buildTextFingerprint(before), after)).toBe(true);
  });

  it.each([
    ['Next', 'Confirm'],
    ['Token A', 'Token C'],
    ['Account 1', 'Account 2'],
    ['Next', 'Next step'],
    ['$3,201.22', 'Confirm'],
  ])('rejects other content: %j → %j', (before, after) => {
    expect(matches(buildTextFingerprint(before), after)).toBe(false);
  });

  it('matches text with selector and regex syntax literally', () => {
    const text = 'He said "it\'s" a >> b C:\\x (1+1)? [y] {z} a/b | ^$.*';

    const fingerprint = buildTextFingerprint(text);

    expect(fingerprint).not.toMatch(/["'>]/u);
    expect(matches(fingerprint, text)).toBe(true);
    expect(matches(fingerprint, text.replace('a/b', 'a-b'))).toBe(false);
  });

  it('gives no fingerprint to empty or long text', () => {
    expect(buildTextFingerprint('')).toBeUndefined();
    expect(buildTextFingerprint(' \n ')).toBeUndefined();
    expect(
      buildTextFingerprint('a'.repeat(MAX_FINGERPRINT_TEXT_LENGTH + 1)),
    ).toBeUndefined();
    expect(
      buildTextFingerprint('a'.repeat(MAX_FINGERPRINT_TEXT_LENGTH)),
    ).toBeDefined();
  });
});

describe('describeTextFingerprint', () => {
  it.each([
    ['Next', 'Next'],
    ['Earn $2.42 +3.92%', 'Earn … …'],
    ['He said "hi" >> C:\\x', 'He said "hi" >> C:\\x'],
    ['Emoji 🚀 ok', 'Emoji 🚀 ok'],
  ])('turns the fingerprint of %j back into %j', (text, description) => {
    expect(describeTextFingerprint(buildTextFingerprint(text) as string)).toBe(
      description,
    );
  });
});
