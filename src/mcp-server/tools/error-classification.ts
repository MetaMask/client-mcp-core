/**
 * Error classification utilities for tool handlers.
 *
 * These utilities help classify errors into specific error codes
 * based on error message patterns.
 */

import { ErrorCodes } from '../types';
import { extractErrorMessage } from '../utils';

const ERROR_PATTERNS = {
  targetNotFound: [
    'Unknown a11yRef',
    'not found',
    'No element found',
    'Timeout waiting for selector',
  ],
  timeout: ['Timeout', 'exceeded', 'timed out'],
  navigation: ['Navigation failed', 'net::ERR'],
  pageClosed: [
    'Target page, context or browser has been closed',
    'page has been closed',
    'context has been closed',
    'browser has been closed',
    'Target closed',
    'Session closed',
  ],
} as const;

/**
 * Check if an error indicates the page was closed.
 *
 * @param error - The error to check for page closure indicators
 * @returns True if the error indicates the page was closed
 */
export function isPageClosedError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return ERROR_PATTERNS.pageClosed.some((pattern) => message.includes(pattern));
}

/**
 * Classify an interaction error into a specific error code.
 *
 * @param error - The error to classify
 * @param fallbackCode - The fallback error code if no pattern matches
 * @returns Object with error code and message
 */
export function classifyInteractionError(
  error: unknown,
  fallbackCode: string,
): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.targetNotFound) {
    if (message.includes(pattern)) {
      return { code: ErrorCodes.MM_TARGET_NOT_FOUND, message };
    }
  }

  for (const pattern of ERROR_PATTERNS.timeout) {
    if (message.includes(pattern)) {
      return { code: ErrorCodes.MM_WAIT_TIMEOUT, message };
    }
  }

  return { code: fallbackCode, message: `Operation failed: ${message}` };
}

/**
 * Classify a click error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyClickError(error: unknown): {
  code: string;
  message: string;
} {
  return classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);
}

/**
 * Classify a type error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyTypeError(error: unknown): {
  code: string;
  message: string;
} {
  return classifyInteractionError(error, ErrorCodes.MM_TYPE_FAILED);
}

/**
 * Classify a wait error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyWaitError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);
  return {
    code: ErrorCodes.MM_WAIT_TIMEOUT,
    message: `Wait timed out: ${message}`,
  };
}

/**
 * Classify a navigation error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyNavigationError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.navigation) {
    if (message.includes(pattern)) {
      return { code: ErrorCodes.MM_NAVIGATION_FAILED, message };
    }
  }

  for (const pattern of ERROR_PATTERNS.timeout) {
    if (message.includes(pattern)) {
      return { code: ErrorCodes.MM_WAIT_TIMEOUT, message };
    }
  }

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_NAVIGATION_FAILED,
        message: `Page closed during navigation: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_NAVIGATION_FAILED,
    message: `Navigation failed: ${message}`,
  };
}

/**
 * Classify a tab operation error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyTabError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  if (message.includes('not found') || message.includes('No tab found')) {
    return { code: ErrorCodes.MM_TAB_NOT_FOUND, message };
  }

  for (const pattern of ERROR_PATTERNS.timeout) {
    if (message.includes(pattern)) {
      return { code: ErrorCodes.MM_WAIT_TIMEOUT, message };
    }
  }

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_NAVIGATION_FAILED,
        message: `Tab operation failed - page closed: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_NAVIGATION_FAILED,
    message: `Tab operation failed: ${message}`,
  };
}

/**
 * Classify a notification wait error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyNotificationError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.timeout) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_NOTIFICATION_TIMEOUT,
        message: `Notification popup did not appear: ${message}`,
      };
    }
  }

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_NOTIFICATION_TIMEOUT,
        message: `Browser closed while waiting for notification: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_NOTIFICATION_TIMEOUT,
    message: `Notification popup did not appear: ${message}`,
  };
}

/**
 * Classify a discovery tool error (list_testids, accessibility_snapshot, describe_screen).
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyDiscoveryError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_PAGE_CLOSED,
        message: `Page closed during discovery: ${message}`,
      };
    }
  }

  for (const pattern of ERROR_PATTERNS.timeout) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_WAIT_TIMEOUT,
        message: `Discovery timed out: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_DISCOVERY_FAILED,
    message: `Discovery failed: ${message}`,
  };
}

/**
 * Classify a screenshot error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyScreenshotError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_PAGE_CLOSED,
        message: `Page closed during screenshot: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_SCREENSHOT_FAILED,
    message: `Screenshot failed: ${message}`,
  };
}

/**
 * Classify a state tool error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyStateError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  for (const pattern of ERROR_PATTERNS.pageClosed) {
    if (message.includes(pattern)) {
      return {
        code: ErrorCodes.MM_PAGE_CLOSED,
        message: `Page closed during state retrieval: ${message}`,
      };
    }
  }

  return {
    code: ErrorCodes.MM_STATE_FAILED,
    message: `State retrieval failed: ${message}`,
  };
}

/**
 * Classify a seeding/contract deployment error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifySeedingError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  if (message.includes('not found') || message.includes('Unknown contract')) {
    return { code: ErrorCodes.MM_CONTRACT_NOT_FOUND, message };
  }

  return {
    code: ErrorCodes.MM_SEED_FAILED,
    message: `Contract operation failed: ${message}`,
  };
}

/**
 * Classify a context switching error.
 *
 * @param error - The error to classify
 * @returns Object with error code and message
 */
export function classifyContextError(error: unknown): {
  code: string;
  message: string;
} {
  const message = extractErrorMessage(error);

  if (message.includes(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED)) {
    return { code: ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED, message };
  }

  return {
    code: ErrorCodes.MM_SET_CONTEXT_FAILED,
    message: `Context switch failed: ${message}`,
  };
}
