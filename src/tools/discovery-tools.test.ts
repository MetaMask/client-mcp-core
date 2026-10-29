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
import { PlaywrightPlatformDriver } from '../platform/playwright-driver.js';
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
  const page = createMockPage();
  const sessionManager = createMockSessionManager({
    hasActive,
  });

  return {
    sessionManager,
    page,
    refMap: new Map(),
    workflowContext: {},
    driver: hasActive
      ? new PlaywrightPlatformDriver(() => page, sessionManager as any)
      : undefined,
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

    it('does not take an a11y snapshot or change the refMap (no refs in its result)', async () => {
      const context = createMockContext();
      const setRefMap = vi.fn();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      const snapshot = vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot');

      const result = await listTestIdsTool({}, {
        ...context,
        setRefMap,
      } as ToolContext);

      expect(result).toStrictEqual({ ok: true, result: { items: [] } });
      expect(snapshot).not.toHaveBeenCalled();
      expect(setRefMap).not.toHaveBeenCalled();
      expect(context.sessionManager.setRefMap).not.toHaveBeenCalled();
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

    it('updates refMap after snapshot', async () => {
      const context = createMockContext();
      const refMap = new Map([['e1', 'role=button[name="OK"]']]);

      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [{ ref: 'e1', role: 'button', name: 'OK', path: [] }],
          refMap,
        },
      );

      await accessibilitySnapshotTool({}, context);

      expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(refMap);
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

    it('omits unavailable screenshot dimensions', async () => {
      const context = createMockContext();

      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        {
          nodes: [],
          refMap: new Map(),
        },
      );
      vi.mocked(context.sessionManager.screenshot).mockResolvedValue({
        path: '/path/to/mobile-screenshot.png',
        base64: '',
      });

      const result = await describeScreenTool(
        { includeScreenshot: true },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.screenshot).toStrictEqual({
          path: '/path/to/mobile-screenshot.png',
          base64: null,
        });
      }
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

    it('uses one captureScreen snapshot for test IDs and tree when the driver has it', async () => {
      const context = createMockContext();
      const screenNodes: A11yNodeTrimmed[] = [
        { ref: 'e1', role: 'Button', name: 'Send', path: [] },
      ];
      const screenRefMap = new Map([['e1', 'label:Send|type:Button']]);
      const screenTestIds: TestIdItem[] = [
        { testId: 'wallet-screen', tag: 'View', visible: true },
      ];
      const getTestIds = vi.fn().mockResolvedValue(screenTestIds);
      const captureScreen = vi.fn().mockResolvedValue({
        nodes: screenNodes,
        refMap: screenRefMap,
        getTestIds,
      });
      const driver = {
        getAppState: vi.fn().mockResolvedValue({ isLoaded: true }),
        getTestIds: vi.fn(),
        getAccessibilityTree: vi.fn(),
        captureScreen,
      };

      const result = await describeScreenTool({}, {
        ...context,
        driver,
      } as unknown as ToolContext);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.testIds.items).toStrictEqual(screenTestIds);
        expect(result.result.a11y.nodes).toStrictEqual(screenNodes);
      }
      expect(captureScreen).toHaveBeenCalledTimes(1);
      expect(getTestIds).toHaveBeenCalledWith(150);
      expect(driver.getTestIds).not.toHaveBeenCalled();
      expect(driver.getAccessibilityTree).not.toHaveBeenCalled();
      expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(
        screenRefMap,
      );
    });

    it('reads the app state and captures the screen at the same time', async () => {
      const context = createMockContext();
      const order: string[] = [];
      let releaseState: () => void = () => undefined;
      const driver = {
        getAppState: vi.fn(async () => {
          order.push('state:start');
          await new Promise<void>((resolve) => {
            releaseState = resolve;
          });
          order.push('state:end');
          return { isLoaded: true };
        }),
        captureScreen: vi.fn(async () => {
          order.push('capture:start');
          releaseState();
          return { nodes: [], refMap: new Map(), getTestIds: async () => [] };
        }),
        getTestIds: vi.fn(),
        getAccessibilityTree: vi.fn(),
      };

      const result = await describeScreenTool({}, {
        ...context,
        driver,
      } as unknown as ToolContext);

      expect(result.ok).toBe(true);
      // captureScreen started before getAppState finished.
      expect(order.indexOf('capture:start')).toBeLessThan(
        order.indexOf('state:end'),
      );
    });

    it('stops after captureScreen when the request is aborted', async () => {
      const controller = new AbortController();
      const context = createMockContext();
      const driver = {
        getAppState: vi.fn().mockResolvedValue({ isLoaded: true }),
        captureScreen: vi.fn().mockResolvedValue({
          nodes: [],
          refMap: new Map(),
          getTestIds: vi.fn(async () => {
            controller.abort();
            return [];
          }),
        }),
      };

      const result = await describeScreenTool({}, {
        ...context,
        driver,
        signal: controller.signal,
      } as unknown as ToolContext);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_REQUEST_ABORTED);
      }
      expect(context.sessionManager.setRefMap).not.toHaveBeenCalled();
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

  describe('refs and abort', () => {
    const nodes: A11yNodeTrimmed[] = [
      { ref: 'e1', role: 'button', name: 'Go', path: [] },
    ];
    const refMap = new Map([['e1', 'role=button[name="Go"]']]);

    beforeEach(() => {
      vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
      vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue(
        { nodes, refMap },
      );
    });

    const nodesOf = (result: unknown): A11yNodeTrimmed[] | undefined => {
      const value = (result as { result?: Record<string, unknown> }).result;
      return (
        (value?.nodes as A11yNodeTrimmed[] | undefined) ??
        (value?.a11y as { nodes: A11yNodeTrimmed[] } | undefined)?.nodes
      );
    };

    it.each([
      ['accessibility_snapshot', accessibilitySnapshotTool],
      ['describe_screen', describeScreenTool],
    ] as const)(
      '%s sets refs through sessionManager.setRefMap and returns the tree nodes',
      async (_name, tool) => {
        const context = createMockContext();
        const result = await tool({}, context);

        expect(context.sessionManager.setRefMap).toHaveBeenCalledWith(refMap);
        expect(nodesOf(result)).toStrictEqual(nodes);
      },
    );

    it.each([['describe_screen', describeScreenTool]] as const)(
      '%s stops before the a11y snapshot when the request is aborted',
      async (_name, tool) => {
        const controller = new AbortController();
        const context = createMockContext();
        vi.spyOn(discoveryModule, 'collectTestIds').mockImplementation(
          async () => {
            controller.abort();
            return [];
          },
        );

        const result = await tool({}, {
          ...context,
          signal: controller.signal,
        } as ToolContext);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCodes.MM_REQUEST_ABORTED);
        }
        expect(
          discoveryModule.collectTrimmedA11ySnapshot,
        ).not.toHaveBeenCalled();
        expect(context.sessionManager.setRefMap).not.toHaveBeenCalled();
      },
    );
  });
});
