import type express from 'express';

import type { ToolResponseMeta, ToolResponseTiming } from '../types/http.js';

/**
 * Records the phases of one tool request with a monotonic clock and turns
 * them into a {@link ToolResponseTiming}.
 *
 * Phases that never started report 0. A phase that started but did not end
 * (for example a tool that was still running when the queue timed out) is
 * measured up to the moment of the snapshot.
 */
export class RequestTimer {
  readonly #requestStart: number;

  #enqueuedAt: number | undefined;

  #taskStartedAt: number | undefined;

  #toolEndedAt: number | undefined;

  #observationStartedAt: number | undefined;

  #observationEndedAt: number | undefined;

  /**
   * @param requestStart - `performance.now()` value when the request arrived.
   * Defaults to now.
   */
  constructor(requestStart: number = performance.now()) {
    this.#requestStart = requestStart;
  }

  /** Marks the moment the task was handed to the request queue. */
  markEnqueued(): void {
    this.#enqueuedAt = performance.now();
  }

  /** Marks the moment the queued task started (the tool is about to run). */
  markTaskStart(): void {
    this.#taskStartedAt = performance.now();
  }

  /** Marks the end of the tool function call. */
  markToolEnd(): void {
    this.#toolEndedAt = performance.now();
  }

  /** Marks the start of observation collection. */
  markObservationStart(): void {
    this.#observationStartedAt = performance.now();
  }

  /** Marks the end of observation collection. */
  markObservationEnd(): void {
    this.#observationEndedAt = performance.now();
  }

  /**
   * Returns the timing so far, in whole milliseconds.
   *
   * @returns The timing; `totalMs` is never less than the sum of the phases.
   */
  snapshot(): ToolResponseTiming {
    const now = performance.now();
    const span = (
      start: number | undefined,
      end: number | undefined,
    ): number =>
      start === undefined ? 0 : Math.max(0, Math.round((end ?? now) - start));

    const queueMs = span(this.#enqueuedAt, this.#taskStartedAt);
    const toolMs = span(this.#taskStartedAt, this.#toolEndedAt);
    const observationMs = span(
      this.#observationStartedAt,
      this.#observationEndedAt,
    );
    const totalMs = Math.max(
      span(this.#requestStart, undefined),
      queueMs + toolMs + observationMs,
    );
    return { queueMs, toolMs, observationMs, totalMs };
  }

  /**
   * Returns the `meta` object for a response body.
   *
   * @returns The response metadata with the current timing.
   */
  meta(): ToolResponseMeta {
    return { timing: this.snapshot() };
  }
}

/**
 * Adds `meta` to a response body. Bodies that are not plain objects (strings,
 * arrays, null) are returned unchanged.
 *
 * @param body - The response body.
 * @param meta - The metadata to attach.
 * @returns The body with `meta` as its last key.
 */
export function withMeta(body: unknown, meta: ToolResponseMeta): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  return { ...(body as Record<string, unknown>), meta };
}

const requestStarts = new WeakMap<express.Response, number>();

/**
 * Records when a request arrived. Call it before the body parser runs.
 *
 * @param res - The Express response for the request.
 * @param start - `performance.now()` value when the request arrived.
 */
export function setRequestStart(res: express.Response, start: number): void {
  requestStarts.set(res, start);
}

/**
 * Returns when a request arrived, as recorded by {@link setRequestStart}.
 *
 * @param res - The Express response for the request.
 * @returns The recorded start, or now if none was recorded.
 */
export function requestStartOf(res: express.Response): number {
  return requestStarts.get(res) ?? performance.now();
}
