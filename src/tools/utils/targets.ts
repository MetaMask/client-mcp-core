import type { TargetSelection } from '../types';

/**
 * Result of target validation.
 */
export type TargetValidationResult =
  | {
      /** Whether the target is valid */
      valid: true;
      /** The type of target selector */
      type: 'a11yRef' | 'testId' | 'selector';
      /** The value of the target selector */
      value: string;
    }
  | {
      /** Whether the target is valid */
      valid: false;
      /** Error message describing the validation failure */
      error: string;
    };

/**
 * Validates that exactly one target selector is provided.
 *
 * @param target - The target selection object to validate.
 * @returns Validation result with type and value if valid, error if invalid.
 */
export function validateTargetSelection(
  target: TargetSelection,
): TargetValidationResult {
  const provided = [
    target.a11yRef ? 'a11yRef' : null,
    target.testId ? 'testId' : null,
    target.selector ? 'selector' : null,
  ].filter(Boolean) as ('a11yRef' | 'testId' | 'selector')[];

  if (provided.length === 0) {
    return {
      valid: false,
      error: 'Exactly one of a11yRef, testId, or selector must be provided',
    };
  }

  if (provided.length > 1) {
    return {
      valid: false,
      error: `Multiple targets provided (${provided.join(', ')}). Exactly one must be specified.`,
    };
  }

  const type = provided[0];
  const value = target[type] as string;

  return { valid: true, type, value };
}
