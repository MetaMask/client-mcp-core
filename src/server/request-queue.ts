import { QUEUE_SETTLE_TIMEOUT_MS } from '../tools/utils/constants.js';
import { debugWarn } from '../utils';

/**
 * Async mutex for serializing concurrent tool requests.
 * Ensures only one tool executes at a time.
 */
export class RequestQueue {
  #queue: Promise<void> = Promise.resolve();

  readonly #timeoutMs: number;

  /**
   * @param timeoutMs - Maximum milliseconds a queued task may run.
   */
  constructor(timeoutMs = 30_000) {
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Enqueues an async task for serial execution with a timeout.
   *
   * @param fn - The async function to execute.
   * @param options - Optional configuration for the enqueued task.
   * @param options.timeoutMs - Override timeout in milliseconds for this task.
   * @returns The resolved value of the provided function.
   */
  async enqueue<Result>(
    fn: () => Promise<Result>,
    options?: { timeoutMs?: number },
  ): Promise<Result> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.#queue;
    this.#queue = next;
    await prev;
    const effectiveTimeout = options?.timeoutMs ?? this.#timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fnPromise = fn();
    try {
      return await Promise.race([
        fnPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Tool execution timed out after ${effectiveTimeout}ms`,
                ),
              ),
            effectiveTimeout,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await Promise.race([
        fnPromise.catch((error) => {
          debugWarn('request-queue.enqueue', error);
        }),
        new Promise<void>((resolve) =>
          setTimeout(resolve, QUEUE_SETTLE_TIMEOUT_MS),
        ),
      ]);
      release();
    }
  }
}
