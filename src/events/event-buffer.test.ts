import { describe, expect, it } from 'vitest';

import { DEFAULT_EVENT_CAPACITY, EventBuffer } from './event-buffer.js';
import type { EventRecordBase } from '../tools/types/events.js';

type TestRecord = EventRecordBase & { name: string; status?: number };

const TARGET = { kind: 'page' as const, id: 'T1', url: 'https://a.example/' };

/**
 * Appends a test record.
 *
 * @param buffer - The buffer.
 * @param kind - The record kind.
 * @param name - A label.
 * @param t - The record time.
 * @returns The stored record.
 */
function add(
  buffer: EventBuffer,
  kind: 'console' | 'network',
  name: string,
  t = 1000,
): TestRecord {
  return buffer.append<TestRecord>(kind, { t, target: TARGET, name });
}

describe('EventBuffer', () => {
  it('shares one seq across kinds, starting at 1', () => {
    const buffer = new EventBuffer();
    expect(buffer.seq).toBe(0);
    expect(add(buffer, 'console', 'a').seq).toBe(1);
    expect(add(buffer, 'network', 'b').seq).toBe(2);
    expect(add(buffer, 'console', 'c').seq).toBe(3);
    expect(buffer.summary()).toStrictEqual({
      startedAt: buffer.startedAt,
      seq: 3,
      counts: { console: 2, network: 1 },
      dropped: { console: 0, network: 0 },
      captureErrors: 0,
    });
  });

  it('uses the default capacities', () => {
    expect(DEFAULT_EVENT_CAPACITY).toStrictEqual({
      console: 1000,
      network: 2000,
    });
  });

  it('drops the oldest record of a full kind, counts it, and reports a gap', () => {
    const buffer = new EventBuffer({ capacity: { console: 2 } });
    add(buffer, 'console', 'c1'); // seq 1
    add(buffer, 'network', 'n1'); // seq 2
    add(buffer, 'console', 'c2'); // seq 3
    add(buffer, 'console', 'c3'); // seq 4, drops c1

    expect(buffer.summary().dropped).toStrictEqual({ console: 1, network: 0 });
    expect(buffer.summary().counts).toStrictEqual({ console: 2, network: 1 });

    const fromStart = buffer.read<TestRecord>({
      kind: 'console',
      cursor: 0,
      limit: 10,
    });
    expect(fromStart.gap).toBe(true);
    expect(fromStart.records.map((record) => record.name)).toStrictEqual([
      'c2',
      'c3',
    ]);

    // The dropped record is at or before the cursor: no gap.
    const afterDrop = buffer.read<TestRecord>({
      kind: 'console',
      cursor: 1,
      limit: 10,
    });
    expect(afterDrop.gap).toBe(false);

    // Other kinds are not affected.
    expect(
      buffer.read<TestRecord>({ kind: 'network', cursor: 0, limit: 10 }).gap,
    ).toBe(false);
  });

  it('reports a gap for a since read only when a dropped record is at or after since', () => {
    const buffer = new EventBuffer({ capacity: { network: 1 } });
    add(buffer, 'network', 'old', 100);
    add(buffer, 'network', 'new', 300);

    expect(
      buffer.read<TestRecord>({ kind: 'network', since: 200, limit: 10 }).gap,
    ).toBe(false);
    expect(
      buffer.read<TestRecord>({ kind: 'network', since: 100, limit: 10 }).gap,
    ).toBe(true);
  });

  it('pages with limit and cursor without duplicates or holes', () => {
    const buffer = new EventBuffer();
    for (let index = 1; index <= 7; index++) {
      add(buffer, index % 2 === 0 ? 'console' : 'network', `r${index}`);
    }
    // network: r1 r3 r5 r7 (seq 1 3 5 7)
    const names: string[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = buffer.read<TestRecord>({
        kind: 'network',
        cursor,
        limit: 2,
      });
      names.push(...page.records.map((record) => record.name));
      pages += 1;
      expect(page.cursor).toBeGreaterThanOrEqual(cursor);
      ({ cursor } = page);
      if (!page.hasMore) {
        break;
      }
    }
    expect(names).toStrictEqual(['r1', 'r3', 'r5', 'r7']);
    expect(pages).toBe(2);
    // The last page moves the cursor to the newest seq of any kind.
    expect(cursor).toBe(7);

    const first = buffer.read<TestRecord>({ kind: 'network', limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(3);
  });

  it('returns hasMore false when the page holds exactly the rest', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'a');
    add(buffer, 'console', 'b');
    const page = buffer.read<TestRecord>({ kind: 'console', limit: 2 });
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(2);
  });

  it('pages with since', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'early', 100);
    add(buffer, 'console', 'late1', 500);
    add(buffer, 'console', 'late2', 600);
    const page = buffer.read<TestRecord>({
      kind: 'console',
      since: 500,
      limit: 1,
    });
    expect(page.records.map((record) => record.name)).toStrictEqual(['late1']);
    expect(page.hasMore).toBe(true);
    const next = buffer.read<TestRecord>({
      kind: 'console',
      since: 500,
      cursor: page.cursor,
      limit: 1,
    });
    expect(next.records.map((record) => record.name)).toStrictEqual(['late2']);
    expect(next.hasMore).toBe(false);
  });

  it('applies the filter before the limit', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'skip');
    add(buffer, 'console', 'keep1');
    add(buffer, 'console', 'skip');
    add(buffer, 'console', 'keep2');
    const page = buffer.read<TestRecord>({
      kind: 'console',
      limit: 1,
      filter: (record) => record.name.startsWith('keep'),
    });
    expect(page.records.map((record) => record.name)).toStrictEqual(['keep1']);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(2);
  });

  it('does not return a record updated in place after it was read', () => {
    const buffer = new EventBuffer();
    const request = add(buffer, 'network', 'req');
    const page = buffer.read<TestRecord>({ kind: 'network', limit: 10 });
    expect(page.records[0]?.status).toBeUndefined();

    request.status = 200;
    const again = buffer.read<TestRecord>({
      kind: 'network',
      cursor: page.cursor,
      limit: 10,
    });
    expect(again.records).toStrictEqual([]);
    // The returned copy is not changed by the update.
    expect(page.records[0]?.status).toBeUndefined();
    expect(
      buffer.read<TestRecord>({ kind: 'network', limit: 10 }).records[0]
        ?.status,
    ).toBe(200);
  });

  it('reads from the oldest record and reports a gap for a cursor from an earlier session', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'a');
    add(buffer, 'console', 'b');
    const page = buffer.read<TestRecord>({
      kind: 'console',
      cursor: 50,
      limit: 10,
    });
    expect(page.records.map((record) => record.name)).toStrictEqual(['a', 'b']);
    expect(page.gap).toBe(true);
    expect(page.cursor).toBe(2);

    const firstPage = buffer.read<TestRecord>({
      kind: 'console',
      cursor: 50,
      limit: 1,
    });
    expect(firstPage.records.map((record) => record.name)).toStrictEqual(['a']);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.gap).toBe(true);
    expect(firstPage.cursor).toBe(1);
  });

  it('clamps a limit below one to one record', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'a');
    add(buffer, 'console', 'b');
    for (const limit of [0, -3, Number.NaN, 1.9]) {
      const page = buffer.read<TestRecord>({ kind: 'console', limit });
      expect(page.records).toHaveLength(1);
      expect(page.hasMore).toBe(true);
    }
  });

  it('clear keeps seq, so old cursors stay valid, and is not a gap', () => {
    const buffer = new EventBuffer();
    add(buffer, 'console', 'a');
    add(buffer, 'network', 'b');
    expect(buffer.clear('console')).toStrictEqual(['console']);
    expect(buffer.summary().counts).toStrictEqual({ console: 0, network: 1 });
    expect(add(buffer, 'console', 'c').seq).toBe(3);

    const page = buffer.read<TestRecord>({
      kind: 'console',
      cursor: 0,
      limit: 10,
    });
    expect(page.gap).toBe(false);
    expect(page.records.map((record) => record.name)).toStrictEqual(['c']);

    expect(buffer.clear()).toStrictEqual(['console', 'network']);
    expect(buffer.summary()).toMatchObject({
      seq: 3,
      counts: { console: 0, network: 0 },
    });
  });

  it('gives each new buffer a new startedAt', () => {
    const first = new EventBuffer({ now: 5000 });
    const second = new EventBuffer({ now: 5000 });
    expect(second.startedAt).toBeGreaterThan(first.startedAt);
    const third = new EventBuffer();
    expect(third.startedAt).toBeGreaterThan(second.startedAt);
  });

  it('counts capture errors in the summary without taking a seq', () => {
    const buffer = new EventBuffer();
    buffer.noteCaptureError('first');
    buffer.noteCaptureError('Runtime.enable on page x timed out after 5000ms');

    expect(buffer.seq).toBe(0);
    expect(buffer.summary()).toMatchObject({
      seq: 0,
      captureErrors: 2,
      lastCaptureError: 'Runtime.enable on page x timed out after 5000ms',
    });
  });
});
