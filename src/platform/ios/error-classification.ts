/**
 * iOS-specific error classification.
 *
 * This is intentionally a lightweight, standalone module with no dependencies
 * on heavy iOS infrastructure (e.g. ax-snapshot, simctl, xcuitest-client).
 * Tool handlers can safely import it without pulling in Node-only binaries.
 */

/**
 * Classifies a thrown error into an iOS-specific error code and message.
 *
 * @param error - The thrown error to classify.
 * @returns Structured error with iOS-specific code and message.
 */
export function classifyIOSError(error: unknown): {
  code: string;
  message: string;
} {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (
    errorMessage.includes('Element not found') ||
    errorMessage.includes('Element has no rect')
  ) {
    return { code: 'MM_IOS_ELEMENT_NOT_FOUND', message: errorMessage };
  }
  if (errorMessage.includes('Timeout waiting for element')) {
    return { code: 'MM_IOS_ELEMENT_NOT_FOUND', message: errorMessage };
  }
  if (
    errorMessage.includes('Snapshot command failed') ||
    errorMessage.toLowerCase().includes('snapshot failed')
  ) {
    return { code: 'MM_IOS_SNAPSHOT_FAILED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_EMPTY_SNAPSHOT')) {
    return { code: 'MM_IOS_EMPTY_SNAPSHOT', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_PERMISSION_REQUIRED')) {
    return { code: 'MM_IOS_AX_PERMISSION_REQUIRED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_BINARY_MISSING')) {
    return { code: 'MM_IOS_AX_BINARY_MISSING', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_SNAPSHOT_FAILED')) {
    return { code: 'MM_IOS_AX_SNAPSHOT_FAILED', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_AX_DEVICE_NOT_FOUND')) {
    return { code: 'MM_IOS_AX_DEVICE_NOT_FOUND', message: errorMessage };
  }
  if (errorMessage.includes('MM_IOS_RUNNER_RECOVERING')) {
    return { code: 'MM_IOS_RUNNER_RECOVERING', message: errorMessage };
  }
  if (errorMessage.includes('Runner') && errorMessage.includes('not ready')) {
    return { code: 'MM_IOS_RUNNER_NOT_READY', message: errorMessage };
  }
  return { code: 'MM_INTERNAL_ERROR', message: errorMessage };
}
