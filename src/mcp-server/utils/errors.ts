/**
 * Extracts a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 *
 * @param error - The error value to extract a message from.
 * @returns The error message as a string.
 */
export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
