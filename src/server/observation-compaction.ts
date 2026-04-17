import type { StepRecordObservation } from '../tools/types/step-record.js';
import type { A11yNodeTrimmed } from '../tools/types/discovery.js';
import { OPTION_COLLAPSE_MIN_COUNT } from '../tools/utils/constants.js';

const OPTION_RANGE_PATTERN = /^(?<prefix>[^\d]+)(?<start>\d+)\u2013\k<prefix>(?<end>\d+)$/u;

type RefRange = {
  firstRef: string;
  lastRef: string;
  count: number;
};

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

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((val, idx) => val === right[idx])
  );
}

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
