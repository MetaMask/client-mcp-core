/**
 * Extracts a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 */
export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
