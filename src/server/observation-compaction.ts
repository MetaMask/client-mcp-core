import type { A11yNodeTrimmed } from '../tools/types/discovery.js';
import type { StepRecordObservation } from '../tools/types/step-record.js';
import { OPTION_COLLAPSE_MIN_COUNT } from '../tools/utils/constants.js';

const OPTION_RANGE_PATTERN =
  /^(?<prefix>[^\d]+)(?<start>\d+)\u2013\k<prefix>(?<end>\d+)$/u;

type RefRange = {
  firstRef: string;
  lastRef: string;
  count: number;
};

/**
 * Parses a ref string into its first/last ref and total node count.
 * Handles range refs like "e2–e6" from collapseIdenticalRuns, returning
 * the spanning range and the count of individual nodes it represents.
 *
 * @param ref - A node ref string, either a simple ref (e.g. "e3") or a range (e.g. "e2–e6").
 * @returns The first ref, last ref, and total count of nodes the ref represents.
 */
function parseRefRange(ref: string): RefRange {
  const match = OPTION_RANGE_PATTERN.exec(ref);
  if (!match?.groups) {
    return { firstRef: ref, lastRef: ref, count: 1 };
  }

  const { prefix, start, end } = match.groups;
  const startIndex = Number(start);
  const endIndex = Number(end);

  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
    return { firstRef: ref, lastRef: ref, count: 1 };
  }

  return {
    firstRef: `${prefix}${start}`,
    lastRef: `${prefix}${end}`,
    count: Math.abs(endIndex - startIndex) + 1,
  };
}

/**
 * Builds a summary node representing a collapsed group of option nodes.
 *
 * @param nodes - Array of option nodes to summarize.
 * @returns A single summary node representing the collapsed options.
 */
function buildOptionSummary(nodes: A11yNodeTrimmed[]): A11yNodeTrimmed {
  const firstRange = parseRefRange(nodes[0].ref);
  const lastRange = parseRefRange(nodes[nodes.length - 1].ref);
  const optionCount = nodes.reduce(
    (count, node) => count + parseRefRange(node.ref).count,
    0,
  );
  const refRange = `${firstRange.firstRef}\u2013${lastRange.lastRef}`;

  return {
    ref: refRange,
    role: 'option',
    name: `${optionCount} options (refs ${refRange})`,
    path: nodes[0].path,
  };
}

export const observationCompactionDeps = {
  collapseOptionSubtrees(nodes: A11yNodeTrimmed[]): A11yNodeTrimmed[] {
    const collapsed: A11yNodeTrimmed[] = [];
    let cursor = 0;

    while (cursor < nodes.length) {
      const current = nodes[cursor];

      if (current.role !== 'combobox' && current.role !== 'listbox') {
        collapsed.push(current);
        cursor += 1;
        continue;
      }

      collapsed.push(current);
      cursor += 1;

      const optionNodes: A11yNodeTrimmed[] = [];
      while (cursor < nodes.length && nodes[cursor].role === 'option') {
        optionNodes.push(nodes[cursor]);
        cursor += 1;
      }

      if (optionNodes.length === 0) {
        continue;
      }

      const optionCount = optionNodes.reduce(
        (count, node) => count + parseRefRange(node.ref).count,
        0,
      );

      if (optionCount >= OPTION_COLLAPSE_MIN_COUNT) {
        collapsed.push(buildOptionSummary(optionNodes));
        continue;
      }

      collapsed.push(...optionNodes);
    }

    return collapsed;
  },
};

/**
 * Collapses consecutive option nodes immediately beneath combobox/listbox nodes.
 *
 * @param nodes - Flat accessibility nodes to compact.
 * @returns A new node array with large option runs summarized.
 */
export function collapseOptionSubtrees(
  nodes: A11yNodeTrimmed[],
): A11yNodeTrimmed[] {
  return observationCompactionDeps.collapseOptionSubtrees(nodes);
}

/**
 * Creates a compacted copy of an observation while preserving non-a11y fields.
 *
 * @param observation - Observation to compact.
 * @param previousObservation - Optional previous observation to compute diff against.
 * @returns A new compacted observation, or the original observation on failure.
 */
export function compactObservation(
  observation: StepRecordObservation,
  previousObservation?: StepRecordObservation | null,
): StepRecordObservation {
  try {
    const optionFiltered: StepRecordObservation = {
      ...observation,
      a11y: {
        ...observation.a11y,
        nodes: observationCompactionDeps.collapseOptionSubtrees(
          observation.a11y.nodes,
        ),
      },
    };

    if (!previousObservation) {
      return optionFiltered;
    }

    const previousFiltered: StepRecordObservation = {
      ...previousObservation,
      a11y: {
        ...previousObservation.a11y,
        nodes: observationCompactionDeps.collapseOptionSubtrees(
          previousObservation.a11y.nodes,
        ),
      },
    };

    const diffResult = diffObservation(optionFiltered, previousFiltered);

    if (diffResult.a11y.nodes.length >= optionFiltered.a11y.nodes.length) {
      return optionFiltered;
    }

    return diffResult;
  } catch {
    return observation;
  }
}

/**
 * Checks if two string arrays are equal.
 *
 * @param left - First array to compare.
 * @param right - Second array to compare.
 * @returns True if arrays have equal length and identical elements.
 */
function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((val, idx) => val === right[idx])
  );
}

/**
 * Checks if two accessibility nodes have changed.
 *
 * @param a - First node to compare.
 * @param b - Second node to compare.
 * @returns True if any property differs between the nodes.
 */
export function nodeChanged(a: A11yNodeTrimmed, b: A11yNodeTrimmed): boolean {
  return (
    a.name !== b.name ||
    a.role !== b.role ||
    a.disabled !== b.disabled ||
    a.checked !== b.checked ||
    a.expanded !== b.expanded ||
    a.testId !== b.testId ||
    a.textContent !== b.textContent ||
    !arraysEqual(a.path, b.path)
  );
}

/**
 * Computes the diff between two observations, returning only changed or new nodes.
 *
 * @param current - The current observation to compare.
 * @param previous - The previous observation to compare against.
 * @returns A new observation containing only changed/new nodes with diff metadata.
 */
export function diffObservation(
  current: StepRecordObservation,
  previous: StepRecordObservation,
): StepRecordObservation {
  const prevMap = new Map(
    previous.a11y.nodes.map((node) => [node.ref, node] as const),
  );
  const currMap = new Map(
    current.a11y.nodes.map((node) => [node.ref, node] as const),
  );
  const changedOrNewNodes: A11yNodeTrimmed[] = [];
  const addedRefs: string[] = [];
  const removedRefs: string[] = [];
  let unchangedCount = 0;

  for (const [ref, currNode] of currMap) {
    const prevNode = prevMap.get(ref);

    if (!prevNode) {
      addedRefs.push(ref);
      changedOrNewNodes.push(currNode);
      continue;
    }

    if (nodeChanged(currNode, prevNode)) {
      changedOrNewNodes.push(currNode);
      continue;
    }

    unchangedCount += 1;
  }

  for (const ref of prevMap.keys()) {
    if (!currMap.has(ref)) {
      removedRefs.push(ref);
    }
  }

  return {
    state: current.state,
    testIds: current.testIds,
    a11y: {
      nodes: changedOrNewNodes,
      diff: {
        added: addedRefs,
        removed: removedRefs,
        unchanged: unchangedCount,
      },
    },
    priorKnowledge: current.priorKnowledge,
  };
}
