/**
 * Unit tests for interaction tool handlers.
 *
 * Tests handleClick, handleType, and handleWaitFor with various target types,
 * error scenarios, and page closure detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleClick,
  handleType,
  handleWaitFor,
} from './interaction';
import { ErrorCodes } from '../types';
import { createMockSessionManager, createMockPage, createMockLocator } from '../test-utils/index.js';
import * as sessionManagerModule from '../session-manager.js';
import * as discoveryModule from '../discovery.js';
import * as runToolModule from './run-tool.js';
import * as knowledgeStoreModule from '../knowledge-store.js';

describe('interaction', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
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

  describe('handleClick', () => {
    describe('with testId target', () => {
      it('clicks element by testId', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockPage.locator = vi.fn().mockReturnValue(mockLocator);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ testId: 'my-button' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.clicked).toBe(true);
          expect(result.result.target).toBe('testId:my-button');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'my-button',
          expect.any(Map),
          15000,
        );
        expect(mockLocator.click).toHaveBeenCalled();
      });

      it('uses custom timeout when provided', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        await handleClick({ testId: 'my-button', timeoutMs: 5000 });

        // Assert
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'my-button',
          expect.any(Map),
          5000,
        );
      });
    });

    describe('with selector target', () => {
      it('clicks element by CSS selector', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ selector: 'button.primary' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.clicked).toBe(true);
          expect(result.result.target).toBe('selector:button.primary');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'selector',
          'button.primary',
          expect.any(Map),
          15000,
        );
      });
    });

    describe('with a11yRef target', () => {
      it('clicks element by accessibility reference', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        const refMap = new Map([['e5', 'button[aria-label="Submit"]']]);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(refMap);

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ a11yRef: 'e5' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.clicked).toBe(true);
          expect(result.result.target).toBe('a11yRef:e5');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'a11yRef',
          'e5',
          refMap,
          15000,
        );
      });
    });

    describe('with invalid target selection', () => {
      it('returns error when no target specified', async () => {
        // Arrange
        const startTime = Date.now();

        // Act
        const result = await handleClick({} as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });

      it('returns error when multiple targets specified', async () => {
        // Act
        const result = await handleClick({
          testId: 'button',
          selector: '.button',
        } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });
    });

    describe('with page closure after click', () => {
      it('handles page closure gracefully', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockLocator.click = vi.fn().mockRejectedValue(
          new Error('Target page, context or browser has been closed'),
        );
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ testId: 'close-btn' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.clicked).toBe(true);
          expect(result.result.pageClosedAfterClick).toBe(true);
          expect(result.result.target).toBe('testId:close-btn');
        }
      });

      it('handles browser closed error gracefully', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockLocator.click = vi.fn().mockRejectedValue(
          new Error('browser has been closed'),
        );
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ testId: 'close-btn' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.pageClosedAfterClick).toBe(true);
        }
      });
    });

    describe('with click errors', () => {
      it('returns error when click fails with non-closure error', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockLocator.click = vi.fn().mockRejectedValue(
          new Error('Element is not clickable'),
        );
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleClick({ testId: 'my-button' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_CLICK_FAILED);
        }
      });

      it('returns error when element not found', async () => {
        // Arrange
        const mockPage = createMockPage();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
          new Error('Timeout waiting for element'),
        );

        // Act
        const result = await handleClick({ testId: 'nonexistent' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        mockSessionManager.hasActiveSession = vi.fn().mockReturnValue(false);

        // Act
        const result = await handleClick({ testId: 'my-button' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });

  describe('handleType', () => {
    describe('with testId target', () => {
      it('types text into element by testId', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockPage.locator = vi.fn().mockReturnValue(mockLocator);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleType({ testId: 'amount-input', text: '0.5' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.typed).toBe(true);
          expect(result.result.target).toBe('testId:amount-input');
          expect(result.result.textLength).toBe(3);
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'amount-input',
          expect.any(Map),
          15000,
        );
        expect(mockLocator.fill).toHaveBeenCalledWith('0.5');
      });

      it('uses custom timeout when provided', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        await handleType({ testId: 'input', text: 'test', timeoutMs: 3000 });

        // Assert
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'input',
          expect.any(Map),
          3000,
        );
      });
    });

    describe('with selector target', () => {
      it('types text into element by CSS selector', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleType({ selector: 'input[name="email"]', text: 'test@example.com' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.typed).toBe(true);
          expect(result.result.target).toBe('selector:input[name="email"]');
          expect(result.result.textLength).toBe(16);
        }
        expect(mockLocator.fill).toHaveBeenCalledWith('test@example.com');
      });
    });

    describe('with a11yRef target', () => {
      it('types text into element by accessibility reference', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        const refMap = new Map([['e3', 'input[aria-label="Amount"]']]);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(refMap);

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleType({ a11yRef: 'e3', text: '100' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.typed).toBe(true);
          expect(result.result.target).toBe('a11yRef:e3');
          expect(result.result.textLength).toBe(3);
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'a11yRef',
          'e3',
          refMap,
          15000,
        );
      });
    });

    describe('with empty text', () => {
      it('types empty string and reports zero length', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleType({ testId: 'input', text: '' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.typed).toBe(true);
          expect(result.result.textLength).toBe(0);
        }
        expect(mockLocator.fill).toHaveBeenCalledWith('');
      });
    });

    describe('with invalid target selection', () => {
      it('returns error when no target specified', async () => {
        // Act
        const result = await handleType({ text: 'test' } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });

      it('returns error when multiple targets specified', async () => {
        // Act
        const result = await handleType({
          testId: 'input',
          selector: 'input',
          text: 'test',
        } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });
    });

    describe('with type errors', () => {
      it('returns error when fill fails', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockLocator.fill = vi.fn().mockRejectedValue(
          new Error('Element is not editable'),
        );
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleType({ testId: 'input', text: 'test' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TYPE_FAILED);
        }
      });

      it('returns error when element not found', async () => {
        // Arrange
        const mockPage = createMockPage();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
          new Error('Timeout waiting for element'),
        );

        // Act
        const result = await handleType({ testId: 'nonexistent', text: 'test' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        mockSessionManager.hasActiveSession = vi.fn().mockReturnValue(false);

        // Act
        const result = await handleType({ testId: 'input', text: 'test' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });

  describe('handleWaitFor', () => {
    describe('with testId target', () => {
      it('waits for element by testId', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockPage.locator = vi.fn().mockReturnValue(mockLocator);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleWaitFor({ testId: 'loading-spinner' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.found).toBe(true);
          expect(result.result.target).toBe('testId:loading-spinner');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'loading-spinner',
          expect.any(Map),
          15000,
        );
      });

      it('uses custom timeout when provided', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        await handleWaitFor({ testId: 'element', timeoutMs: 30000 });

        // Assert
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'testId',
          'element',
          expect.any(Map),
          30000,
        );
      });
    });

    describe('with selector target', () => {
      it('waits for element by CSS selector', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleWaitFor({ selector: '.success-message' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.found).toBe(true);
          expect(result.result.target).toBe('selector:.success-message');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'selector',
          '.success-message',
          expect.any(Map),
          15000,
        );
      });
    });

    describe('with a11yRef target', () => {
      it('waits for element by accessibility reference', async () => {
        // Arrange
        const mockPage = createMockPage();
        const mockLocator = createMockLocator();
        const refMap = new Map([['e10', 'button[aria-label="Confirm"]']]);
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(refMap);

        vi.spyOn(discoveryModule, 'waitForTarget').mockResolvedValue(mockLocator as any);

        // Act
        const result = await handleWaitFor({ a11yRef: 'e10' });

        // Assert
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result.found).toBe(true);
          expect(result.result.target).toBe('a11yRef:e10');
        }
        expect(discoveryModule.waitForTarget).toHaveBeenCalledWith(
          mockPage,
          'a11yRef',
          'e10',
          refMap,
          15000,
        );
      });
    });

    describe('with invalid target selection', () => {
      it('returns error when no target specified', async () => {
        // Act
        const result = await handleWaitFor({} as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });

      it('returns error when multiple targets specified', async () => {
        // Act
        const result = await handleWaitFor({
          testId: 'element',
          selector: '.element',
        } as any);

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
          expect(result.error.message).toContain('Exactly one');
        }
      });
    });

    describe('with timeout errors', () => {
      it('returns error when element not found within timeout', async () => {
        // Arrange
        const mockPage = createMockPage();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
          new Error('Timeout 15000ms exceeded'),
        );

        // Act
        const result = await handleWaitFor({ testId: 'nonexistent' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
        }
      });

      it('returns error when page closed during wait', async () => {
        // Arrange
        const mockPage = createMockPage();
        mockSessionManager.getPage = vi.fn().mockReturnValue(mockPage);
        mockSessionManager.getRefMap = vi.fn().mockReturnValue(new Map());

        vi.spyOn(discoveryModule, 'waitForTarget').mockRejectedValue(
          new Error('Target page has been closed'),
        );

        // Act
        const result = await handleWaitFor({ testId: 'element' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
        }
      });
    });

    describe('without active session', () => {
      it('returns error when no session active', async () => {
        // Arrange
        mockSessionManager.hasActiveSession = vi.fn().mockReturnValue(false);

        // Act
        const result = await handleWaitFor({ testId: 'element' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
      });
    });
  });
});
