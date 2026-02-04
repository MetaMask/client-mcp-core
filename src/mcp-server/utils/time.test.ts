import { describe, it, expect, vi } from 'vitest';
import { generateFilesafeTimestamp, generateSessionId } from './time.js';

describe('generateFilesafeTimestamp', () => {
  it('returns timestamp in YYYYMMDD-HHMMSS-mmm format', () => {
    const timestamp = generateFilesafeTimestamp(
      new Date('2026-02-04T14:30:45.123Z'),
    );

    expect(timestamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });

  it('generates monotonically increasing timestamps', () => {
    const baseDate = new Date('2026-02-04T14:30:45.000Z');

    const timestamp1 = generateFilesafeTimestamp(baseDate);
    const timestamp2 = generateFilesafeTimestamp(baseDate);
    const timestamp3 = generateFilesafeTimestamp(baseDate);

    expect(timestamp1 < timestamp2).toBe(true);
    expect(timestamp2 < timestamp3).toBe(true);
  });

  it('increments milliseconds when called with same time', () => {
    const fixedDate = new Date('2026-02-04T14:30:45.100Z');

    const timestamp1 = generateFilesafeTimestamp(fixedDate);
    const timestamp2 = generateFilesafeTimestamp(fixedDate);

    const ms1 = parseInt(timestamp1.split('-')[2], 10);
    const ms2 = parseInt(timestamp2.split('-')[2], 10);
    expect(ms2).toBe(ms1 + 1);
  });

  it('formats date with leading zeros for single digit components', () => {
    const date = new Date('2026-01-05T09:05:03.007Z');

    const timestamp = generateFilesafeTimestamp(date);

    expect(timestamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
    const parts = timestamp.split('-');
    expect(parts[0]).toMatch(/^\d{8}$/);
    expect(parts[1]).toMatch(/^\d{6}$/);
    expect(parts[2]).toMatch(/^\d{3}$/);
  });

  it('handles leap year dates', () => {
    const leapDate = new Date('2024-02-29T12:00:00.000Z');

    const timestamp = generateFilesafeTimestamp(leapDate);

    expect(timestamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });

  it('handles end of month dates', () => {
    const endOfMonth = new Date('2026-01-31T23:59:59.999Z');

    const timestamp = generateFilesafeTimestamp(endOfMonth);

    expect(timestamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });

  it('uses provided date parameter instead of current time', () => {
    const customDate = new Date('2025-12-31T23:59:59.999Z');

    const timestamp = generateFilesafeTimestamp(customDate);

    expect(timestamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
});

describe('generateSessionId', () => {
  it('returns session ID with default prefix', () => {
    const sessionId = generateSessionId();

    expect(sessionId).toMatch(/^mm-[a-z0-9]+-[a-z0-9]{6}$/);
  });

  it('uses custom prefix when provided', () => {
    const sessionId = generateSessionId('custom');

    expect(sessionId).toMatch(/^custom-[a-z0-9]+-[a-z0-9]{6}$/);
  });

  it('generates unique session IDs', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const id3 = generateSessionId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it('includes timestamp component in base36', () => {
    const sessionId = generateSessionId();
    const parts = sessionId.split('-');

    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('mm');
    expect(parts[1]).toMatch(/^[a-z0-9]+$/);
    expect(parts[2]).toMatch(/^[a-z0-9]{6}$/);
  });

  it('generates random component with exactly 6 characters', () => {
    const sessionId = generateSessionId();
    const parts = sessionId.split('-');

    expect(parts[2].length).toBe(6);
  });

  it('works with empty string prefix', () => {
    const sessionId = generateSessionId('');

    expect(sessionId).toMatch(/^-[a-z0-9]+-[a-z0-9]{6}$/);
  });

  it('works with special character prefixes', () => {
    const sessionId = generateSessionId('test_123');

    expect(sessionId).toMatch(/^test_123-[a-z0-9]+-[a-z0-9]{6}$/);
  });
});
