import type {
  StepRecord,
  StepRecordObservation,
} from '../../tools/types/step-record.js';

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

const REDACTED = '[REDACTED]';
const MIN_SUBSTRING_LENGTH = 8;

type SecretMatches = {
  wholeValues: Set<string>;
  substrings: Set<string>;
};

type SecretRedactor = {
  text: (value: string) => string;
  value: <Value>(value: Value, redactKeys?: boolean) => Value;
};

/**
 * Collect raw and JSON-escaped strings using the raw length for both variants.
 *
 * @param value - A secret or nested collection of secrets.
 * @param matches - Whole-value and substring matches to populate.
 */
function collectSecretMatches(value: unknown, matches: SecretMatches): void {
  if (typeof value === 'string' && value.length > 0) {
    const bucket =
      value.length < MIN_SUBSTRING_LENGTH
        ? matches.wholeValues
        : matches.substrings;
    bucket.add(value);
    bucket.add(JSON.stringify(value).slice(1, -1));
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectSecretMatches(entry, matches));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) =>
      collectSecretMatches(entry, matches),
    );
  }
}

/**
 * Copy nested values while redacting strings. Dates and non-string leaves survive.
 *
 * @param value - The value to copy.
 * @param redactText - The string-matching policy.
 * @param redactKeys - Whether object keys also contain free text (error details).
 * @returns The redacted value.
 */
function redactNestedValue<Value>(
  value: Value,
  redactText: SecretRedactor['text'],
  redactKeys: boolean,
): Value {
  if (typeof value === 'string') {
    return redactText(value) as Value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactNestedValue(entry, redactText, redactKeys),
    ) as Value;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactKeys ? redactText(key) : key,
        redactNestedValue(entry, redactText, redactKeys),
      ]),
    ) as Value;
  }
  return value;
}

/**
 * Build matching once per record, independent of which record fields use it.
 *
 * @param redactedValues - Input values omitted from the recorded input.
 * @returns A redactor, or undefined when there are no nonempty secret strings.
 */
function createSecretRedactor(
  redactedValues: unknown[],
): SecretRedactor | undefined {
  const matches: SecretMatches = {
    wholeValues: new Set(),
    substrings: new Set(),
  };
  redactedValues.forEach((value) => collectSecretMatches(value, matches));
  if (matches.wholeValues.size === 0 && matches.substrings.size === 0) {
    return undefined;
  }

  const sortedSubstrings = [...matches.substrings].sort(
    (first, second) => second.length - first.length,
  );
  // Match existing markers first, then longer secrets before their prefixes.
  const pattern = new RegExp(
    [REDACTED, ...sortedSubstrings]
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|'),
    'gu',
  );
  /**
   * Redact whole-value matches before replacing embedded longer secrets.
   *
   * @param value - Text that may echo a secret.
   * @returns The redacted text.
   */
  function redactText(value: string): string {
    if (matches.wholeValues.has(value)) {
      return REDACTED;
    }
    return value.replace(pattern, REDACTED);
  }
  return {
    text: redactText,
    value: (value, redactKeys = false) =>
      redactNestedValue(value, redactText, redactKeys),
  };
}

/**
 * Redact observation text while retaining accessibility refs, roles, and tags.
 *
 * @param observation - The post-execution observation.
 * @param redactor - The secret-matching operations.
 * @returns A redacted copy of the observation.
 */
function redactObservation(
  observation: StepRecordObservation,
  redactor: SecretRedactor,
): StepRecordObservation {
  const state = { ...redactor.value(observation.state) };
  if (observation.state.activeTab) {
    state.activeTab = {
      ...redactor.value(observation.state.activeTab),
      role: observation.state.activeTab.role,
    };
  }

  const sanitized: StepRecordObservation = {
    ...observation,
    state,
    testIds: observation.testIds.map((item) => ({
      ...item,
      testId: redactor.text(item.testId),
      text: redactor.value(item.text),
    })),
    a11y: {
      ...observation.a11y,
      nodes: observation.a11y.nodes.map((node) => ({
        ...node,
        name: redactor.text(node.name),
        path: redactor.value(node.path),
        testId: redactor.value(node.testId),
        textContent: redactor.value(node.textContent),
      })),
    },
  };
  if (observation.a11y.diff) {
    sanitized.a11y.diff = redactor.value(observation.a11y.diff);
  }
  return sanitized;
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
  const redactor = createSecretRedactor(redactedValues);
  if (!redactor) {
    return record;
  }
  const { error } = record.outcome;
  const screenshot = record.artifacts?.screenshot;
  const sanitized: StepRecord = {
    ...record,
    tool: { ...record.tool },
    outcome: { ...record.outcome },
    observation: redactObservation(record.observation, redactor),
  };
  if (record.tool.target) {
    sanitized.tool.target = redactor.value(record.tool.target);
  }
  if (error) {
    sanitized.outcome.error = {
      ...error,
      message: redactor.value(error.message),
      details: redactor.value(error.details, true),
    };
  }
  if (screenshot) {
    sanitized.artifacts = {
      ...record.artifacts,
      screenshot: { ...screenshot, path: redactor.value(screenshot.path) },
    };
  }
  return sanitized;
}
