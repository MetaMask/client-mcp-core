/**
 * Unit tests for platform gating in runTool.
 *
 * Tests that browser-only tools return clean errors on iOS platform,
 * and that automationPlatform is correctly recorded in step records.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runTool, setPlatformDriver, clearPlatformDriver } from './run-tool.js';
import * as sessionManagerModule from '../session-manager.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import { createMockSessionManager, createMockPage } from '../test-utils';
import { ErrorCodes } from '../types';
import type { IPlatformDriver } from '../../platform/types.js';

describe('platform-gating', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockDriver: IPlatformDriver;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    // Mock knowledge store
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    } as any);

    // Create mock iOS driver that doesn't support mm_clipboard
    mockDriver = {
      isToolSupported: vi.fn((toolName: string) => {
        // iOS doesn't support clipboard tool
        return toolName !== 'mm_clipboard';
      }),
      getPlatform: vi.fn().mockReturnValue('ios'),
      getAppState: vi.fn().mockResolvedValue({}),
      getTestIds: vi.fn().mockResolvedValue([]),
      getAccessibilityTree: vi
        .fn()
        .mockResolvedValue({ nodes: [], refMap: new Map() }),
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPlatformDriver();
  });

  describe('platform gating', () => {
    it('returns MM_TOOL_NOT_SUPPORTED_ON_PLATFORM error when tool is not supported on iOS', async () => {
      // Arrange
      const mockPage = createMockPage();
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

      setPlatformDriver(mockDriver);

      // Act
      const result = await runTool({
        toolName: 'mm_clipboard',
        input: { action: 'read' },
        requiresSession: true,
        execute: async () => {
          return { success: true };
        },
      });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(
          ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
        );
        expect(result.error.message).toContain('mm_clipboard');
        expect(result.error.message).toContain('ios');
        expect(result.error.details?.toolName).toBe('mm_clipboard');
        expect(result.error.details?.platform).toBe('ios');
      }
    });

    it('allows tool execution when tool is supported on iOS', async () => {
      // Arrange
      const mockPage = createMockPage();
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

      setPlatformDriver(mockDriver);

      // Act
      const result = await runTool({
        toolName: 'mm_click',
        input: { testId: 'button' },
        requiresSession: true,
        execute: async () => {
          return { clicked: true, target: 'testId:button' };
        },
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.clicked).toBe(true);
      }
    });

    it('allows all tools on browser platform', async () => {
      // Arrange
      const mockPage = createMockPage();
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

      // Create browser driver that supports all tools
      const browserDriver: IPlatformDriver = {
        isToolSupported: vi.fn().mockReturnValue(true),
        getPlatform: vi.fn().mockReturnValue('browser'),
        getAppState: vi.fn().mockResolvedValue({}),
        getTestIds: vi.fn().mockResolvedValue([]),
        getAccessibilityTree: vi
          .fn()
          .mockResolvedValue({ nodes: [], refMap: new Map() }),
      } as any;

      setPlatformDriver(browserDriver);

      // Act
      const result = await runTool({
        toolName: 'mm_clipboard',
        input: { action: 'read' },
        requiresSession: true,
        execute: async () => {
          return { action: 'read', success: true, text: 'clipboard content' };
        },
      });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.success).toBe(true);
      }
    });

    it('records automationPlatform in step records on success', async () => {
      // Arrange
      const mockPage = createMockPage();
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

      setPlatformDriver(mockDriver);

      const recordStepSpy = vi.spyOn(
        knowledgeStoreModule.knowledgeStore,
        'recordStep',
      );

      // Act
      await runTool({
        toolName: 'mm_click',
        input: { testId: 'button' },
        requiresSession: true,
        execute: async () => {
          return { clicked: true, target: 'testId:button' };
        },
      });

      // Assert
      expect(recordStepSpy).toHaveBeenCalled();
      const callArgs = recordStepSpy.mock.calls[0][0];
      expect(callArgs.automationPlatform).toBe('ios');
    });

    it('records automationPlatform in step records on error', async () => {
      // Arrange
      const mockPage = createMockPage();
      vi.spyOn(mockSessionManager, 'getPage').mockReturnValue(mockPage);
      vi.spyOn(mockSessionManager, 'getRefMap').mockReturnValue(new Map());

      setPlatformDriver(mockDriver);

      const recordStepSpy = vi.spyOn(
        knowledgeStoreModule.knowledgeStore,
        'recordStep',
      );

      // Act
      await runTool({
        toolName: 'mm_click',
        input: { testId: 'button' },
        requiresSession: true,
        execute: async () => {
          throw new Error('Click failed');
        },
      });

      // Assert
      expect(recordStepSpy).toHaveBeenCalled();
      const callArgs = recordStepSpy.mock.calls[0][0];
      expect(callArgs.automationPlatform).toBe('ios');
      expect(callArgs.outcome.ok).toBe(false);
    });
  });
});
