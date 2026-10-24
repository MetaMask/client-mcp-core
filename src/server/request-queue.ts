import {
  MAX_QUEUE_TIMEOUT_MS,
  QUEUE_SETTLE_TIMEOUT_MS,
} from '../tools/utils/constants.js';
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
   * Each task gets its own `AbortSignal`. When the task times out, the signal
   * is aborted (with the timeout error as its reason) before the returned
   * promise rejects, so the task can stop its remaining work. The queue still
   * waits up to `QUEUE_SETTLE_TIMEOUT_MS` for the task to settle before the
   * next task starts.
   *
   * @param fn - The async function to execute. It receives the task's signal.
   * @param options - Optional configuration for the enqueued task.
   * @param options.timeoutMs - Override timeout in milliseconds for this task.
   * @returns The resolved value of the provided function.
   */
  async enqueue<Result>(
    fn: (signal: AbortSignal) => Promise<Result>,
    options?: { timeoutMs?: number },
  ): Promise<Result> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.#queue;
    this.#queue = next;
    await prev;
    // Clamp caller-supplied timeouts (they come from request bodies).
    let effectiveTimeout = options?.timeoutMs ?? this.#timeoutMs;
    if (!(effectiveTimeout > 0)) {
      effectiveTimeout = this.#timeoutMs;
    }
    if (effectiveTimeout > MAX_QUEUE_TIMEOUT_MS) {
      effectiveTimeout = MAX_QUEUE_TIMEOUT_MS;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fnPromise = fn(controller.signal);
    try {
      return await Promise.race([
        fnPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `Tool execution timed out after ${effectiveTimeout}ms`,
            );
            controller.abort(error);
            reject(error);
          }, effectiveTimeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        fnPromise.catch((error) => {
          debugWarn('request-queue.enqueue', error);
        }),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, QUEUE_SETTLE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(settleTimer);
      release();
    }
  }
}
