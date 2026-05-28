import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  listTestIdsTool,
  accessibilitySnapshotTool,
  describeScreenTool,
} from './discovery-tools.js';
import {
  clickTool,
  getTextTool,
  typeTool,
  waitForTool,
} from './interaction.js';
import { screenshotTool } from './screenshot.js';
import { getStateTool } from './state.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { ToolContext } from '../types/http.js';

function createMockDriver(
  overrides: Partial<IPlatformDriver> = {},
): IPlatformDriver {
  return {
    click: vi.fn().mockResolvedValue({ clicked: true, target: 'testId:btn' }),
    type: vi.fn().mockResolvedValue({
      typed: true,
      target: 'testId:input',
      textLength: 5,
    }),
    waitForElement: vi.fn().mockResolvedValue(undefined),
    getText: vi
      .fn()
      .mockResolvedValue({ text: 'hello', target: 'testId:el', length: 5 }),
    getAccessibilityTree: vi.fn().mockResolvedValue({
      nodes: [{ ref: 'e1', role: 'button', name: 'OK', path: [] }],
      refMap: new Map([['e1', 'role=button[name="OK"]']]),
    }),
    getTestIds: vi
      .fn()
      .mockResolvedValue([{ testId: 'submit', tag: 'button', visible: true }]),
    screenshot: vi.fn().mockResolvedValue({
      path: '/tmp/shot.png',
      base64: 'abc',
      width: 400,
      height: 800,
    }),
    getAppState: vi.fn().mockResolvedValue({
      isLoaded: true,
      currentUrl: '',
      extensionId: 'test',
      isUnlocked: true,
      currentScreen: 'home',
      accountAddress: null,
      networkName: null,
      chainId: null,
      balance: null,
    }),
    isToolSupported: vi.fn().mockReturnValue(true),
    getCurrentUrl: vi.fn().mockReturnValue(''),
    getPlatform: vi.fn().mockReturnValue('ios'),
    ...overrides,
  };
}

function createMockPage() {
  return {
    url: vi.fn().mockReturnValue('chrome-extension://test/home.html'),
    isClosed: vi.fn().mockReturnValue(false),
  };
}

function createContextWithDriver(driver: IPlatformDriver): ToolContext {
  const page = createMockPage();
  const sessionManager = createMockSessionManager({ hasActive: true });
  vi.spyOn(sessionManager as any, 'getPage').mockReturnValue(page);
  return {
    sessionManager,
    page: page as any,
    refMap: new Map(),
    workflowContext: {} as any,
    knowledgeStore: {
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    } as any,
    toolRegistry: new Map(),
    driver,
  } as unknown as ToolContext;
}

function createContextWithoutDriver(): ToolContext {
  const page = createMockPage();
  const sessionManager = createMockSessionManager({ hasActive: true });
  vi.spyOn(sessionManager as any, 'getPage').mockReturnValue(page);
  return {
    sessionManager,
    page: page as any,
    refMap: new Map(),
    workflowContext: {} as any,
    knowledgeStore: {
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    } as any,
    toolRegistry: new Map(),
    driver: undefined,
  } as unknown as ToolContext;
}

