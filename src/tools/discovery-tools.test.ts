/**
 * Unit tests for discovery-tools.ts
 *
 * Tests discovery tool handlers:
 * - handleListTestIds: List visible test IDs
 * - handleAccessibilitySnapshot: Get accessibility tree
 * - handleDescribeScreen: Comprehensive screen state
 */

import type { Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accessibilitySnapshotTool,
  describeScreenTool,
  listTestIdsTool,
} from './discovery-tools.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { A11yNodeTrimmed, TestIdItem } from './types';
import { ErrorCodes } from './types/errors.js';
import * as discoveryModule from './utils/discovery.js';
import type { ToolContext } from '../types/http.js';

function createMockPage(): Page {
  return {
    url: vi.fn().mockReturnValue('chrome-extension://ext-123/home.html'),
  } as unknown as Page;
}

function createMockContext(
  options: {
    hasActive?: boolean;
  } = {},
): ToolContext {
  const { hasActive = true } = options;

  return {
    sessionManager: createMockSessionManager({
      hasActive,
      sessionId: 'test-session-123',
      sessionMetadata: {
        schemaVersion: 1,
        sessionId: 'test-session-123',
        createdAt: '2026-02-04T00:00:00.000Z',
        goal: 'Test discovery',
        flowTags: ['discovery'],
        tags: [],
        launch: {
          stateMode: 'default',
        },
      },
    }),
    page: createMockPage(),
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ToolContext;
}

describe('discovery-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listTestIdsTool', () => {
    it('returns list of test IDs with default limit', async () => {
      const context = createMockContext();
      const mockItems: TestIdItem[] = [
        { testId: 'button-1', tag: 'button', text: 'Click', visible: true },
        { testId: 'input-1', tag: 'input', visible: true },
      ];

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockItems);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );

      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.items).toStrictEqual(mockItems);
      }
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        context.page,
        150,
      );
    });

    it('respects custom limit', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([
        { testId: 'item-1', tag: 'div', visible: true },
      ]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );

      const result = await listTestIdsTool({ limit: 50 }, context);

      expect(result.ok).toBe(true);
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        context.page,
        50,
      );
    });

    it('updates refMap in session manager', async () => {
      const context = createMockContext();
      const mockRefMap = new Map([['e1', 'role=button[name="Submit"]']]);

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: mockRefMap,
        },
      );

      await listTestIdsTool({}, context);

      expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
    });

    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('handles discovery errors', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockRejectedValue(
        new Error('Page closed'),
      );

      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
      }
    });
  });

  describe('accessibilitySnapshotTool', () => {
    it('returns accessibility tree with refs', async () => {
      const context = createMockContext();
      const mockNodes: A11yNodeTrimmed[] = [
        { ref: 'e1', role: 'button', name: 'Submit', path: [] },
        { ref: 'e2', role: 'link', name: 'Cancel', path: [] },
      ];
      const mockRefMap = new Map([
        ['e1', 'role=button[name="Submit"]'],
        ['e2', 'role=link[name="Cancel"]'],
      ]);

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: mockNodes,
          refMap: mockRefMap,
        },
      );
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.nodes).toStrictEqual(mockNodes);
      }
    });

    it('uses root selector when provided', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

      await accessibilitySnapshotTool({ rootSelector: '.modal' }, context);

      expect(discoveryModule.collectTrimmedA11ySnapshot).toHaveBeenCalledWith(
        context.page,
        '.modal',
      );
    });

    it('updates refMap in session manager', async () => {
      const context = createMockContext();
      const mockRefMap = new Map([['e1', 'role=button[name="OK"]']]);

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: mockRefMap,
        },
      );
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

      await accessibilitySnapshotTool({}, context);

      expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
    });

    it('collects test ids with observation limit', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

      await accessibilitySnapshotTool({}, context);

      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        context.page,
        50,
      );
    });

    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('handles discovery errors', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockRejectedValue(
        new Error('Discovery failed'),
      );

      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
      }
    });
  });

  describe('describeScreenTool', () => {
    it('returns comprehensive screen state', async () => {
      const context = createMockContext();
      const mockTestIds: TestIdItem[] = [
        { testId: 'button-1', tag: 'button', visible: true },
      ];
      const mockNodes: A11yNodeTrimmed[] = [
        { ref: 'e1', role: 'button', name: 'Submit', path: [] },
      ];

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(
        mockTestIds,
      );
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: mockNodes,
          refMap: new Map([['e1', 'role=button[name="Submit"]']]),
        },
      );

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.state).toBeDefined();
        expect(result.result.testIds.items).toStrictEqual(mockTestIds);
        expect(result.result.a11y.nodes).toStrictEqual(mockNodes);
        expect(result.result.screenshot).toBeNull();
      }
    });

    it('includes screenshot when requested', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );
      vi.mocked(context.sessionManager.screenshot).mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64: 'base64data',
      });

      const result = await describeScreenTool(
        {
          includeScreenshot: true,
          screenshotName: 'test-screen',
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.screenshot).toStrictEqual({
          path: '/path/to/screenshot.png',
          width: 1280,
          height: 720,
          base64: null,
        });
      }
      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'test-screen',
        fullPage: true,
      });
    });

    it('includes base64 in screenshot when requested', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );
      vi.mocked(context.sessionManager.screenshot).mockResolvedValue({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64: 'base64data',
      });

      const result = await describeScreenTool(
        {
          includeScreenshot: true,
          includeScreenshotBase64: true,
        },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.screenshot?.base64).toBe('base64data');
      }
    });

    it('uses default screenshot name when not provided', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );

      await describeScreenTool({ includeScreenshot: true }, context);

      expect(context.sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'describe-screen',
        fullPage: true,
      });
    });

    it('generates prior knowledge from context', async () => {
      const context = createMockContext();
      const mockTestIds: TestIdItem[] = [
        { testId: 'send-btn', tag: 'button', visible: true },
      ];
      const mockNodes: A11yNodeTrimmed[] = [
        { ref: 'e1', role: 'button', name: 'Send', path: [] },
      ];
      const mockPriorKnowledge = {
        schemaVersion: 1 as const,
        generatedAt: '2026-02-04T00:00:00.000Z',
        query: {
          currentScreen: 'home',
          currentUrl: 'chrome-extension://ext-123/home.html',
          visibleTestIds: mockTestIds,
          a11yNodes: mockNodes,
          currentSessionFlowTags: ['discovery'],
        },
        relatedSessions: [],
        similarSteps: [],
        suggestedNextActions: [],
      };

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(
        mockTestIds,
      );
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: mockNodes,
          refMap: new Map([['e1', 'role=button[name="Send"]']]),
        },
      );
      vi.mocked(
        context.knowledgeStore.generatePriorKnowledge,
      ).mockResolvedValue(mockPriorKnowledge as any);

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.priorKnowledge).toStrictEqual(mockPriorKnowledge);
      }
      expect(
        context.knowledgeStore.generatePriorKnowledge,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          currentScreen: 'home',
          visibleTestIds: mockTestIds,
          a11yNodes: mockNodes,
          currentSessionFlowTags: ['discovery'],
        }),
        'test-session-123',
      );
    });

    it('updates refMap in session manager', async () => {
      const context = createMockContext();
      const mockRefMap = new Map([['e1', 'role=button[name="OK"]']]);

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: mockRefMap,
        },
      );

      await describeScreenTool({}, context);

      expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
    });

    it('returns error when no active session', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('handles discovery errors', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockRejectedValue(
        new Error('Page closed'),
      );

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
      }
    });
  });
});
