/**
 * Unit tests for the generic tool execution wrapper (runTool).
 *
 * Tests execution flow, observation collection policies, knowledge store recording,
 * error classification, timeout handling, and page closure detection.
 */

import type { Page } from '@playwright/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runTool } from './run-tool';
import type { ToolExecutionConfig } from './run-tool';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';
import { ErrorCodes } from '../types';
import * as helpersModule from './helpers.js';

describe('runTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockKnowledgeStore: {
    recordStep: ReturnType<typeof vi.fn>;
    getLastSteps: ReturnType<typeof vi.fn>;
    searchSteps: ReturnType<typeof vi.fn>;
    summarizeSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    generatePriorKnowledge: ReturnType<typeof vi.fn>;
    writeSessionMetadata: ReturnType<typeof vi.fn>;
  };
  let mockPage: Page;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      environmentMode: 'e2e',
    });
    mockPage = {
      url: () => 'chrome-extension://test/home.html',
      isClosed: () => false,
    } as unknown as Page;
    vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
    vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    mockKnowledgeStore = {
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    };
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue(
      mockKnowledgeStore as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic execution', () => {
    it('executes tool and returns success response', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<{ value: string }, string> = {
        toolName: 'mm_test_tool',
        input: { value: 'test-input' },
        execute: vi.fn().mockResolvedValue('success'),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBe('success');
        expect(result.meta.sessionId).toBe('test-session-123');
        expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('passes context to execute function', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const executeFn = vi.fn().mockResolvedValue({ result: 'ok' });
      const config: ToolExecutionConfig<{ value: string }, { result: string }> =
        {
          toolName: 'mm_test_tool',
          input: { value: 'test' },
          execute: executeFn,
        };

      // Act
      await runTool(config);

      // Assert
      expect(executeFn).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        page: mockPage,
        refMap: expect.any(Map),
        startTime: expect.any(Number),
      });
    });

    it('handles ToolExecuteResult with custom observation', async () => {
      // Arrange
      const customObservation = {
        state: { isLoaded: true } as any,
        testIds: [{ testId: 'custom', tag: 'div', text: '', visible: true }],
        a11y: { nodes: [] },
      };
      const config: ToolExecutionConfig<object, { data: string }> = {
        toolName: 'mm_test_tool',
        input: {},
        observationPolicy: 'custom',
        execute: vi.fn().mockResolvedValue({
          result: { data: 'test' },
          observation: customObservation,
        }),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({ data: 'test' });
      }
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          observation: customObservation,
        }),
      );
    });
  });

  describe('session validation', () => {
    it('returns error when no active session and requiresSession is true', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_test_tool',
        input: {},
        requiresSession: true,
        execute: vi.fn(),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        expect(result.error.message).toBe(
          'No active session. Call launch first.',
        );
      }
      expect(config.execute).not.toHaveBeenCalled();
    });

    it('executes tool when no active session but requiresSession is false', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
      const executeFn = vi.fn().mockResolvedValue({ done: true });
      const config: ToolExecutionConfig<object, { done: boolean }> = {
        toolName: 'mm_build',
        input: {},
        requiresSession: false,
        execute: executeFn,
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      expect(executeFn).toHaveBeenCalled();
    });

    it('defaults requiresSession to true when not specified', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        execute: vi.fn(),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('observation policies', () => {
    describe('policy: none', () => {
      it('collects minimal observation on success', async () => {
        // Arrange
        const collectObservationSpy = vi
          .spyOn(helpersModule, 'collectObservation')
          .mockResolvedValue({
            state: {} as any,
            testIds: [],
            a11y: { nodes: [] },
          });
        const config: ToolExecutionConfig<object, object> = {
          toolName: 'mm_test_tool',
          input: {},
          observationPolicy: 'none',
          execute: vi.fn().mockResolvedValue({}),
        };

        // Act
        await runTool(config);

        // Assert
        expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'minimal');
      });
    });

    describe('policy: default', () => {
      it('collects full observation on success', async () => {
        // Arrange
        const collectObservationSpy = vi
          .spyOn(helpersModule, 'collectObservation')
          .mockResolvedValue({
            state: {} as any,
            testIds: [],
            a11y: { nodes: [] },
          });
        const config: ToolExecutionConfig<object, object> = {
          toolName: 'mm_test_tool',
          input: {},
          observationPolicy: 'default',
          execute: vi.fn().mockResolvedValue({}),
        };

        // Act
        await runTool(config);

        // Assert
        expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'full');
      });
    });

    describe('policy: failures', () => {
      it('collects minimal observation on success', async () => {
        // Arrange
        const collectObservationSpy = vi
          .spyOn(helpersModule, 'collectObservation')
          .mockResolvedValue({
            state: {} as any,
            testIds: [],
            a11y: { nodes: [] },
          });
        const config: ToolExecutionConfig<object, object> = {
          toolName: 'mm_test_tool',
          input: {},
          observationPolicy: 'failures',
          execute: vi.fn().mockResolvedValue({}),
        };

        // Act
        await runTool(config);

        // Assert
        expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'minimal');
      });

      it('collects full observation on failure', async () => {
        // Arrange
        const collectObservationSpy = vi
          .spyOn(helpersModule, 'collectObservation')
          .mockResolvedValue({
            state: {} as any,
            testIds: [],
            a11y: { nodes: [] },
          });
        const config: ToolExecutionConfig<object, object> = {
          toolName: 'mm_test_tool',
          input: {},
          observationPolicy: 'failures',
          execute: vi.fn().mockRejectedValue(new Error('Test failure')),
        };

        // Act
        await runTool(config);

        // Assert
        expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'full');
      });
    });

    describe('policy: custom', () => {
      it('uses observation from execute result', async () => {
        // Arrange
        const customObservation = {
          state: { isLoaded: true } as any,
          testIds: [],
          a11y: {
            nodes: [{ ref: 'e1', role: 'button', name: 'Test', path: [] }],
          },
        };
        const collectObservationSpy = vi.spyOn(
          helpersModule,
          'collectObservation',
        );
        const config: ToolExecutionConfig<object, { data: string }> = {
          toolName: 'mm_test_tool',
          input: {},
          observationPolicy: 'custom',
          execute: vi.fn().mockResolvedValue({
            result: { data: 'test' },
            observation: customObservation,
          }),
        };

        // Act
        await runTool(config);

        // Assert
        expect(collectObservationSpy).not.toHaveBeenCalled();
        expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith(
          expect.objectContaining({
            observation: customObservation,
          }),
        );
      });
    });

    it('uses options.observationPolicy over config.observationPolicy', async () => {
      // Arrange
      const collectObservationSpy = vi
        .spyOn(helpersModule, 'collectObservation')
        .mockResolvedValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_test_tool',
        input: {},
        observationPolicy: 'default',
        options: { observationPolicy: 'none' },
        execute: vi.fn().mockResolvedValue({}),
      };

      // Act
      await runTool(config);

      // Assert
      expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'minimal');
    });

    it('skips observation collection when requiresSession is false', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(false);
      const collectObservationSpy = vi.spyOn(
        helpersModule,
        'collectObservation',
      );
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_build',
        input: {},
        requiresSession: false,
        observationPolicy: 'default',
        execute: vi.fn().mockResolvedValue({}),
      };

      // Act
      await runTool(config);

      // Assert
      expect(collectObservationSpy).not.toHaveBeenCalled();
    });
  });

  describe('knowledge store recording', () => {
    it('records successful step with all parameters', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<
        { testId: string },
        { clicked: boolean }
      > = {
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        execute: vi.fn().mockResolvedValue({ clicked: true }),
        getTarget: (input) => ({ testId: input.testId }),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        target: { testId: 'send-button' },
        outcome: { ok: true },
        observation: expect.any(Object),
        durationMs: expect.any(Number),
        context: 'e2e',
      });
    });

    it('records failed step with error details', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<{ testId: string }, object> = {
        toolName: 'mm_click',
        input: { testId: 'missing-button' },
        execute: vi.fn().mockRejectedValue(new Error('Element not found')),
        getTarget: (input) => ({ testId: input.testId }),
        classifyError: () => ({
          code: 'MM_TARGET_NOT_FOUND',
          message: 'Element not found',
        }),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        toolName: 'mm_click',
        input: { testId: 'missing-button' },
        target: { testId: 'missing-button' },
        outcome: {
          ok: false,
          error: { code: 'MM_TARGET_NOT_FOUND', message: 'Element not found' },
        },
        observation: expect.any(Object),
        durationMs: expect.any(Number),
        context: 'e2e',
      });
    });

    it('uses sanitizeInputForRecording when provided', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<
        { action: string; text: string },
        { success: boolean }
      > = {
        toolName: 'mm_clipboard',
        input: { action: 'write', text: 'secret-srp-phrase' },
        execute: vi.fn().mockResolvedValue({ success: true }),
        sanitizeInputForRecording: (input) => ({
          action: input.action,
          textLength: input.text.length,
        }),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { action: 'write', textLength: 17 },
        }),
      );
    });

    it('skips recording when sessionId is undefined', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(undefined);
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockResolvedValue({}),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).not.toHaveBeenCalled();
    });
  });

  describe('error classification', () => {
    it('uses classifyError when provided', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        execute: vi
          .fn()
          .mockRejectedValue(new Error('Timeout waiting for selector')),
        classifyError: () => ({
          code: 'MM_WAIT_TIMEOUT',
          message: 'Element wait timeout',
        }),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_WAIT_TIMEOUT');
        expect(result.error.message).toBe('Element wait timeout');
      }
    });

    it('generates default error code when classifyError not provided', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_my_tool',
        input: {},
        execute: vi.fn().mockRejectedValue(new Error('Something went wrong')),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_MY_TOOL_FAILED');
        expect(result.error.message).toBe('Something went wrong');
      }
    });

    it('removes MM_ prefix when generating default error code', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        execute: vi.fn().mockRejectedValue(new Error('Click failed')),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_CLICK_FAILED');
      }
    });
  });

  describe('error handling', () => {
    it('returns error response when execute throws', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<{ testId: string }, object> = {
        toolName: 'mm_click',
        input: { testId: 'test-button' },
        execute: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Execution failed');
        expect(result.error.details).toStrictEqual({
          input: { testId: 'test-button' },
        });
      }
    });

    it('collects full observation on failure with default policy', async () => {
      // Arrange
      const collectObservationSpy = vi
        .spyOn(helpersModule, 'collectObservation')
        .mockResolvedValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        observationPolicy: 'default',
        execute: vi.fn().mockRejectedValue(new Error('Failed')),
      };

      // Act
      await runTool(config);

      // Assert
      expect(collectObservationSpy).toHaveBeenCalledWith(mockPage, 'full');
    });

    it('collects minimal observation on failure with none policy', async () => {
      // Arrange
      const collectObservationSpy = vi
        .spyOn(helpersModule, 'collectObservation')
        .mockResolvedValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        observationPolicy: 'none',
        execute: vi.fn().mockRejectedValue(new Error('Failed')),
      };

      // Act
      await runTool(config);

      // Assert
      expect(collectObservationSpy).toHaveBeenCalledWith(undefined, 'minimal');
    });

    it('handles observation collection failure gracefully', async () => {
      // Arrange
      const collectObservationSpy = vi
        .spyOn(helpersModule, 'collectObservation')
        .mockRejectedValueOnce(new Error('Page closed'))
        .mockResolvedValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        observationPolicy: 'failures',
        execute: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Execution failed');
      }
      expect(collectObservationSpy).toHaveBeenCalled();
    });
  });

  describe('page closure detection', () => {
    it('creates empty observation when page is closed during failure handling', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'hasActiveSession').mockReturnValue(true);
      const collectObservationSpy = vi
        .spyOn(helpersModule, 'collectObservation')
        .mockRejectedValueOnce(
          new Error('Target page, context or browser has been closed'),
        )
        .mockResolvedValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_click',
        input: {},
        observationPolicy: 'default',
        execute: vi.fn().mockRejectedValue(new Error('Click failed')),
      };

      // Act
      await runTool(config);

      // Assert
      expect(collectObservationSpy).toHaveBeenCalledTimes(2);
      expect(collectObservationSpy).toHaveBeenLastCalledWith(
        undefined,
        'minimal',
      );
    });
  });

  describe('timeout handling', () => {
    it('includes duration in response even on timeout error', async () => {
      // Arrange
      vi.useFakeTimers();
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_wait_for',
        input: {},
        execute: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw new Error('Timeout waiting for element');
        }),
        classifyError: () => ({
          code: 'MM_WAIT_TIMEOUT',
          message: 'Wait timeout',
        }),
      };

      // Act
      const resultPromise = runTool(config);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      // Assert
      expect(result.ok).toBe(false);
      expect(result.meta.durationMs).toBe(100);

      // Cleanup
      vi.useRealTimers();
    });
  });

  describe('getTarget function', () => {
    it('extracts target from input when getTarget provided', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<
        { testId?: string; selector?: string; a11yRef?: string },
        object
      > = {
        toolName: 'mm_click',
        input: { testId: 'send-button', selector: '.btn' },
        execute: vi.fn().mockResolvedValue({}),
        getTarget: (input) => ({
          testId: input.testId,
          selector: input.selector,
          a11yRef: input.a11yRef,
        }),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            testId: 'send-button',
            selector: '.btn',
            a11yRef: undefined,
          },
        }),
      );
    });

    it('records undefined target when getTarget not provided', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<{ testId: string }, object> = {
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        execute: vi.fn().mockResolvedValue({}),
      };

      // Act
      await runTool(config);

      // Assert
      expect(mockKnowledgeStore.recordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          target: undefined,
        }),
      );
    });
  });

  describe('isToolExecuteResult type guard', () => {
    it('handles plain result (not ToolExecuteResult)', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, { simple: string }> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockResolvedValue({ simple: 'value' }),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({ simple: 'value' });
      }
    });

    it('handles ToolExecuteResult wrapper', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, { wrapped: string }> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockResolvedValue({
          result: { wrapped: 'value' },
        }),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({ wrapped: 'value' });
      }
    });

    it('handles null result', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, null> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockResolvedValue(null),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBeNull();
      }
    });

    it('handles primitive result', async () => {
      // Arrange
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, string> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockResolvedValue('string-result'),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBe('string-result');
      }
    });
  });

  describe('createEmptyObservation', () => {
    it('creates empty observation when session has no ID on failure', async () => {
      // Arrange
      vi.spyOn(mockSessionManager, 'getSessionId').mockReturnValue(undefined);
      vi.spyOn(helpersModule, 'collectObservation').mockResolvedValue({
        state: {} as any,
        testIds: [],
        a11y: { nodes: [] },
      });
      const config: ToolExecutionConfig<object, object> = {
        toolName: 'mm_test_tool',
        input: {},
        execute: vi.fn().mockRejectedValue(new Error('Failed')),
      };

      // Act
      const result = await runTool(config);

      // Assert
      expect(result.ok).toBe(false);
      expect(mockKnowledgeStore.recordStep).not.toHaveBeenCalled();
    });
  });
});
