/**
 * Unit tests for screenshot tool handler.
 *
 * Tests handleScreenshot with various options including base64 encoding,
 * selector scoping, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleScreenshot } from './screenshot.js';
import { ErrorCodes } from '../types/errors.js';
import { createMockSessionManager } from '../test-utils/index.js';
import * as sessionManagerModule from '../session-manager.js';
import * as knowledgeStoreModule from '../knowledge-store.js';

describe('screenshot', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      sessionMetadata: {
        schemaVersion: 1,
        sessionId: 'test-session-123',
        createdAt: new Date().toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      },
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
    // Mock knowledge store to prevent "not initialized" errors
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi.fn().mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
      getGitInfoSync: vi.fn().mockReturnValue({ branch: 'main', commit: 'abc123' }),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleScreenshot', () => {
    describe('basic screenshot', () => {
      it('captures full page screenshot by default', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: undefined,
        });

        // Act
        const result = await handleScreenshot({ name: 'test-screenshot' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.path).toBe('/path/to/screenshot.png');
          expect(result.result.width).toBe(1280);
          expect(result.result.height).toBe(720);
          expect(result.result.base64).toBeUndefined();
        }
        expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
          name: 'test-screenshot',
          fullPage: true,
          selector: undefined,
        });
      });

      it('captures viewport-only screenshot when fullPage is false', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: undefined,
        });

        // Act
        const result = await handleScreenshot({
          name: 'viewport-screenshot',
          fullPage: false,
        });

        // Assert
        expect(result.ok).toBe(true);
        expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
          name: 'viewport-screenshot',
          fullPage: false,
          selector: undefined,
        });
      });
    });

    describe('with base64 encoding', () => {
      it('includes base64 when includeBase64 is true', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        });

        // Act
        const result = await handleScreenshot({
          name: 'base64-screenshot',
          includeBase64: true,
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.base64).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        }
      });

      it('excludes base64 when includeBase64 is false', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        });

        // Act
        const result = await handleScreenshot({
          name: 'no-base64-screenshot',
          includeBase64: false,
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.base64).toBeUndefined();
        }
      });
    });

    describe('with selector scoping', () => {
      it('captures screenshot of specific element', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/element-screenshot.png',
          width: 400,
          height: 200,
          base64: undefined,
        });

        // Act
        const result = await handleScreenshot({
          name: 'element-screenshot',
          selector: '[data-testid="account-menu"]',
        });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.width).toBe(400);
          expect(result.result.height).toBe(200);
        }
        expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
          name: 'element-screenshot',
          fullPage: true,
          selector: '[data-testid="account-menu"]',
        });
      });

      it('combines selector with fullPage false', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/element-screenshot.png',
          width: 400,
          height: 200,
          base64: undefined,
        });

        // Act
        const result = await handleScreenshot({
          name: 'element-viewport-screenshot',
          selector: '.modal-content',
          fullPage: false,
        });

        // Assert
        expect(result.ok).toBe(true);
        expect(mockSessionManager.screenshot).toHaveBeenCalledWith({
          name: 'element-viewport-screenshot',
          fullPage: false,
          selector: '.modal-content',
        });
      });
    });

    describe('error handling', () => {
      it('returns error when no active session', async () => {
        // Arrange
        mockSessionManager.hasActiveSession = vi.fn().mockReturnValue(false);

        // Act
        const result = await handleScreenshot({ name: 'test-screenshot' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });

      it('returns error when screenshot fails', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockRejectedValue(
          new Error('Screenshot failed'),
        );

        // Act
        const result = await handleScreenshot({ name: 'test-screenshot' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_SCREENSHOT_FAILED);
          expect(result.error.message).toContain('Screenshot failed');
        }
      });

      it('returns error when page is closed', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockRejectedValue(
          new Error('Target page, context or browser has been closed'),
        );

        // Act
        const result = await handleScreenshot({ name: 'test-screenshot' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_PAGE_CLOSED);
        }
      });
    });

    describe('input sanitization', () => {
      it('sanitizes input for knowledge store recording', async () => {
        // Arrange
        mockSessionManager.screenshot = vi.fn().mockResolvedValue({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: 'very-long-base64-string-that-should-not-be-recorded',
        });

        const recordStepMock = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
          recordStep: recordStepMock,
          getLastSteps: vi.fn().mockResolvedValue([]),
          searchSteps: vi.fn().mockResolvedValue([]),
          summarizeSession: vi.fn().mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
          listSessions: vi.fn().mockResolvedValue([]),
          generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
          writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
          getGitInfoSync: vi.fn().mockReturnValue({ branch: 'main', commit: 'abc123' }),
        } as any);

        // Act
        await handleScreenshot({
          name: 'test-screenshot',
          includeBase64: true,
          selector: '[data-testid="test"]',
        });

        // Assert
        expect(recordStepMock).toHaveBeenCalled();
        const recordedInput = recordStepMock.mock.calls[0][0].input;
        expect(recordedInput).toEqual({
          name: 'test-screenshot',
          fullPage: undefined,
          selector: '[data-testid="test"]',
        });
        expect(recordedInput.includeBase64).toBeUndefined();
      });
    });
  });
});
