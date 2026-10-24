import { maxRefIndex, stabilizeRefs } from './ref-stability.js';
import type { RefKeyMode, RefTree } from './ref-stability.js';
import { screenSignature } from './screen-settle.js';
import type { ISessionManager } from './session-manager.js';
import type { A11yNodeTrimmed } from '../tools/types/discovery.js';
import { debugWarn } from '../utils/logger.js';

/**
 * The result of a write through a `RefHandle`.
 */
export type RefWrite = {
  /** True when the map reached the session manager. */
  applied: boolean;
  /**
   * The map that was written (or would have been, when dropped). Refs may
   * differ from the input: they are stabilized against the baseline.
   */
  refMap: Map<string, string>;
  /** The nodes with the same refs as `refMap`, when nodes were passed. */
  nodes?: A11yNodeTrimmed[];
};

/**
 * A request's write access to the refMap. Get one from `RefStore.begin()`.
 */
export type RefHandle = {
  /** The generation this handle was created with. */
  readonly generation: number;
  /**
   * True once a tool set refs through this handle during the request (with
   * or without nodes). The observation then keeps those refs (see
   * `setObservation`).
   */
  readonly toolSetRefs: boolean;
  /**
   * True once a tool set refs with nodes during the request: the tool read
   * the screen it returned, so the observation does not need to wait for
   * the screen to settle. A refs-only write (for example through
   * `sessionManager.setRefMap`) does not count.
   */
  readonly toolSawScreen: boolean;
  /**
   * @returns True while no newer request has started and the request is not
   * aborted.
   */
  isCurrent(): boolean;
  /**
   * Sets refs from a tool. Dropped when the handle is not current. When
   * nodes are passed, refs are first stabilized against the baseline, so
   * elements the agent already holds keep their refs.
   *
   * @param map - The new ref map.
   * @param nodes - The nodes the map was built from, when known.
   * @returns The written map and nodes (with stabilized refs).
   */
  set(map: Map<string, string>, nodes?: A11yNodeTrimmed[]): RefWrite;
  /**
   * Sets refs from the post-tool observation. Refs are stabilized against
   * the baseline. Dropped when the handle is not current. When the tool
   * already set refs during this request (and `keepToolRefs` is not false),
   * the result is the tool's map plus the observation entries whose ref the
   * tool map does not have, so every ref of the observation resolves and the
   * tool's refs stay valid.
   *
   * @param map - The new ref map.
   * @param nodes - The observation nodes.
   * @param options - Options.
   * @param options.keepToolRefs - Keep refs the tool set (default true).
   * `run_steps` passes false: a later step may have changed the screen after
   * a step set refs.
   * @returns The written map and the observation nodes (stabilized refs).
   */
  setObservation(
    map: Map<string, string>,
    nodes: A11yNodeTrimmed[],
    options?: { keepToolRefs?: boolean },
  ): RefWrite & { nodes: A11yNodeTrimmed[] };
};

/**
 * The refs the agent last received, used to keep refs stable across
 * observations.
 */
export type RefBaseline = {
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
};

type StoredBaseline = RefBaseline & { signature?: string };

const EMPTY_TREE: RefTree = { nodes: [], refMap: new Map() };

/**
 * Checks whether two maps have the same entries.
 *
 * @param left - First map.
 * @param right - Second map.
 * @returns True when both maps hold the same key/value pairs.
 */
