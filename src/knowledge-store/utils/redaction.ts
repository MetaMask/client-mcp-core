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
