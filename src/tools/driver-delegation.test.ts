import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  clickTool,
  getTextTool,
  typeTool,
  waitForTool,
} from './interaction.js';
import {
  listTestIdsTool,
  accessibilitySnapshotTool,
} from './discovery-tools.js';
import { screenshotTool } from './screenshot.js';
import { getStateTool } from './state.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { ToolContext } from '../types/http.js';

function createMockDriver(overrides: Partial<IPlatformDriver> = {}): IPlatformDriver {
  return {
    click: vi.fn().mockResolvedValue({ clicked: true, target: 'testId:btn' }),
    type: vi.fn().mockResolvedValue({ typed: true, target: 'testId:input', textLength: 5 }),
    waitForElement: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn().mockResolvedValue({ text: 'hello', target: 'testId:el', length: 5 }),
    getAccessibilityTree: vi.fn().mockResolvedValue({
      nodes: [{ ref: 'e1', role: 'button', name: 'OK', path: [] }],
      refMap: new Map([['e1', 'role=button[name="OK"]']]),
    }),
    getTestIds: vi.fn().mockResolvedValue([
      { testId: 'submit', tag: 'button', visible: true },
    ]),
    screenshot: vi.fn().mockResolvedValue({
      path: '/tmp/shot.png', base64: 'abc', width: 400, height: 800,
    }),
    getAppState: vi.fn().mockResolvedValue({
      isLoaded: true, currentUrl: '', extensionId: 'test',
      isUnlocked: true, currentScreen: 'home',
      accountAddress: null, networkName: null, chainId: null, balance: null,
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

function createContextWithDriver(
  driver: IPlatformDriver,
): ToolContext {
  const page = createMockPage();
  const sessionManager = createMockSessionManager({ hasActive: true });
  (sessionManager as any).getPage = vi.fn().mockReturnValue(page);
  return {
    sessionManager,
    page: page as any,
    refMap: new Map(),
    workflowContext: {} as any,
    knowledgeStore: { generatePriorKnowledge: vi.fn().mockResolvedValue(undefined) } as any,
    toolRegistry: new Map(),
    driver,
  } as unknown as ToolContext;
}

describe('tool delegation to context.driver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('interaction tools', () => {
    it('clickTool delegates to driver.click', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await clickTool({ testId: 'btn' }, context);

      expect(result.ok).toBe(true);
      expect(driver.click).toHaveBeenCalledWith(
        'testId', 'btn', expect.any(Map), expect.any(Number), undefined,
      );
    });

    it('typeTool delegates to driver.type', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await typeTool({ testId: 'input', text: 'hello' }, context);

      expect(result.ok).toBe(true);
      expect(driver.type).toHaveBeenCalledWith(
        'testId', 'input', 'hello', expect.any(Map), expect.any(Number), undefined,
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

    it('clickTool classifies driver errors', async () => {
      const driver = createMockDriver({
        click: vi.fn().mockRejectedValue(new Error('Element not found: testId:missing')),
      });
      const context = createContextWithDriver(driver);

      const result = await clickTool({ testId: 'missing' }, context);

      expect(result.ok).toBe(false);
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
  });

  describe('screenshot tool', () => {
    it('screenshotTool delegates to driver.screenshot', async () => {
      const driver = createMockDriver();
      const context = createContextWithDriver(driver);

      const result = await screenshotTool({ name: 'test' }, context);

      expect(result.ok).toBe(true);
      expect(driver.screenshot).toHaveBeenCalledWith(expect.objectContaining({
        name: 'test',
      }));
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
  });
});
