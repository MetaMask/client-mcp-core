/**
 * Unit tests for discovery-tools.ts
 *
 * Tests discovery tool handlers:
 * - handleListTestIds: List visible test IDs
 * - handleAccessibilitySnapshot: Get accessibility tree
 * - handleDescribeScreen: Comprehensive screen state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from '@playwright/test';
import {
  handleListTestIds,
  handleAccessibilitySnapshot,
  handleDescribeScreen,
} from './discovery-tools.js';
import * as discoveryModule from '../discovery.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils/mock-factories.js';
import type { TestIdItem, A11yNodeTrimmed, RawA11yNode } from '../types';

/**
 * Create mock Page for testing
 */
function createMockPage(): Page {
  return {
    url: vi.fn().mockReturnValue('chrome-extension://ext-123/home.html'),
  } as unknown as Page;
}

beforeEach(() => {
  vi.clearAllMocks();

  const mockSessionManager = createMockSessionManager({
    hasActive: true,
    sessionId: 'test-session-123',
    sessionMetadata: {
      schemaVersion: 1,
      sessionId: 'test-session-123',
      createdAt: '2026-02-04T00:00:00.000Z',
      goal: 'Test discovery',
      flowTags: ['discovery'],
      tags: [],
      git: { branch: 'main', commit: 'abc123' },
      launch: {
        stateMode: 'default' as const,
      },
    },
  });

  mockSessionManager.getPage = vi.fn().mockReturnValue(createMockPage());

  vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
    mockSessionManager,
  );

  vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
    recordStep: vi.fn().mockResolvedValue(undefined),
    getLastSteps: vi.fn().mockResolvedValue([]),
    searchSteps: vi.fn().mockResolvedValue([]),
    summarizeSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      stepCount: 0,
      recipe: [],
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    writeSessionMetadata: vi.fn().mockResolvedValue('test-session-123'),
    getGitInfoSync: vi.fn().mockReturnValue({
      branch: 'main',
      commit: 'abc123',
    }),
  } as any);
});

describe('handleListTestIds', () => {
  it('returns list of test IDs with default limit', async () => {
    const mockItems: TestIdItem[] = [
      { testId: 'button-1', tag: 'button', text: 'Click', visible: true },
      { testId: 'input-1', tag: 'input', visible: true },
    ];

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockItems);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const result = await handleListTestIds({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.items).toEqual(mockItems);
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        expect.anything(),
        150,
      );
    }
  });

  it('respects custom limit', async () => {
    const mockItems: TestIdItem[] = [
      { testId: 'item-1', tag: 'div', visible: true },
    ];

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockItems);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const result = await handleListTestIds({ limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(discoveryModule.collectTestIds).toHaveBeenCalledWith(
        expect.anything(),
        50,
      );
    }
  });

  it('updates refMap in session manager', async () => {
    const mockRefMap = new Map([['e1', 'role=button[name="Submit"]']]);

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: mockRefMap,
    });

    const sessionManager = sessionManagerModule.getSessionManager();

    await handleListTestIds({});

    expect(sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
  });

  it('records step to knowledge store', async () => {
    const mockItems: TestIdItem[] = [
      { testId: 'test-1', tag: 'button', visible: true },
    ];

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockItems);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const knowledgeStore = knowledgeStoreModule.knowledgeStore;

    await handleListTestIds({});

    expect(knowledgeStore.recordStep).toHaveBeenCalled();
  });

  it('returns error when no active session', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: false });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleListTestIds({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_NO_ACTIVE_SESSION');
    }
  });

  it('handles discovery errors', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockRejectedValue(
      new Error('Page closed'),
    );

    const result = await handleListTestIds({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
    }
  });
});

describe('handleAccessibilitySnapshot', () => {
  it('returns accessibility tree with refs', async () => {
    const mockNodes: A11yNodeTrimmed[] = [
      { ref: 'e1', role: 'button', name: 'Submit', path: [] },
      { ref: 'e2', role: 'link', name: 'Cancel', path: [] },
    ];
    const mockRefMap = new Map([
      ['e1', 'role=button[name="Submit"]'],
      ['e2', 'role=link[name="Cancel"]'],
    ]);

    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: mockNodes,
      refMap: mockRefMap,
    });
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

    const result = await handleAccessibilitySnapshot({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toEqual(mockNodes);
    }
  });

  it('uses root selector when provided', async () => {
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

    await handleAccessibilitySnapshot({ rootSelector: '.modal' });

    expect(discoveryModule.collectTrimmedA11ySnapshot).toHaveBeenCalledWith(
      expect.anything(),
      '.modal',
    );
  });

  it('updates refMap in session manager', async () => {
    const mockRefMap = new Map([['e1', 'role=button[name="OK"]']]);

    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: mockRefMap,
    });
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

    const sessionManager = sessionManagerModule.getSessionManager();

    await handleAccessibilitySnapshot({});

    expect(sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
  });

  it('records step to knowledge store', async () => {
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);

    const knowledgeStore = knowledgeStoreModule.knowledgeStore;

    await handleAccessibilitySnapshot({});

    expect(knowledgeStore.recordStep).toHaveBeenCalled();
  });

  it('returns error when no active session', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: false });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleAccessibilitySnapshot({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_NO_ACTIVE_SESSION');
    }
  });

  it('handles discovery errors', async () => {
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockRejectedValue(
      new Error('Discovery failed'),
    );

    const result = await handleAccessibilitySnapshot({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
    }
  });
});

