import type { PriorKnowledgeTarget } from '../../tools/types/knowledge.js';
import type { StepRecord } from '../../tools/types/step-record.js';

export const SENSITIVE_FIELD_PATTERNS = [
  /password/iu,
  /seed/iu,
  /srp/iu,
  /phrase/iu,
  /mnemonic/iu,
  /private.*key/iu,
  /secret/iu,
  /api[-_]?key/iu,
] as const;

/**
 * Checks if a field name matches sensitive data patterns.
 *
 * @param fieldName - The field name to check for sensitivity.
 * @returns True if the field matches a sensitive pattern.
 */
export function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Remove raw and JSON-escaped echoes from errors, targets, observations, and
 * artifact paths. Strings shorter than eight characters match whole values
 * only; longer strings match substrings. Structural step metadata is retained.
 *
 * @param record - The step record.
 * @param redactedValues - Input values omitted from the recorded input.
 * @returns A copy of the record with echoed strings redacted.
 */
export function redactRecordedSecrets(
  record: StepRecord,
  redactedValues: unknown[],
): StepRecord {
  const wholeValues = new Set<string>();
  const substrings = new Set<string>();
  const collectStrings = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) {
      const matches = value.length < 8 ? wholeValues : substrings;
      matches.add(value);
      matches.add(JSON.stringify(value).slice(1, -1));
    } else if (Array.isArray(value)) {
      value.forEach(collectStrings);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collectStrings);
    }
  };
  redactedValues.forEach(collectStrings);

  if (wholeValues.size === 0 && substrings.size === 0) {
    return record;
  }
  const sortedSubstrings = [...substrings].sort(
    (first, second) => second.length - first.length,
  );
  // Match existing markers first so their contents are never redacted again.
  const pattern = new RegExp(
    ['[REDACTED]', ...sortedSubstrings]
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|'),
    'gu',
  );
  const redactString = (value: string): string => {
    if (wholeValues.has(value)) {
      return '[REDACTED]';
    }
    return value.replace(pattern, '[REDACTED]');
  };
  const redactValue = <Value>(value: Value, redactKeys = false): Value => {
    if (typeof value === 'string') {
      return redactString(value) as Value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, redactKeys)) as Value;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          redactKeys ? redactString(key) : key,
          redactValue(entry, redactKeys),
        ]),
      ) as Value;
    }
    return value;
  };
  const { error } = record.outcome;
  const screenshot = record.artifacts?.screenshot;
  const { observation } = record;
  const { priorKnowledge } = observation;
  const redactTarget = (target: PriorKnowledgeTarget): PriorKnowledgeTarget => {
    if (target.type === 'a11yHint') {
      return {
        ...target,
        value: { ...target.value, name: redactString(target.value.name) },
      };
    }
    return { ...target, value: redactString(target.value) };
  };
  const sanitized: StepRecord = {
    ...record,
    tool: { ...record.tool },
    outcome: { ...record.outcome },
    observation: {
      ...observation,
      state: {
        ...redactValue(observation.state),
        ...(observation.state.activeTab
          ? {
              activeTab: {
                ...redactValue(observation.state.activeTab),
                role: observation.state.activeTab.role,
              },
            }
          : {}),
      },
      testIds: observation.testIds.map((item) => ({
        ...item,
        testId: redactString(item.testId),
        text: redactValue(item.text),
      })),
      a11y: {
        ...observation.a11y,
        nodes: observation.a11y.nodes.map((node) => ({
          ...node,
          name: redactString(node.name),
          path: redactValue(node.path),
          testId: redactValue(node.testId),
          textContent: redactValue(node.textContent),
        })),
        ...(observation.a11y.diff
          ? { diff: redactValue(observation.a11y.diff) }
          : {}),
      },
    },
  };
  if (record.tool.target) {
    sanitized.tool.target = redactValue(record.tool.target);
  }
  if (error) {
    sanitized.outcome.error = {
      ...error,
      message: redactValue(error.message),
      details: redactValue(error.details, true),
    };
  }
  if (screenshot) {
    sanitized.artifacts = {
      ...record.artifacts,
      screenshot: { ...screenshot, path: redactValue(screenshot.path) },
    };
  }
  if (priorKnowledge) {
    sanitized.observation.priorKnowledge = {
      ...priorKnowledge,
      query: {
        ...priorKnowledge.query,
        usedFilters: redactValue(priorKnowledge.query.usedFilters),
      },
      relatedSessions: priorKnowledge.relatedSessions.map((session) => ({
        ...session,
        goal: redactValue(session.goal),
      })),
      similarSteps: priorKnowledge.similarSteps.map((step) => ({
        ...step,
        screen: redactString(step.screen),
        snippet: redactString(step.snippet),
        target: redactValue(step.target),
        ...(step.a11yHint
          ? {
              a11yHint: {
                ...step.a11yHint,
                name: redactString(step.a11yHint.name),
              },
            }
          : {}),
      })),
      suggestedNextActions: priorKnowledge.suggestedNextActions.map(
        (action) => ({
          ...action,
          rationale: redactString(action.rationale),
          preferredTarget: redactTarget(action.preferredTarget),
          fallbackTargets: action.fallbackTargets?.map(redactTarget),
        }),
      ),
      ...(priorKnowledge.avoid
        ? {
            avoid: priorKnowledge.avoid.map((item) => ({
              ...item,
              rationale: redactString(item.rationale),
              target: redactValue(item.target),
            })),
          }
        : {}),
    };
  }
  return sanitized;
}
