/**
 *
 */
export type ConsoleErrorEntry = {
  /**
   *
   */
  timestamp: number;
  /**
   *
   */
  message: string;
  /**
   *
   */
  source: string;
};

/**
 *
 */
export class ConsoleErrorBuffer {
  readonly #maxEntries: number;

  readonly #entries: ConsoleErrorEntry[] = [];

  /**
   * Initialize the console error buffer with a maximum capacity.
   *
   * @param maxEntries - Maximum number of error entries to store before discarding oldest
   */
  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  /**
   * Add a console error entry to the buffer, removing oldest if at capacity.
   *
   * @param entry - The console error entry to add
   */
  add(entry: ConsoleErrorEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.shift();
    }
  }

  /**
   * Get all stored console error entries.
   *
   * @returns A copy of all stored error entries
   */
  getAll(): ConsoleErrorEntry[] {
    return [...this.#entries];
  }

  /**
   * Get the most recent console error entries.
   *
   * @param count - Number of recent entries to retrieve
   * @returns The most recent error entries, up to the requested count
   */
  getRecent(count: number): ConsoleErrorEntry[] {
    if (count <= 0) {
      return [];
    }

    return this.#entries.slice(-count);
  }

  /**
   * Get the current number of stored error entries.
   *
   * @returns The count of error entries currently in the buffer
   */
  get size(): number {
    return this.#entries.length;
  }
}
