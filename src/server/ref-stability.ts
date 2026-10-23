import type { A11yNodeTrimmed } from '../tools/types/discovery.js';

/**
 * How elements are matched between two trees.
 *
 * - `browser`: role + name + testId.
 * - `mobile`: the stable identifier (testId) when present, else role + name.
 */
export type RefKeyMode = 'browser' | 'mobile';

export type RefTree = {
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
};

const SIMPLE_REF = /^e(?<index>\d+)$/u;
const RANGE_REF = /^e(?<start>\d+)\u2013e(?<end>\d+)$/u;

/**
 * Builds the match key of a node.
 *
 * @param node - The node.
 * @param mode - The key mode.
 * @returns The key.
 */
export function refKey(node: A11yNodeTrimmed, mode: RefKeyMode): string {
  if (mode === 'mobile') {
    return node.testId
      ? `id\u0000${node.testId}`
      : `rn\u0000${node.role}\u0000${node.name}`;
  }
  return `${node.role}\u0000${node.name}\u0000${node.testId ?? ''}`;
}

/**
 * Lists the refs covered by collapsed-run summary nodes (`e3–e6`).
 *
 * @param nodes - The nodes.
 * @returns The covered refs, including the first node of each run.
 */
function rangeMembers(nodes: A11yNodeTrimmed[]): Set<string> {
  const members = new Set<string>();
  for (const node of nodes) {
    const groups = RANGE_REF.exec(node.ref)?.groups;
    if (groups) {
      for (let i = Number(groups.start); i <= Number(groups.end); i++) {
        members.add(`e${i}`);
      }
    }
  }
  return members;
}

/**
 * Groups the refs of the matchable nodes by key, in tree (screen) order. Not
 * matchable: refs inside collapsed runs, and `option` nodes (observations
 * summarize options as a `first–last` ref range, which must stay
 * contiguous).
 *
 * @param nodes - The nodes.
 * @param mode - The key mode.
 * @returns The refs per key, each list in tree order.
 */
function refsByKey(
  nodes: A11yNodeTrimmed[],
  mode: RefKeyMode,
): Map<string, string[]> {
  const members = rangeMembers(nodes);
  const byKey = new Map<string, string[]>();
  for (const node of nodes) {
    if (
      node.role !== 'option' &&
      SIMPLE_REF.test(node.ref) &&
      !members.has(node.ref)
    ) {
      const key = refKey(node, mode);
      const refs = byKey.get(key);
      if (refs) {
        refs.push(node.ref);
      } else {
        byKey.set(key, [node.ref]);
      }
    }
  }
  return byKey;
}

/**
 * Returns the highest `eN` index used by a tree (nodes, ranges and map keys).
 *
 * @param tree - The tree.
 * @returns The highest index, or 0.
 */
export function maxRefIndex(tree: RefTree): number {
  let max = 0;
  const refs = [...tree.nodes.map((node) => node.ref), ...tree.refMap.keys()];
  for (const ref of refs) {
    const groups = SIMPLE_REF.exec(ref)?.groups ?? RANGE_REF.exec(ref)?.groups;
    for (const value of Object.values(groups ?? {})) {
      max = Math.max(max, Number(value));
    }
  }
  return max;
}

/**
 * Renumbers the refs of a new tree so an element that was in the previous
 * tree keeps its previous ref.
 *
 * Elements are matched by key (see `RefKeyMode`). A key found once in each
 * tree matches that element. When a key is found more than once (for
 * example many unnamed containers on mobile), elements that share it are
 * matched in screen order: the k-th element with key K in the new tree gets
 * the ref of the k-th element with key K in the previous tree, for k up to
 * the smaller of the two counts. So an element inserted in the middle of
 * such a group shifts the refs of the later elements of that group by one
 * (each gets the ref of its predecessor, and the last one a fresh ref);
 * elements before it, and elements with other keys, keep their refs.
 *
 * Every other element (new, an extra occurrence of a key, an option, or
 * inside a collapsed run) gets a fresh ref above both the highest ref of the
 * previous tree and `floor`. Each previous ref is used at most once, so the
 * result has no duplicates. Pass the highest ref ever handed out as `floor`
 * so a ref that was removed earlier is never reused for a different element.
 * Node refs, collapsed-run ranges and the refMap are rewritten together.
 *
 * @param previous - The tree the agent last received.
 * @param next - The new tree.
 * @param mode - How to match elements.
 * @param floor - Fresh refs start above this index (default 0).
 * @returns The new tree with stabilized refs (new objects; inputs unchanged).
 */
export function stabilizeRefs(
  previous: RefTree,
  next: RefTree,
  mode: RefKeyMode,
  floor = 0,
): RefTree {
  const previousKeys = refsByKey(previous.nodes, mode);
  const remap = new Map<string, string>();
  for (const [key, refs] of refsByKey(next.nodes, mode)) {
    const previousRefs = previousKeys.get(key) ?? [];
    // Same key: matched in screen order. A unique key is the case k = 0.
    const matched = Math.min(refs.length, previousRefs.length);
    for (let index = 0; index < matched; index++) {
      remap.set(refs[index], previousRefs[index]);
    }
  }

  let counter = Math.max(floor, maxRefIndex(previous));
  const assignFresh = (ref: string): void => {
    if (!remap.has(ref)) {
      counter += 1;
      remap.set(ref, `e${counter}`);
    }
  };

  // Tree order, so collapsed runs (first node, then its summary) stay
  // contiguous.
  for (const node of next.nodes) {
    const groups = RANGE_REF.exec(node.ref)?.groups;
    if (groups) {
      for (let i = Number(groups.start); i <= Number(groups.end); i++) {
        assignFresh(`e${i}`);
      }
    } else if (SIMPLE_REF.test(node.ref)) {
      assignFresh(node.ref);
    }
  }
  for (const ref of next.refMap.keys()) {
    if (SIMPLE_REF.test(ref)) {
      assignFresh(ref);
    }
  }

  const nodes = next.nodes.map((node): A11yNodeTrimmed => {
    const groups = RANGE_REF.exec(node.ref)?.groups;
    if (!groups) {
      return { ...node, ref: remap.get(node.ref) ?? node.ref };
    }
    const ref = `${remap.get(`e${groups.start}`)}\u2013${remap.get(`e${groups.end}`)}`;
    return { ...node, ref, name: node.name.split(node.ref).join(ref) };
  });
  const refMap = new Map(
    [...next.refMap].map(([ref, target]) => [remap.get(ref) ?? ref, target]),
  );
  return { nodes, refMap };
}
