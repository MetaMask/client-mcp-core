import type {
  EventKind,
  EventPage,
  EventRecordBase,
  EventSummary,
} from '../tools/types/events.js';

/** Records kept per kind by default. */
export const DEFAULT_EVENT_CAPACITY: Readonly<Record<EventKind, number>> = {
  console: 1000,
  network: 2000,
};

export const EVENT_KINDS: readonly EventKind[] = ['console', 'network'];

/** Options for {@link EventBuffer.read}. */
export type EventReadOptions<RecordType> = {
  kind: EventKind;
  /** Only records with a `seq` above this (from `mark` or an earlier read). */
  cursor?: number;
  /** Only records with `t` at or after this, epoch ms. */
  since?: number;
  /** Maximum records to return. */
  limit: number;
  /** Only records this returns true for. */
  filter?: (record: RecordType) => boolean;
};

type KindState = {
  records: EventRecordBase[];
  capacity: number;
  dropped: number;
  /** `seq` of the newest dropped record, 0 when none. */
  lastDroppedSeq: number;
  /** Largest `t` of a dropped record, 0 when none. */
  lastDroppedT: number;
};

let lastStartedAt = 0;

/**
 * Returns a start time later than every earlier one, so two sessions never
 * share a `startedAt`, even when started in the same millisecond.
 *
 * @param now - The current time, epoch ms.
 * @returns The start time.
 */
function nextStartedAt(now: number): number {
  lastStartedAt = Math.max(now, lastStartedAt + 1);
  return lastStartedAt;
}

/**
 * The event buffer of one session: one bounded list per record kind, and
 * one `seq` shared by all kinds, so one cursor covers every kind.
 *
 * A record keeps the `seq` it got when it was appended, also when its
 * source updates it in place later (a network request that finishes), so a
 * read after a cursor never returns it again.
 */
export class EventBuffer {
  readonly startedAt: number;

  readonly #kinds: Record<EventKind, KindState>;

  #seq = 0;

  #captureErrors = 0;

  #lastCaptureError: string | undefined;

  /**
   * @param options - Buffer options.
   * @param options.capacity - Records kept per kind; the oldest record of a
   * full kind is dropped and counted.
   * @param options.now - The current time, epoch ms (for tests).
   */
  constructor(
    options: {
      capacity?: Partial<Record<EventKind, number>>;
      now?: number;
    } = {},
  ) {
    this.startedAt = nextStartedAt(options.now ?? Date.now());
    const state = (kind: EventKind): KindState => ({
      records: [],
      capacity: options.capacity?.[kind] ?? DEFAULT_EVENT_CAPACITY[kind],
      dropped: 0,
      lastDroppedSeq: 0,
      lastDroppedT: 0,
    });
    this.#kinds = { console: state('console'), network: state('network') };
  }

  /**
   * @returns The newest `seq` given out (0 before the first record).
   */
  get seq(): number {
    return this.#seq;
  }

  /**
   * Appends a record and gives it the next `seq`. The returned object is the
   * stored record: a source may update its fields in place later.
   *
   * @param kind - The record kind.
   * @param record - The record without its `seq`.
   * @returns The stored record.
   */
  append<RecordType extends EventRecordBase>(
    kind: EventKind,
    record: Omit<RecordType, 'seq'>,
  ): RecordType {
    this.#seq += 1;
    const stored = { seq: this.#seq, ...record } as RecordType;
    const state = this.#kinds[kind];
    state.records.push(stored);
    while (state.records.length > state.capacity) {
      const dropped = state.records.shift() as EventRecordBase;
      state.dropped += 1;
      state.lastDroppedSeq = dropped.seq;
      state.lastDroppedT = Math.max(state.lastDroppedT, dropped.t);
    }
    return stored;
  }

  /**
   * Reads records of one kind, oldest first.
   *
   * The returned `cursor` continues the read without duplicates or holes:
   * the `seq` of the last returned record when `hasMore`, else the newest
   * `seq` of the buffer (records of other kinds and records the filter
   * skipped are behind it). `gap` is true when a record after `cursor` (and
   * at or after `since`) was dropped because the buffer was full. When
   * `cursor` and `since` are both given, `gap` is approximate: a record
   * dropped after `cursor` but before `since` is not distinguished.
   *
   * A `cursor` above the newest `seq` (from an earlier session: `seq` starts
   * at 1 per session) is stale. The read then starts from the oldest record
   * and reports `gap: true`, so a client that only compares cursors notices
   * the records are not the ones it asked for.
   *
   * `limit` is clamped to at least 1.
   *
   * @param options - What to read.
   * @returns The page.
   */
  read<RecordType extends EventRecordBase>(
    options: EventReadOptions<RecordType>,
  ): EventPage<RecordType> {
    const { kind, since, limit, filter } = options;
    const requestedCursor = options.cursor ?? 0;
    const staleCursor = requestedCursor > this.#seq;
    const cursor = staleCursor ? 0 : requestedCursor;
    const maxRecords =
      Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    const state = this.#kinds[kind];
    const records: RecordType[] = [];
    let hasMore = false;
    for (const record of state.records as RecordType[]) {
      if (
        record.seq <= cursor ||
        (since !== undefined && record.t < since) ||
        (filter !== undefined && !filter(record))
      ) {
        continue;
      }
      if (records.length === maxRecords) {
        hasMore = true;
        break;
      }
      records.push({ ...record });
    }
    const last = records.at(-1);
    return {
      records,
      cursor:
        hasMore && last !== undefined ? last.seq : Math.max(cursor, this.#seq),
      hasMore,
      gap:
        staleCursor ||
        (state.lastDroppedSeq > cursor &&
          (since === undefined || state.lastDroppedT >= since)),
      summary: this.summary(),
    };
  }

  /**
   * Empties the buffer of one kind, or of every kind. `seq` keeps counting,
   * so older cursors stay valid. Cleared records are not a gap.
   *
   * @param kind - The kind to clear; every kind when undefined.
   * @returns The kinds cleared.
   */
  clear(kind?: EventKind): EventKind[] {
    const kinds = kind === undefined ? [...EVENT_KINDS] : [kind];
    for (const each of kinds) {
      this.#kinds[each].records.length = 0;
    }
    return kinds;
  }

  /**
   * Counts an error of an event source, reported in the summary. It takes
   * no `seq`: it is not a record.
   *
   * @param message - The error text, already redacted.
   */
  noteCaptureError(message: string): void {
    this.#captureErrors += 1;
    this.#lastCaptureError = message;
  }

  /**
   * @returns The buffer state.
   */
  summary(): EventSummary {
    return {
      startedAt: this.startedAt,
      seq: this.#seq,
      counts: {
        console: this.#kinds.console.records.length,
        network: this.#kinds.network.records.length,
      },
      dropped: {
        console: this.#kinds.console.dropped,
        network: this.#kinds.network.dropped,
      },
      captureErrors: this.#captureErrors,
      ...(this.#lastCaptureError === undefined
        ? {}
        : { lastCaptureError: this.#lastCaptureError }),
    };
  }
}
