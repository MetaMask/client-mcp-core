/**
 * Unit tests for error classification utilities.
 *
 * Tests error pattern matching and classification for various tool handlers.
 */

import { describe, it, expect } from 'vitest';
import {
  isPageClosedError,
  classifyInteractionError,
  classifyClickError,
  classifyTypeError,
  classifyWaitError,
  classifyNavigationError,
  classifyTabError,
  classifyNotificationError,
  classifyDiscoveryError,
  classifyScreenshotError,
  classifyStateError,
  classifySeedingError,
  classifyContextError,
} from './error-classification';
import { ErrorCodes } from '../types';

describe('error-classification', () => {
  describe('isPageClosedError', () => {
    describe('when error indicates page closure', () => {
      it('detects "Target page, context or browser has been closed"', () => {
        // Arrange
        const error = new Error(
          'Target page, context or browser has been closed',
        );

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });

      it('detects "page has been closed"', () => {
        // Arrange
        const error = new Error('page has been closed');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });

      it('detects "context has been closed"', () => {
        // Arrange
        const error = new Error('context has been closed');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });

      it('detects "browser has been closed"', () => {
        // Arrange
        const error = new Error('browser has been closed');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });

      it('detects "Target closed"', () => {
        // Arrange
        const error = new Error('Target closed');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });

      it('detects "Session closed"', () => {
        // Arrange
        const error = new Error('Session closed');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('when error does not indicate page closure', () => {
      it('returns false for generic error', () => {
        // Arrange
        const error = new Error('Something went wrong');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(false);
      });

      it('returns false for timeout error', () => {
        // Arrange
        const error = new Error('Timeout 30000ms exceeded');

        // Act
        const result = isPageClosedError(error);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('classifyInteractionError', () => {
    describe('when error indicates target not found', () => {
      it('returns TARGET_NOT_FOUND for "Unknown a11yRef"', () => {
        // Arrange
        const error = new Error('Unknown a11yRef: e99');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
        expect(result.message).toContain('Unknown a11yRef');
      });

      it('returns TARGET_NOT_FOUND for "not found"', () => {
        // Arrange
        const error = new Error('Element not found');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      });

      it('returns TARGET_NOT_FOUND for "No element found"', () => {
        // Arrange
        const error = new Error('No element found for selector');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      });

      it('returns TARGET_NOT_FOUND for "Timeout waiting for selector"', () => {
        // Arrange
        const error = new Error('Timeout waiting for selector');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT for "Timeout"', () => {
        // Arrange
        const error = new Error('Timeout 30000ms exceeded');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });

      it('returns WAIT_TIMEOUT for "exceeded"', () => {
        // Arrange
        const error = new Error('Time limit exceeded');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });

      it('returns WAIT_TIMEOUT for "timed out"', () => {
        // Arrange
        const error = new Error('Operation timed out');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });
    });

    describe('when error does not match any pattern', () => {
      it('returns fallback code with formatted message', () => {
        // Arrange
        const error = new Error('Unknown error occurred');

        // Act
        const result = classifyInteractionError(error, ErrorCodes.MM_CLICK_FAILED);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_CLICK_FAILED);
        expect(result.message).toContain('Operation failed');
      });
    });
  });

  describe('classifyClickError', () => {
    describe('when error indicates target not found', () => {
      it('returns TARGET_NOT_FOUND code', () => {
        // Arrange
        const error = new Error('not found');

        // Act
        const result = classifyClickError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT code', () => {
        // Arrange
        const error = new Error('Timeout 15000ms exceeded');

        // Act
        const result = classifyClickError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });
    });

    describe('when error does not match patterns', () => {
      it('returns CLICK_FAILED code', () => {
        // Arrange
        const error = new Error('Click failed for unknown reason');

        // Act
        const result = classifyClickError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_CLICK_FAILED);
      });
    });
  });

  describe('classifyTypeError', () => {
    describe('when error indicates target not found', () => {
      it('returns TARGET_NOT_FOUND code', () => {
        // Arrange
        const error = new Error('No element found');

        // Act
        const result = classifyTypeError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT code', () => {
        // Arrange
        const error = new Error('timed out');

        // Act
        const result = classifyTypeError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });
    });

    describe('when error does not match patterns', () => {
      it('returns TYPE_FAILED code', () => {
        // Arrange
        const error = new Error('Type operation failed');

        // Act
        const result = classifyTypeError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TYPE_FAILED);
      });
    });
  });

  describe('classifyWaitError', () => {
    it('always returns WAIT_TIMEOUT code', () => {
      // Arrange
      const error = new Error('Element did not appear');

      // Act
      const result = classifyWaitError(error);

      // Assert
      expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      expect(result.message).toContain('Wait timed out');
    });

    it('includes original error message', () => {
      // Arrange
      const error = new Error('Specific timeout reason');

      // Act
      const result = classifyWaitError(error);

      // Assert
      expect(result.message).toContain('Specific timeout reason');
    });
  });

  describe('classifyNavigationError', () => {
    describe('when error indicates navigation failure', () => {
      it('returns NAVIGATION_FAILED for "Navigation failed"', () => {
        // Arrange
        const error = new Error('Navigation failed: net::ERR_CONNECTION_REFUSED');

        // Act
        const result = classifyNavigationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
      });

      it('returns NAVIGATION_FAILED for "net::ERR"', () => {
        // Arrange
        const error = new Error('net::ERR_ABORTED');

        // Act
        const result = classifyNavigationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT code', () => {
        // Arrange
        const error = new Error('Timeout waiting for navigation');

        // Act
        const result = classifyNavigationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });
    });

    describe('when error indicates page closure', () => {
      it('returns NAVIGATION_FAILED with page closed message', () => {
        // Arrange
        const error = new Error('Target page, context or browser has been closed');

        // Act
        const result = classifyNavigationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
        expect(result.message).toContain('Page closed during navigation');
      });
    });

    describe('when error does not match patterns', () => {
      it('returns NAVIGATION_FAILED with generic message', () => {
        // Arrange
        const error = new Error('Unknown navigation error');

        // Act
        const result = classifyNavigationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
        expect(result.message).toContain('Navigation failed');
      });
    });
  });

  describe('classifyTabError', () => {
    describe('when error indicates tab not found', () => {
      it('returns TAB_NOT_FOUND for "not found"', () => {
        // Arrange
        const error = new Error('Tab not found');

        // Act
        const result = classifyTabError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
      });

      it('returns TAB_NOT_FOUND for "No tab found"', () => {
        // Arrange
        const error = new Error('No tab found with matching criteria');

        // Act
        const result = classifyTabError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_TAB_NOT_FOUND);
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT code', () => {
        // Arrange
        const error = new Error('Timeout waiting for tab');

        // Act
        const result = classifyTabError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      });
    });

    describe('when error indicates page closure', () => {
      it('returns NAVIGATION_FAILED with page closed message', () => {
        // Arrange
        const error = new Error('page has been closed');

        // Act
        const result = classifyTabError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
        expect(result.message).toContain('page closed');
      });
    });

    describe('when error does not match patterns', () => {
      it('returns NAVIGATION_FAILED with generic message', () => {
        // Arrange
        const error = new Error('Tab operation failed');

        // Act
        const result = classifyTabError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NAVIGATION_FAILED);
        expect(result.message).toContain('Tab operation failed');
      });
    });
  });

  describe('classifyNotificationError', () => {
    describe('when error indicates timeout', () => {
      it('returns NOTIFICATION_TIMEOUT code', () => {
        // Arrange
        const error = new Error('Timeout 15000ms exceeded');

        // Act
        const result = classifyNotificationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
        expect(result.message).toContain('Notification popup did not appear');
      });
    });

    describe('when error indicates page closure', () => {
      it('returns NOTIFICATION_TIMEOUT with browser closed message', () => {
        // Arrange
        const error = new Error('browser has been closed');

        // Act
        const result = classifyNotificationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
        expect(result.message).toContain('Browser closed while waiting');
      });
    });

    describe('when error does not match patterns', () => {
      it('returns NOTIFICATION_TIMEOUT with generic message', () => {
        // Arrange
        const error = new Error('Unknown notification error');

        // Act
        const result = classifyNotificationError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_NOTIFICATION_TIMEOUT);
        expect(result.message).toContain('Notification popup did not appear');
      });
    });
  });

  describe('classifyDiscoveryError', () => {
    describe('when error indicates page closure', () => {
      it('returns PAGE_CLOSED code', () => {
        // Arrange
        const error = new Error('Target page, context or browser has been closed');

        // Act
        const result = classifyDiscoveryError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
        expect(result.message).toContain('Page closed during discovery');
      });
    });

    describe('when error indicates timeout', () => {
      it('returns WAIT_TIMEOUT code', () => {
        // Arrange
        const error = new Error('Timeout 30000ms exceeded');

        // Act
        const result = classifyDiscoveryError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
        expect(result.message).toContain('Discovery timed out');
      });
    });

    describe('when error does not match patterns', () => {
      it('returns DISCOVERY_FAILED code', () => {
        // Arrange
        const error = new Error('Discovery operation failed');

        // Act
        const result = classifyDiscoveryError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_DISCOVERY_FAILED);
        expect(result.message).toContain('Discovery failed');
      });
    });
  });

  describe('classifyScreenshotError', () => {
    describe('when error indicates page closure', () => {
      it('returns PAGE_CLOSED code', () => {
        // Arrange
        const error = new Error('context has been closed');

        // Act
        const result = classifyScreenshotError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
        expect(result.message).toContain('Page closed during screenshot');
      });
    });

    describe('when error does not indicate page closure', () => {
      it('returns SCREENSHOT_FAILED code', () => {
        // Arrange
        const error = new Error('Screenshot operation failed');

        // Act
        const result = classifyScreenshotError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_SCREENSHOT_FAILED);
        expect(result.message).toContain('Screenshot failed');
      });
    });
  });

  describe('classifyStateError', () => {
    describe('when error indicates page closure', () => {
      it('returns PAGE_CLOSED code', () => {
        // Arrange
        const error = new Error('Session closed');

        // Act
        const result = classifyStateError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
        expect(result.message).toContain('Page closed during state retrieval');
      });
    });

    describe('when error does not indicate page closure', () => {
      it('returns STATE_FAILED code', () => {
        // Arrange
        const error = new Error('State retrieval failed');

        // Act
        const result = classifyStateError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_STATE_FAILED);
        expect(result.message).toContain('State retrieval failed');
      });
    });
  });

  describe('classifySeedingError', () => {
    describe('when error indicates contract not found', () => {
      it('returns CONTRACT_NOT_FOUND for "not found"', () => {
        // Arrange
        const error = new Error('Contract not found');

        // Act
        const result = classifySeedingError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_CONTRACT_NOT_FOUND);
      });

      it('returns CONTRACT_NOT_FOUND for "Unknown contract"', () => {
        // Arrange
        const error = new Error('Unknown contract: MyToken');

        // Act
        const result = classifySeedingError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_CONTRACT_NOT_FOUND);
      });
    });

    describe('when error does not match patterns', () => {
      it('returns SEED_FAILED code', () => {
        // Arrange
        const error = new Error('Deployment failed');

        // Act
        const result = classifySeedingError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.message).toContain('Contract operation failed');
      });
    });
  });

  describe('classifyContextError', () => {
    describe('when error indicates context switch blocked', () => {
      it('returns CONTEXT_SWITCH_BLOCKED code', () => {
        // Arrange
        const error = new Error(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);

        // Act
        const result = classifyContextError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_CONTEXT_SWITCH_BLOCKED);
      });
    });

    describe('when error does not indicate blocked context', () => {
      it('returns SET_CONTEXT_FAILED code', () => {
        // Arrange
        const error = new Error('Context switch failed');

        // Act
        const result = classifyContextError(error);

        // Assert
        expect(result.code).toBe(ErrorCodes.MM_SET_CONTEXT_FAILED);
        expect(result.message).toContain('Context switch failed');
      });
    });
  });
});
