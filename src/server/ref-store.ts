import type { ISessionManager } from './session-manager.js';
import { debugWarn } from '../utils/logger.js';

/**
 * A request's write access to the refMap. Get one from `RefStore.begin()`.
 */
export type RefHandle = {
  /** The generation this handle was created with. */
  readonly generation: number;
  /**
   * True once refs were set through this handle during the request. The
   * observation then leaves those refs in place (see `create-server.ts`).
   */
  readonly toolSetRefs: boolean;
  /**
   * @returns True while no newer request has started and the request is not
   * aborted.
   */
  isCurrent(): boolean;
  /**
   * Sets the refMap. Dropped when the handle is not current.
   *
   * @param map - The new ref map.
   * @param source - Who writes (`tool` or `observation`). Only `tool` writes
   * set `toolSetRefs`.
   * @returns True when the map reached the session manager.
   */
  set(map: Map<string, string>, source?: 'tool' | 'observation'): boolean;
};

/**
 * Guards `sessionManager.setRefMap` with a request generation.
 *
 * Each request calls `begin()` when it starts. A write from an older request
 * (for example one that timed out and kept running) or from an aborted
 * request is dropped before it reaches the session manager, so it cannot
 * replace the refs of the request that runs now.
 */
export class RefStore {
  readonly #sessionManager: Pick<ISessionManager, 'setRefMap'>;

  #generation = 0;

  /**
   * @param sessionManager - The session manager that owns the refMap.
   */
  constructor(sessionManager: Pick<ISessionManager, 'setRefMap'>) {
    this.#sessionManager = sessionManager;
  }

  /**
   * @returns The generation of the most recent request.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Starts a new generation. Handles from earlier generations stop writing.
   *
   * @param signal - The request's abort signal.
   * @returns The handle for this request.
   */
  begin(signal?: AbortSignal): RefHandle {
    this.#generation += 1;
    const generation = this.#generation;
    let toolSetRefs = false;

    const isCurrent = (): boolean =>
      generation === this.#generation && signal?.aborted !== true;

    return {
      generation,
      get toolSetRefs(): boolean {
        return toolSetRefs;
      },
      isCurrent,
      set: (map, source = 'tool'): boolean => {
        if (!isCurrent()) {
          debugWarn(
            'ref-store',
            `dropped ${source} refMap from generation ${generation} (current ${this.#generation}, aborted ${String(signal?.aborted === true)})`,
          );
          return false;
        }
        this.#sessionManager.setRefMap(map);
        if (source === 'tool') {
          toolSetRefs = true;
        }
        return true;
      },
    };
  }
}
