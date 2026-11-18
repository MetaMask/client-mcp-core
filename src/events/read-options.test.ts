import { describe, expect, it } from 'vitest';

import { parseSince, toRecordTarget } from './read-options.js';

describe('parseSince', () => {
  it('reads epoch ms, digit strings and ISO dates', () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince(42)).toBe(42);
    expect(parseSince('1700000000000')).toBe(1700000000000);
    expect(parseSince('2026-11-18T10:00:00.000Z')).toBe(
      Date.parse('2026-11-18T10:00:00.000Z'),
    );
    expect(parseSince('not a date')).toBeUndefined();
  });
});

describe('toRecordTarget', () => {
  it('renames targetId to id and redacts the URL', () => {
    expect(
      toRecordTarget({
        kind: 'page',
        targetId: 'T',
        url: 'https://a.example/?token=x',
      }),
    ).toStrictEqual({
      kind: 'page',
      id: 'T',
      url: 'https://a.example/?token=[REDACTED]',
    });
  });
});