function sameEntries(
  left: Map<string, string>,
  right: Map<string, string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Guards `sessionManager.setRefMap` with a request generation and keeps refs
 * stable.
 *
 * Each request calls `begin()` when it starts. A write from an older request
 * (for example one that timed out and kept running) or from an aborted
 * request is dropped before it reaches the session manager, so it cannot
 * replace the refs of the request that runs now.
 *
 * Writes with nodes are stabilized against the last applied tree (the
 * baseline): an element that is still on screen keeps its ref. New refs
 * start above the highest ref ever applied in the session, so a removed ref
 * is never reused for another element until `resetBaseline()`.
 */
export class RefStore {
  readonly #sessionManager: Pick<ISessionManager, 'setRefMap' | 'getRefMap'>;

  readonly #keyMode: () => RefKeyMode;

  #generation = 0;

  #baseline: StoredBaseline | null = null;

  #highWater = 0;

  /**
   * @param sessionManager - The session manager that owns the refMap.
   * @param keyMode - Returns how elements are matched (browser or mobile)
   * for the current session. Defaults to browser.
   */
  constructor(
    sessionManager: Pick<ISessionManager, 'setRefMap' | 'getRefMap'>,
    keyMode: () => RefKeyMode = () => 'browser',
  ) {
    this.#sessionManager = sessionManager;
    this.#keyMode = keyMode;
  }

  /**
   * @returns The generation of the most recent request.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * @returns The highest ref index applied since the last reset.
   */
  get highWater(): number {
    return this.#highWater;
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
    let toolMap: Map<string, string> | null = null;
    let toolSawScreen = false;

    const isCurrent = (): boolean =>
      generation === this.#generation && signal?.aborted !== true;

    const apply = (
      source: string,
      map: Map<string, string>,
      nodes: A11yNodeTrimmed[] | undefined,
    ): boolean => {
      if (!isCurrent()) {
        debugWarn(
          'ref-store',
          `dropped ${source} refMap from generation ${generation} (current ${this.#generation}, aborted ${String(signal?.aborted === true)})`,
        );
        return false;
      }
      this.#sessionManager.setRefMap(map);
      this.#baseline = nodes ? { nodes, refMap: new Map(map) } : null;
      this.#highWater = Math.max(
        this.#highWater,
        maxRefIndex({ nodes: nodes ?? [], refMap: map }),
      );
      return true;
    };

    return {
      generation,
      get toolSetRefs(): boolean {
        return toolMap !== null;
      },
      get toolSawScreen(): boolean {
        return toolSawScreen;
      },
      isCurrent,
      set: (map, nodes): RefWrite => {
        const tree = nodes ? this.#stabilize(map, nodes) : undefined;
        const refMap = tree?.refMap ?? map;
        const applied = apply('tool', refMap, tree?.nodes);
        if (applied) {
          toolMap = refMap;
          toolSawScreen ||= nodes !== undefined;
        }
        return { applied, refMap, ...(tree ? { nodes: tree.nodes } : {}) };
      },
      setObservation: (
        map,
        nodes,
        options,
      ): RefWrite & { nodes: A11yNodeTrimmed[] } => {
        const tree = this.#stabilize(map, nodes);
        let { refMap } = tree;
        if (toolMap && options?.keepToolRefs !== false) {
          const merged = new Map(toolMap);
          for (const [ref, target] of tree.refMap) {
            if (!merged.has(ref)) {
              merged.set(ref, target);
            }
          }
          refMap = merged;
        }
        const applied = apply('observation', refMap, tree.nodes);
        return { applied, refMap, nodes: tree.nodes };
      },
    };
  }

  /**
   * Forgets the baseline and the highest ref (for example after a launch or
   * cleanup, which start or end a session).
   */
  resetBaseline(): void {
    this.#baseline = null;
    this.#highWater = 0;
  }

  /**
   * Returns the nodes and map of the last write, if the session manager still
   * holds that map. Returns null when something else (for example code
   * calling the real `sessionManager.setRefMap` directly) replaced it.
   *
   * @returns The baseline, or null.
   */
  baseline(): RefBaseline | null {
    return this.#validBaseline();
  }

  /**
   * Returns the screen signature of the baseline nodes (see
   * `screenSignature`). Computed once per baseline and cached.
   *
   * @returns The signature, or null when there is no valid baseline.
   */
  baselineSignature(): string | null {
    const baseline = this.#validBaseline();
    if (!baseline) {
      return null;
    }
    baseline.signature ??= screenSignature(baseline.nodes);
    return baseline.signature;
  }

  /**
   * @returns The stored baseline when the session manager still holds its
   * map, else null.
   */
  #validBaseline(): StoredBaseline | null {
    if (!this.#baseline) {
      return null;
    }
    let current: Map<string, string>;
    try {
      current = this.#sessionManager.getRefMap();
    } catch {
      return null;
    }
    return sameEntries(this.#baseline.refMap, current) ? this.#baseline : null;
  }

  /**
   * Stabilizes a tree against the baseline, with fresh refs above the
   * highest ref ever applied. Returns the tree unchanged at the start of a
   * session (no baseline and no refs applied yet).
   *
   * @param map - The new ref map.
   * @param nodes - The new nodes.
   * @returns The stabilized tree.
   */
  #stabilize(map: Map<string, string>, nodes: A11yNodeTrimmed[]): RefTree {
    const baseline = this.#validBaseline();
    if (!baseline && this.#highWater === 0) {
      return { nodes, refMap: map };
    }
    return stabilizeRefs(
      baseline ?? EMPTY_TREE,
      { nodes, refMap: map },
      this.#keyMode(),
      this.#highWater,
    );
  }
}
