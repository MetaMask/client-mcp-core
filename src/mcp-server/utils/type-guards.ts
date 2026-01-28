/**
 * Type guard functions for runtime type safety.
 * These provide better TypeScript inference and runtime validation
 * compared to unsafe `as` type assertions.
 */

export type TargetType = "a11yRef" | "testId" | "selector";

/**
 * Type guard for valid target selection result.
 * Ensures the result has valid=true and contains type and value properties.
 */
export function isValidTargetSelection(
  result: unknown,
): result is {
  valid: true;
  type: TargetType;
  value: string;
} {
  return (
    typeof result === "object" &&
    result !== null &&
    "valid" in result &&
    (result as { valid: boolean }).valid === true &&
    "type" in result &&
    "value" in result &&
    typeof (result as { type: unknown }).type === "string" &&
    typeof (result as { value: unknown }).value === "string"
  );
}

/**
 * Type guard for invalid target selection result.
 * Ensures the result has valid=false and contains error property.
 */
export function isInvalidTargetSelection(
  result: unknown,
): result is {
  valid: false;
  error: string;
} {
  return (
    typeof result === "object" &&
    result !== null &&
    "valid" in result &&
    (result as { valid: boolean }).valid === false &&
    "error" in result &&
    typeof (result as { error: unknown }).error === "string"
  );
}