describe('handleDescribeScreen', () => {
  it('returns comprehensive screen state', async () => {
    const mockTestIds: TestIdItem[] = [
      { testId: 'button-1', tag: 'button', visible: true },
    ];
    const mockNodes: A11yNodeTrimmed[] = [
      { ref: 'e1', role: 'button', name: 'Submit', path: [] },
    ];

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockTestIds);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: mockNodes,
      refMap: new Map([['e1', 'role=button[name="Submit"]']]),
    });

    const result = await handleDescribeScreen({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.state).toBeDefined();
      expect(result.result.testIds.items).toEqual(mockTestIds);
      expect(result.result.a11y.nodes).toEqual(mockNodes);
      expect(result.result.screenshot).toBeNull();
    }
  });

  it('includes screenshot when requested', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const sessionManager = sessionManagerModule.getSessionManager();
    sessionManager.screenshot = vi.fn().mockResolvedValue({
      path: '/path/to/screenshot.png',
      width: 1280,
      height: 720,
      base64: 'base64data',
    });

    const result = await handleDescribeScreen({
      includeScreenshot: true,
      screenshotName: 'test-screen',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.screenshot).toEqual({
        path: '/path/to/screenshot.png',
        width: 1280,
        height: 720,
        base64: null,
      });
      expect(sessionManager.screenshot).toHaveBeenCalledWith({
        name: 'test-screen',
        fullPage: true,
      });
    }
  });

  it('includes base64 in screenshot when requested', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const sessionManager = sessionManagerModule.getSessionManager();
    sessionManager.screenshot = vi.fn().mockResolvedValue({
      path: '/path/to/screenshot.png',
      width: 1280,
      height: 720,
      base64: 'base64data',
    });

    const result = await handleDescribeScreen({
      includeScreenshot: true,
      includeScreenshotBase64: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.screenshot?.base64).toBe('base64data');
    }
  });

  it('uses default screenshot name when not provided', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const sessionManager = sessionManagerModule.getSessionManager();
    sessionManager.screenshot = vi.fn().mockResolvedValue({
      path: '/path/to/screenshot.png',
      width: 1280,
      height: 720,
    });

    await handleDescribeScreen({ includeScreenshot: true });

    expect(sessionManager.screenshot).toHaveBeenCalledWith({
      name: 'describe-screen',
      fullPage: true,
    });
  });

  it('generates prior knowledge from context', async () => {
    const mockTestIds: TestIdItem[] = [
      { testId: 'send-btn', tag: 'button', visible: true },
    ];
    const mockNodes: A11yNodeTrimmed[] = [
      { ref: 'e1', role: 'button', name: 'Send', path: [] },
    ];

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue(mockTestIds);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: mockNodes,
      refMap: new Map([['e1', 'role=button[name="Send"]']]),
    });

    const mockPriorKnowledge = {
      version: 1 as const,
      hints: [{ type: 'similar_flow' as const, content: 'Previous send flow' }],
    };

    const knowledgeStore = knowledgeStoreModule.knowledgeStore;
    knowledgeStore.generatePriorKnowledge = vi
      .fn()
      .mockResolvedValue(mockPriorKnowledge);

    const result = await handleDescribeScreen({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.priorKnowledge).toEqual(mockPriorKnowledge);
      expect(knowledgeStore.generatePriorKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          currentScreen: 'home',
          visibleTestIds: mockTestIds,
          a11yNodes: mockNodes,
          currentSessionFlowTags: ['discovery'],
        }),
        'test-session-123',
      );
    }
  });

  it('updates refMap in session manager', async () => {
    const mockRefMap = new Map([['e1', 'role=button[name="OK"]']]);

    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: mockRefMap,
    });

    const sessionManager = sessionManagerModule.getSessionManager();

    await handleDescribeScreen({});

    expect(sessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
  });

  it('records step to knowledge store', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockResolvedValue([]);
    vi.spyOn(discoveryModule, 'collectTrimmedA11ySnapshot').mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    const knowledgeStore = knowledgeStoreModule.knowledgeStore;

    await handleDescribeScreen({});

    expect(knowledgeStore.recordStep).toHaveBeenCalled();
  });

  it('returns error when no active session', async () => {
    const mockSessionManager = createMockSessionManager({ hasActive: false });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );

    const result = await handleDescribeScreen({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_NO_ACTIVE_SESSION');
    }
  });

  it('handles discovery errors', async () => {
    vi.spyOn(discoveryModule, 'collectTestIds').mockRejectedValue(
      new Error('Page closed'),
    );

    const result = await handleDescribeScreen({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MM_DISCOVERY_FAILED');
    }
  });
});
