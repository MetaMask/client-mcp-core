/**
 * Unit tests for tool helper functions.
 *
 * Tests session validation, observation collection, error handling, and step recording.
 */

import type { Page } from '@playwright/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  requireActiveSession,
  collectObservation,
  withActiveSession,
  recordToolStep,
  collectObservationAndRecord,
  handleToolError,
} from './helpers';
import type { ObservationLevel, RecordStepParams } from './helpers';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';
import { ErrorCodes } from '../types';

describe('helpers', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('requireActiveSession', () => {
    describe('when no active session exists', () => {
      it('returns error response with NO_ACTIVE_SESSION code', () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
        const startTime = Date.now();

        // Act
        const result = requireActiveSession(startTime);

        // Assert
        expect(result).toBeDefined();
        expect(result?.ok).toBe(false);
        if (result && !result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
          expect(result.error.message).toBe(
            'No active session. Call launch first.',
          );
        }
      });

      it('includes timestamp in error response', () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
        const startTime = Date.now();

        // Act
        const result = requireActiveSession(startTime);

        // Assert
        if (result && !result.ok) {
          expect(result.meta.timestamp).toBeDefined();
        }
      });
    });

    describe('when active session exists', () => {
      it('returns undefined', () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
        const startTime = Date.now();

        // Act
        const result = requireActiveSession(startTime);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('collectObservation', () => {
    describe('when level is "none"', () => {
      it('returns default observation with empty arrays', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'none';
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('does not query extension state', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'none';
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        await collectObservation(mockDriver as any, level);

        // Assert
        expect(mockSessionManager.getExtensionState).not.toHaveBeenCalled();
      });
    });

    describe('when level is "minimal"', () => {
      it('returns observation with state only', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'minimal';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: '0x123',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        };
        mockDriver.getAppState.mockResolvedValue(mockState);
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.state).toStrictEqual(mockState);
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('uses preset state when provided', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'minimal';
        const presetState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-456/home.html',
          extensionId: 'ext-456',
          isUnlocked: false,
          currentScreen: 'unlock' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: presetState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(
          mockDriver as any,
          level,
          presetState,
        );

        // Assert
        expect(mockSessionManager.getExtensionState).not.toHaveBeenCalled();
        expect(result.state).toStrictEqual(presetState);
      });
    });

    describe('when level is "full"', () => {
      it('collects state, testIds, and a11y tree', async () => {
        // Arrange
        const mockDriver = {
          getAppState: vi.fn(),
          getTestIds: vi.fn(),
          getAccessibilityTree: vi.fn(),
        };
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: '0x123',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        };
        const mockTestIds = [
          { testId: 'send-button', tag: 'button', text: 'Send', visible: true },
        ];
        const mockA11yNodes = [
          { ref: 'e1', role: 'button', name: 'Send', path: [] },
        ];
        const mockRefMap = new Map([['e1', '[data-testid="send-button"]']]);

        mockDriver.getAppState.mockResolvedValue(mockState);
        mockDriver.getTestIds.mockResolvedValue(mockTestIds);
        mockDriver.getAccessibilityTree.mockResolvedValue({
          nodes: mockA11yNodes,
          refMap: mockRefMap,
        });
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: mockTestIds,
          a11y: { nodes: mockA11yNodes },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.state).toStrictEqual(mockState);
        expect(result.testIds).toStrictEqual(mockTestIds);
        expect(result.a11y.nodes).toStrictEqual(mockA11yNodes);
        expect(mockSessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
      });

      it('returns default observation when page is undefined', async () => {
        // Arrange
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue(
          mockState,
        );
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(undefined, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('returns default observation when discovery throws error', async () => {
        // Arrange
        const mockDriver = {
          getAppState: vi.fn(),
          getTestIds: vi.fn(),
          getAccessibilityTree: vi.fn(),
        };
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        mockDriver.getAppState.mockResolvedValue(mockState);
        mockDriver.getTestIds.mockRejectedValue(new Error('Page closed'));
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });
    });
  });

  describe('withActiveSession', () => {
    describe('when no active session exists', () => {
      it('returns error response without calling handler', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
        const handler = vi.fn();
        const wrappedHandler = withActiveSession(handler);

        // Act
        const result = await wrappedHandler({ test: 'input' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        }
        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('when session ID is missing', () => {
      it('returns error response', async () => {
        // Arrange
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
        vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(undefined);
        const handler = vi.fn();
        const wrappedHandler = withActiveSession(handler);

        // Act
        const result = await wrappedHandler({ test: 'input' });

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
          expect(result.error.message).toBe('Session ID not found');
        }
        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('when active session exists', () => {
      it('calls handler with input, context, and startTime', async () => {
        // Arrange
        const mockPage = { url: () => 'test-url' } as unknown as Page;
        const mockRefMap = new Map([['e1', '[data-testid="test"]']]);
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
        vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(
          'session-123',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(mockRefMap);

        const handler = vi.fn().mockResolvedValue({
          ok: true,
          ts: Date.now(),
          durationMs: 100,
          result: { success: true },
        });
        const wrappedHandler = withActiveSession(handler);
        const input = { test: 'input' };

        // Act
        const result = await wrappedHandler(input);

        // Assert
        expect(handler).toHaveBeenCalledWith(
          input,
          {
            sessionId: 'session-123',
            page: mockPage,
            refMap: mockRefMap,
          },
          expect.any(Number),
        );
        expect(result.ok).toBe(true);
      });

      it('passes through handler result', async () => {
        // Arrange
        const mockPage = { url: () => 'test-url' } as unknown as Page;
        vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
        vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(
          'session-123',
        );
        vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
        vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

        const expectedResult = {
          ok: true,
          ts: Date.now(),
          durationMs: 100,
          result: { data: 'test-data' },
        };
        const handler = vi.fn().mockResolvedValue(expectedResult);
        const wrappedHandler = withActiveSession(handler);

        // Act
        const result = await wrappedHandler({ test: 'input' });

        // Assert
        expect(result).toStrictEqual(expectedResult);
      });
    });
  });

  describe('recordToolStep', () => {
    it('records step with all parameters', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(
        'session-123',
      );
      const mockRecordStep = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: mockRecordStep,
      } as any);

      const params: RecordStepParams = {
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        startTime: Date.now() - 100,
        observation: {
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        },
        target: { testId: 'send-button' },
        screenshotPath: '/path/to/screenshot.png',
        screenshotDimensions: { width: 1280, height: 720 },
      };

      // Act
      await recordToolStep(params);

      // Assert
      expect(mockRecordStep).toHaveBeenCalledWith({
        sessionId: 'session-123',
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        target: { testId: 'send-button' },
        outcome: { ok: true },
        observation: params.observation,
        durationMs: expect.any(Number),
        screenshotPath: '/path/to/screenshot.png',
        screenshotDimensions: { width: 1280, height: 720 },
      });
    });

    it('uses empty string when session ID is undefined', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(undefined);
      const mockRecordStep = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: mockRecordStep,
      } as any);

      const params: RecordStepParams = {
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        startTime: Date.now(),
        observation: {
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        },
      };

      // Act
      await recordToolStep(params);

      // Assert
      expect(mockRecordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: '',
        }),
      );
    });
  });

  describe('collectObservationAndRecord', () => {
    it('collects observation and records step', async () => {
      // Arrange
      const mockDriver = {
        getAppState: vi.fn(),
        getTestIds: vi.fn(),
        getAccessibilityTree: vi.fn(),
      };
      const mockObservation = {
        state: {} as any,
        testIds: [
          { testId: 'send-button', tag: 'button', text: 'Send', visible: true },
        ],
        a11y: {
          nodes: [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
        },
      };
      const mockRecordStep = vi.fn().mockResolvedValue(undefined);

      vi.spyOn(
        knowledgeStoreModule,
        'createDefaultObservation',
      ).mockReturnValue(mockObservation);
      mockDriver.getAppState.mockResolvedValue(mockObservation.state);
      mockDriver.getTestIds.mockResolvedValue(mockObservation.testIds);
      mockDriver.getAccessibilityTree.mockResolvedValue({
        nodes: mockObservation.a11y.nodes,
        refMap: new Map(),
      });
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: mockRecordStep,
      } as any);
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(
        'session-123',
      );

      // Act
      const result = await collectObservationAndRecord(
        mockDriver as any,
        'mm_click',
        { testId: 'send-button' },
        Date.now(),
        {
          target: { testId: 'send-button' },
          screenshotPath: '/path/to/screenshot.png',
          screenshotDimensions: { width: 1280, height: 720 },
        },
      );

      // Assert
      expect(result).toStrictEqual(mockObservation);
      expect(mockRecordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'mm_click',
          input: { testId: 'send-button' },
          observation: mockObservation,
          target: { testId: 'send-button' },
          screenshotPath: '/path/to/screenshot.png',
          screenshotDimensions: { width: 1280, height: 720 },
        }),
      );
    });

    it('works without optional parameters', async () => {
      // Arrange
      const mockDriver = {
        getAppState: vi.fn(),
        getTestIds: vi.fn(),
        getAccessibilityTree: vi.fn(),
      };
      const mockObservation = {
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      };
      const mockRecordStep = vi.fn().mockResolvedValue(undefined);

      vi.spyOn(
        knowledgeStoreModule,
        'createDefaultObservation',
      ).mockReturnValue(mockObservation);
      mockDriver.getAppState.mockResolvedValue(mockObservation.state);
      mockDriver.getTestIds.mockResolvedValue([]);
      mockDriver.getAccessibilityTree.mockResolvedValue({
        nodes: [],
        refMap: new Map(),
      });
      vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
        recordStep: mockRecordStep,
      } as any);
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(
        'session-123',
      );

      // Act
      const result = await collectObservationAndRecord(
        mockDriver as any,
        'mm_get_state',
        {},
        Date.now(),
      );

      // Assert
      expect(result).toStrictEqual(mockObservation);
      expect(mockRecordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'mm_get_state',
          input: {},
          observation: mockObservation,
          target: undefined,
          screenshotPath: undefined,
          screenshotDimensions: undefined,
        }),
      );
    });
  });

  describe('handleToolError', () => {
    describe('when error contains "Unknown a11yRef"', () => {
      it('returns TARGET_NOT_FOUND error code', () => {
        // Arrange
        const error = new Error('Unknown a11yRef: e99');
        const startTime = Date.now();

        // Act
        const result = handleToolError(
          error,
          ErrorCodes.MM_CLICK_FAILED,
          'Click failed',
          { a11yRef: 'e99' },
          'session-123',
          startTime,
        );

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
          expect(result.error.message).toContain('Unknown a11yRef: e99');
        }
      });
    });

    describe('when error contains "not found"', () => {
      it('returns TARGET_NOT_FOUND error code', () => {
        // Arrange
        const error = new Error('Element not found');
        const startTime = Date.now();

        // Act
        const result = handleToolError(
          error,
          ErrorCodes.MM_TYPE_FAILED,
          'Type failed',
          { testId: 'missing-input' },
          'session-123',
          startTime,
        );

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
          expect(result.error.message).toContain('not found');
        }
      });
    });

    describe('when error does not match special patterns', () => {
      it('returns default error code with combined message', () => {
        // Arrange
        const error = new Error('Timeout exceeded');
        const startTime = Date.now();

        // Act
        const result = handleToolError(
          error,
          ErrorCodes.MM_CLICK_FAILED,
          'Click failed',
          { testId: 'slow-button' },
          'session-123',
          startTime,
        );

        // Assert
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_CLICK_FAILED);
          expect(result.error.message).toBe('Click failed: Timeout exceeded');
        }
      });

      it('includes input in error details', () => {
        // Arrange
        const error = new Error('Generic error');
        const input = { testId: 'test-button', timeoutMs: 5000 };
        const startTime = Date.now();

        // Act
        const result = handleToolError(
          error,
          ErrorCodes.MM_CLICK_FAILED,
          'Click failed',
          input,
          'session-123',
          startTime,
        );

        // Assert
        if (!result.ok) {
          expect(result.error.details).toStrictEqual({ input });
        }
      });

      it('includes session ID in response', () => {
        // Arrange
        const error = new Error('Generic error');
        const startTime = Date.now();

        // Act
        const result = handleToolError(
          error,
          ErrorCodes.MM_CLICK_FAILED,
          'Click failed',
          {},
          'session-456',
          startTime,
        );

        // Assert
        if (!result.ok) {
          expect(result.meta.sessionId).toBe('session-456');
        }
      });
    });
  });
});
