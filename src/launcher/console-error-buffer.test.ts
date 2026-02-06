import { describe, it, expect } from 'vitest';

import { ConsoleErrorBuffer } from './console-error-buffer';
import type { ConsoleErrorEntry } from './console-error-buffer';

describe('ConsoleErrorBuffer', () => {
  describe('constructor', () => {
    it('initializes with specified max entries', () => {
      const buffer = new ConsoleErrorBuffer(10);

      expect(buffer.size).toBe(0);
    });

    it('accepts different max entry values', () => {
      const buffer1 = new ConsoleErrorBuffer(5);
      const buffer2 = new ConsoleErrorBuffer(100);

      expect(buffer1.size).toBe(0);
      expect(buffer2.size).toBe(0);
    });
  });

  describe('add', () => {
    it('adds entry to empty buffer', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error message',
        source: 'console.error',
      };

      buffer.add(entry);

      expect(buffer.size).toBe(1);
      expect(buffer.getAll()).toContainEqual(entry);
    });

    it('adds multiple entries in order', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry1: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'first error',
        source: 'console.error',
      };
      const entry2: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'second error',
        source: 'console.warn',
      };

      buffer.add(entry1);
      buffer.add(entry2);

      const all = buffer.getAll();
      expect(all).toHaveLength(2);
      expect(all[0]).toStrictEqual(entry1);
      expect(all[1]).toStrictEqual(entry2);
    });

    it('removes oldest entry when exceeding max capacity', () => {
      const buffer = new ConsoleErrorBuffer(2);
      const entry1: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'first',
        source: 'console.error',
      };
      const entry2: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'second',
        source: 'console.error',
      };
      const entry3: ConsoleErrorEntry = {
        timestamp: 3000,
        message: 'third',
        source: 'console.error',
      };

      buffer.add(entry1);
      buffer.add(entry2);
      buffer.add(entry3);

      expect(buffer.size).toBe(2);
      const all = buffer.getAll();
      expect(all).toStrictEqual([entry2, entry3]);
    });

    it('maintains FIFO order when overflowing', () => {
      const buffer = new ConsoleErrorBuffer(3);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 5; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      const all = buffer.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].message).toBe('error 3');
      expect(all[1].message).toBe('error 4');
      expect(all[2].message).toBe('error 5');
    });

    it('handles buffer with max capacity of 1', () => {
      const buffer = new ConsoleErrorBuffer(1);
      const entry1: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'first',
        source: 'console.error',
      };
      const entry2: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'second',
        source: 'console.error',
      };

      buffer.add(entry1);
      expect(buffer.size).toBe(1);

      buffer.add(entry2);
      expect(buffer.size).toBe(1);
      expect(buffer.getAll()[0]).toStrictEqual(entry2);
    });

    it('stores entries with different sources', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const errorEntry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };
      const warnEntry: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'warning',
        source: 'console.warn',
      };
      const logEntry: ConsoleErrorEntry = {
        timestamp: 3000,
        message: 'log',
        source: 'console.log',
      };

      buffer.add(errorEntry);
      buffer.add(warnEntry);
      buffer.add(logEntry);

      const all = buffer.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((e) => e.source)).toStrictEqual([
        'console.error',
        'console.warn',
        'console.log',
      ]);
    });
  });

  describe('getAll', () => {
    it('returns empty array for empty buffer', () => {
      const buffer = new ConsoleErrorBuffer(10);

      const all = buffer.getAll();

      expect(all).toStrictEqual([]);
    });

    it('returns copy of entries not reference', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      buffer.add(entry);
      const all1 = buffer.getAll();
      const all2 = buffer.getAll();

      expect(all1).toStrictEqual(all2);
      expect(all1).not.toBe(all2);
    });

    it('returns all entries in insertion order', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 5; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      const all = buffer.getAll();
      expect(all).toStrictEqual(entries);
    });

    it('does not modify buffer when calling getAll', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      buffer.add(entry);
      const sizeBefore = buffer.size;
      buffer.getAll();
      const sizeAfter = buffer.size;

      expect(sizeBefore).toBe(sizeAfter);
      expect(buffer.size).toBe(1);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when count is zero', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      buffer.add(entry);
      const recent = buffer.getRecent(0);

      expect(recent).toStrictEqual([]);
    });

    it('returns empty array when count is negative', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      buffer.add(entry);
      const recent = buffer.getRecent(-5);

      expect(recent).toStrictEqual([]);
    });

    it('returns all entries when count exceeds buffer size', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 3; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      const recent = buffer.getRecent(10);

      expect(recent).toStrictEqual(entries);
    });

    it('returns only the most recent N entries', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 5; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      const recent = buffer.getRecent(2);

      expect(recent).toHaveLength(2);
      expect(recent[0]).toStrictEqual(entries[3]);
      expect(recent[1]).toStrictEqual(entries[4]);
    });

    it('returns one entry when count is one', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry1: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'first',
        source: 'console.error',
      };
      const entry2: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'second',
        source: 'console.error',
      };

      buffer.add(entry1);
      buffer.add(entry2);
      const recent = buffer.getRecent(1);

      expect(recent).toHaveLength(1);
      expect(recent[0]).toStrictEqual(entry2);
    });

    it('returns recent entries from overflowed buffer', () => {
      const buffer = new ConsoleErrorBuffer(3);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 5; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      const recent = buffer.getRecent(2);

      expect(recent).toHaveLength(2);
      expect(recent[0].message).toBe('error 4');
      expect(recent[1].message).toBe('error 5');
    });

    it('returns copy not reference', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      buffer.add(entry);
      const recent1 = buffer.getRecent(1);
      const recent2 = buffer.getRecent(1);

      expect(recent1).toStrictEqual(recent2);
      expect(recent1).not.toBe(recent2);
    });

    it('handles empty buffer', () => {
      const buffer = new ConsoleErrorBuffer(10);

      const recent = buffer.getRecent(5);

      expect(recent).toStrictEqual([]);
    });
  });

  describe('size', () => {
    it('returns zero for empty buffer', () => {
      const buffer = new ConsoleErrorBuffer(10);

      expect(buffer.size).toBe(0);
    });

    it('increments with each add', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      expect(buffer.size).toBe(0);
      buffer.add(entry);
      expect(buffer.size).toBe(1);
      buffer.add(entry);
      expect(buffer.size).toBe(2);
    });

    it('never exceeds max capacity', () => {
      const buffer = new ConsoleErrorBuffer(3);
      const entry: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error',
        source: 'console.error',
      };

      for (let i = 0; i < 10; i++) {
        buffer.add(entry);
        expect(buffer.size).toBeLessThanOrEqual(3);
      }

      expect(buffer.size).toBe(3);
    });

    it('reflects actual number of stored entries', () => {
      const buffer = new ConsoleErrorBuffer(5);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 3; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      expect(buffer.size).toBe(entries.length);
      expect(buffer.getAll()).toHaveLength(buffer.size);
    });
  });

  describe('integration', () => {
    it('handles rapid additions and retrievals', () => {
      const buffer = new ConsoleErrorBuffer(5);

      for (let i = 1; i <= 10; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        buffer.add(entry);
      }

      expect(buffer.size).toBe(5);
      const all = buffer.getAll();
      expect(all).toHaveLength(5);
      expect(all[0].message).toBe('error 6');
      expect(all[4].message).toBe('error 10');
    });

    it('maintains consistency across multiple operations', () => {
      const buffer = new ConsoleErrorBuffer(4);
      const entry1: ConsoleErrorEntry = {
        timestamp: 1000,
        message: 'error 1',
        source: 'console.error',
      };
      const entry2: ConsoleErrorEntry = {
        timestamp: 2000,
        message: 'error 2',
        source: 'console.error',
      };
      const entry3: ConsoleErrorEntry = {
        timestamp: 3000,
        message: 'error 3',
        source: 'console.error',
      };

      buffer.add(entry1);
      expect(buffer.size).toBe(1);
      expect(buffer.getRecent(1)).toStrictEqual([entry1]);

      buffer.add(entry2);
      expect(buffer.size).toBe(2);
      expect(buffer.getRecent(2)).toStrictEqual([entry1, entry2]);

      buffer.add(entry3);
      expect(buffer.size).toBe(3);
      expect(buffer.getAll()).toStrictEqual([entry1, entry2, entry3]);
    });

    it('handles large buffer capacity', () => {
      const buffer = new ConsoleErrorBuffer(1000);
      const entries: ConsoleErrorEntry[] = [];

      for (let i = 1; i <= 500; i++) {
        const entry: ConsoleErrorEntry = {
          timestamp: i * 1000,
          message: `error ${i}`,
          source: 'console.error',
        };
        entries.push(entry);
        buffer.add(entry);
      }

      expect(buffer.size).toBe(500);
      expect(buffer.getAll()).toStrictEqual(entries);
      expect(buffer.getRecent(10)).toHaveLength(10);
    });

    it('handles entries with special characters in messages', () => {
      const buffer = new ConsoleErrorBuffer(10);
      const entries: ConsoleErrorEntry[] = [
        {
          timestamp: 1000,
          message: 'error with "quotes"',
          source: 'console.error',
        },
        {
          timestamp: 2000,
          message: "error with 'apostrophes'",
          source: 'console.error',
        },
        {
          timestamp: 3000,
          message: 'error with\nnewlines',
          source: 'console.error',
        },
        {
          timestamp: 4000,
          message: 'error with\ttabs',
          source: 'console.error',
        },
      ];

      entries.forEach((entry) => buffer.add(entry));

      expect(buffer.size).toBe(4);
      expect(buffer.getAll()).toStrictEqual(entries);
    });
  });
});