describe('tool delegation to context.driver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no driver with active session', () => {
    it('clickTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await clickTool({ testId: 'btn' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
        expect(result.error.message).toContain('platform driver');
      }
    });

    it('typeTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await typeTool(
        { testId: 'input', text: 'hello' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('waitForTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await waitForTool({ testId: 'el' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('getTextTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await getTextTool({ testId: 'label' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('listTestIdsTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('accessibilitySnapshotTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('describeScreenTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('screenshotTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await screenshotTool({ name: 'test' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('getStateTool returns error when driver is undefined', async () => {
      const context = createContextWithoutDriver();
      const result = await getStateTool({} as any, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });
  });

  describe('interaction tools', () => {
    it('clickTool delegates to driver.click', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await clickTool({ testId: 'btn' }, context);

      expect(result.ok).toBe(true);
      expect(driver.click).toHaveBeenCalledWith(
        'testId',
        'btn',
        expect.any(Map),
        expect.any(Number),
        undefined,
      );
    });

    it('typeTool delegates to driver.type', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await typeTool(
        { testId: 'input', text: 'hello' },
        context,
      );

      expect(result.ok).toBe(true);
      expect(driver.type).toHaveBeenCalledWith(
        'testId',
        'input',
        'hello',
        expect.any(Map),
        expect.any(Number),
        undefined,
      );
    });

    it('waitForTool delegates to driver.waitForElement', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await waitForTool({ testId: 'spinner' }, context);

      expect(result.ok).toBe(true);
      expect(driver.waitForElement).toHaveBeenCalledOnce();
    });

    it('getTextTool delegates to driver.getText', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await getTextTool({ testId: 'label' }, context);

      expect(result.ok).toBe(true);
      expect(driver.getText).toHaveBeenCalledOnce();
    });

    it('clickTool maps timeout errors to MM_CLICK_TIMEOUT', async () => {
      const driver = createMockDriver({
        click: vi
          .fn()
          .mockRejectedValue(
            new Error('Timeout 15000ms exceeded waiting for element'),
          ),
      });
      const context = createContextWithDriver(driver);

      const result = await clickTool({ testId: 'slow-btn' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CLICK_TIMEOUT);
      }
    });

    it('clickTool maps target-not-found errors to MM_TARGET_NOT_FOUND', async () => {
      const driver = createMockDriver({
        click: vi.fn().mockRejectedValue(new Error('Unknown a11yRef: e99')),
      });
      const context = createContextWithDriver(driver);

      const result = await clickTool({ a11yRef: 'e99' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TARGET_NOT_FOUND);
      }
    });

    it('typeTool maps timeout errors to MM_TYPE_TIMEOUT', async () => {
      const driver = createMockDriver({
        type: vi
          .fn()
          .mockRejectedValue(
            new Error('Timeout 15000ms exceeded waiting for element'),
          ),
      });
      const context = createContextWithDriver(driver);

      const result = await typeTool(
        { testId: 'slow-input', text: 'hello' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TYPE_TIMEOUT);
      }
    });

    it('typeTool classifies fill errors', async () => {
      const driver = createMockDriver({
        type: vi.fn().mockRejectedValue(new Error('Fill failed: detached')),
      });
      const context = createContextWithDriver(driver);

      const result = await typeTool(
        { testId: 'input', text: 'hello' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_TYPE_FAILED);
      }
    });

    it('waitForTool maps timeout errors to MM_WAIT_TIMEOUT', async () => {
      const driver = createMockDriver({
        waitForElement: vi
          .fn()
          .mockRejectedValue(
            new Error('Timeout 10000ms exceeded waiting for element'),
          ),
      });
      const context = createContextWithDriver(driver);

      const result = await waitForTool({ testId: 'spinner' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_WAIT_TIMEOUT);
      }
    });

    it('getTextTool maps timeout errors to MM_GETTEXT_TIMEOUT', async () => {
      const driver = createMockDriver({
        getText: vi
          .fn()
          .mockRejectedValue(
            new Error('Timeout 15000ms exceeded waiting for element'),
          ),
      });
      const context = createContextWithDriver(driver);

      const result = await getTextTool({ testId: 'label' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_GETTEXT_TIMEOUT);
      }
    });

    it('getTextTool classifies getText errors', async () => {
      const driver = createMockDriver({
        getText: vi
          .fn()
          .mockRejectedValue(new Error('textContent failed: detached')),
      });
      const context = createContextWithDriver(driver);

      const result = await getTextTool({ testId: 'label' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_GETTEXT_FAILED);
      }
    });
  });

  describe('discovery tools', () => {
    it('listTestIdsTool delegates to driver.getTestIds', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(true);
      expect(driver.getTestIds).toHaveBeenCalledOnce();
      expect(driver.getAccessibilityTree).toHaveBeenCalledOnce();
    });

    it('accessibilitySnapshotTool delegates to driver.getAccessibilityTree', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(true);
      expect(driver.getAccessibilityTree).toHaveBeenCalledOnce();
    });

    it('describeScreenTool delegates to driver for state, testIds, and a11y', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(true);
      expect(driver.getAppState).toHaveBeenCalledOnce();
      expect(driver.getTestIds).toHaveBeenCalledOnce();
      expect(driver.getAccessibilityTree).toHaveBeenCalledOnce();
    });

    it('describeScreenTool handles getPage failure gracefully', async () => {
      const driver = createMockDriver();
      const sessionManager = createMockSessionManager({ hasActive: true });
      vi.spyOn(sessionManager as any, 'getPage').mockImplementation(() => {
        throw new Error('No page on mobile');
      });
      const context = {
        sessionManager,
        page: {} as any,
        refMap: new Map(),
        workflowContext: {} as any,
        knowledgeStore: {
          generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
        } as any,
        toolRegistry: new Map(),
        driver,
      } as unknown as ToolContext;

      const result = await describeScreenTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.activeTab).toBeUndefined();
      }
    });

    it('listTestIdsTool returns error when driver throws', async () => {
      const driver = createMockDriver({
        getTestIds: vi.fn().mockRejectedValue(new Error('Snapshot failed')),
      });
      const context = createContextWithDriver(driver);

      const result = await listTestIdsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_DISCOVERY_FAILED);
      }
    });

    it('accessibilitySnapshotTool returns error when driver throws', async () => {
      const driver = createMockDriver({
        getAccessibilityTree: vi
          .fn()
          .mockRejectedValue(new Error('A11y snapshot failed')),
      });
      const context = createContextWithDriver(driver);

      const result = await accessibilitySnapshotTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_DISCOVERY_FAILED);
      }
    });
  });

  describe('screenshot tool', () => {
    it('screenshotTool delegates to driver.screenshot', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await screenshotTool({ name: 'test' }, context);

      expect(result.ok).toBe(true);
      expect(driver.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test',
        }),
      );
    });

    it('screenshotTool returns error when driver throws', async () => {
      const driver = createMockDriver({
        screenshot: vi
          .fn()
          .mockRejectedValue(new Error('Screenshot capture failed')),
      });
      const context = createContextWithDriver(driver);

      const result = await screenshotTool({ name: 'fail' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SCREENSHOT_FAILED);
      }
    });
  });

  describe('state tool', () => {
    it('getStateTool delegates to driver.getAppState', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await getStateTool({} as any, context);

      expect(result.ok).toBe(true);
      expect(driver.getAppState).toHaveBeenCalledOnce();
    });

    it('getStateTool handles getPage failure gracefully', async () => {
      const driver = createMockDriver();
      const sessionManager = createMockSessionManager({ hasActive: true });
      vi.spyOn(sessionManager as any, 'getPage').mockImplementation(() => {
        throw new Error('No page on mobile');
      });
      const context = {
        sessionManager,
        page: {} as any,
        refMap: new Map(),
        workflowContext: {} as any,
        knowledgeStore: {
          generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
        } as any,
        toolRegistry: new Map(),
        driver,
      } as unknown as ToolContext;

      const result = await getStateTool({} as any, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.tabs.active.role).toBe('other');
        expect(result.result.tabs.active.url).toBe('');
      }
    });

    it('getStateTool uses driver.getAppState when no stateSnapshotCapability', async () => {
      const driver = createMockDriver({
        getPlatform: vi.fn().mockReturnValue('browser'),
      });
      const context = createContextWithDriver(driver);

      const result = await getStateTool({} as any, context);

      expect(result.ok).toBe(true);
      expect(driver.getAppState).toHaveBeenCalledOnce();
    });

    it('getStateTool returns error when driver throws', async () => {
      const driver = createMockDriver({
        getAppState: vi
          .fn()
          .mockRejectedValue(new Error('State retrieval failed')),
      });
      const context = createContextWithDriver(driver);

      const result = await getStateTool({} as any, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_STATE_FAILED);
      }
    });
  });
});
