/**
 * Type guard functions for runtime type safety.
 * These provide better TypeScript inference and runtime validation
 * compared to unsafe `as` type assertions.
 */

/**
 *
 */
export type TargetType = 'a11yRef' | 'testId' | 'selector';

/**
 * Type guard for valid target selection result.
 * Ensures the result has valid=true and contains type and value properties.
 *
 * @param result - The result to check.
 * @returns True if the result is a valid target selection.
 */
export function isValidTargetSelection(result: unknown): result is {
  /**
   *
   */
  valid: true;
  /**
   *
   */
  type: TargetType;
  /**
   *
   */
  value: string;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    'valid' in result &&
    (
      result as {
        /**
         *
         */
        valid: boolean;
      }
    ).valid &&
    'type' in result &&
    'value' in result &&
    typeof (
      result as {
        /**
         *
         */
        type: unknown;
      }
    ).type === 'string' &&
    typeof (
      result as {
        /**
         *
         */
        value: unknown;
      }
    ).value === 'string'
  );
}

/**
 * Type guard for invalid target selection result.
 * Ensures the result has valid=false and contains error property.
 *
 * @param result - The result to check.
 * @returns True if the result is an invalid target selection.
 */
export function isInvalidTargetSelection(result: unknown): result is {
  /**
   *
   */
  valid: false;
  /**
   *
   */
  error: string;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    'valid' in result &&
    !(
      result as {
        /**
         *
         */
        valid: boolean;
      }
    ).valid &&
    'error' in result &&
    typeof (
      result as {
        /**
         *
         */
        error: unknown;
      }
    ).error === 'string'
  );
}
