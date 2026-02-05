import { describe, it, expect } from 'vitest';

import {
  createMockSessionManager,
  createMockKnowledgeStore,
  createMockPage,
  createMockLocator,
  createMockBrowserContext,
} from '.';

describe('mock-factories', () => {
  describe('createMockSessionManager', () => {
    it('returns a fresh instance each call', () => {
      const mock1 = createMockSessionManager();
      const mock2 = createMockSessionManager();

      expect(mock1).not.toBe(mock2);
    });

    it('creates fresh vi.fn() mocks each call', () => {
      const mock1 = createMockSessionManager();
      const mock2 = createMockSessionManager();

      expect(mock1.hasActiveSession).not.toBe(mock2.hasActiveSession);
    });

    it('has all required ISessionManager methods', () => {
      const mock = createMockSessionManager();

      expect(typeof mock.hasActiveSession).toBe('function');
      expect(typeof mock.getSessionId).toBe('function');
      expect(typeof mock.getSessionState).toBe('function');
      expect(typeof mock.getSessionMetadata).toBe('function');
      expect(typeof mock.launch).toBe('function');
      expect(typeof mock.cleanup).toBe('function');
      expect(typeof mock.getPage).toBe('function');
      expect(typeof mock.setActivePage).toBe('function');
      expect(typeof mock.getTrackedPages).toBe('function');
      expect(typeof mock.classifyPageRole).toBe('function');
      expect(typeof mock.getContext).toBe('function');
      expect(typeof mock.getExtensionState).toBe('function');
      expect(typeof mock.setRefMap).toBe('function');
      expect(typeof mock.getRefMap).toBe('function');
      expect(typeof mock.clearRefMap).toBe('function');
      expect(typeof mock.resolveA11yRef).toBe('function');
      expect(typeof mock.navigateToHome).toBe('function');
      expect(typeof mock.navigateToSettings).toBe('function');
      expect(typeof mock.navigateToUrl).toBe('function');
      expect(typeof mock.navigateToNotification).toBe('function');
      expect(typeof mock.waitForNotificationPage).toBe('function');
      expect(typeof mock.screenshot).toBe('function');
      expect(typeof mock.getBuildCapability).toBe('function');
      expect(typeof mock.getFixtureCapability).toBe('function');
      expect(typeof mock.getChainCapability).toBe('function');
      expect(typeof mock.getContractSeedingCapability).toBe('function');
      expect(typeof mock.getStateSnapshotCapability).toBe('function');
      expect(typeof mock.getEnvironmentMode).toBe('function');
    });

    it('returns sensible defaults', async () => {
      const mock = createMockSessionManager();

      expect(mock.hasActiveSession()).toBe(false);
      expect(mock.getSessionId()).toBeUndefined();
      expect(mock.getTrackedPages()).toStrictEqual([]);
      expect(mock.getRefMap()).toStrictEqual(new Map());
      expect(mock.getEnvironmentMode()).toBe('e2e');

      const launchResult = await mock.launch({});
      expect(launchResult.sessionId).toBe('test-session-123');
      expect(launchResult.extensionId).toBe('ext-123');
    });

    it('allows customization via options', async () => {
      const customRefMap = new Map([['e1', 'button.primary']]);
      const mock = createMockSessionManager({
        hasActive: true,
        sessionId: 'custom-session',
        refMap: customRefMap,
        environmentMode: 'prod',
      });

      expect(mock.hasActiveSession()).toBe(true);
      expect(mock.getSessionId()).toBe('custom-session');
      expect(mock.getRefMap()).toBe(customRefMap);
      expect(mock.getEnvironmentMode()).toBe('prod');
    });

    it('isolates mock state between instances', () => {
      const mock1 = createMockSessionManager();
      const mock2 = createMockSessionManager();

      const fn1 = mock1.hasActiveSession as any;
      fn1.mockReturnValue(true);

      expect(mock1.hasActiveSession()).toBe(true);
      expect(mock2.hasActiveSession()).toBe(false);
    });
  });

  describe('createMockKnowledgeStore', () => {
    it('returns a fresh instance each call', () => {
      const mock1 = createMockKnowledgeStore();
      const mock2 = createMockKnowledgeStore();

      expect(mock1).not.toBe(mock2);
    });

    it('creates fresh vi.fn() mocks each call', () => {
      const mock1 = createMockKnowledgeStore();
      const mock2 = createMockKnowledgeStore();

      expect(mock1.recordStep).not.toBe(mock2.recordStep);
    });

    it('has all required KnowledgeStore methods', () => {
      const mock = createMockKnowledgeStore();

      expect(typeof mock.recordStep).toBe('function');
      expect(typeof mock.getLastSteps).toBe('function');
      expect(typeof mock.searchSteps).toBe('function');
      expect(typeof mock.summarizeSession).toBe('function');
      expect(typeof mock.listSessions).toBe('function');
      expect(typeof mock.generatePriorKnowledge).toBe('function');
      expect(typeof mock.writeSessionMetadata).toBe('function');
    });

    it('returns sensible defaults', async () => {
      const mock = createMockKnowledgeStore();

      expect(await mock.getLastSteps?.(10, 'all', undefined)).toStrictEqual([]);
      expect(
        await mock.searchSteps?.('test', 10, 'all', undefined),
      ).toStrictEqual([]);
      expect(await mock.listSessions?.(10)).toStrictEqual([]);
    });

    it('allows customization via options', async () => {
      const customSteps = [{ tool: 'mm_click', screen: 'home' }];
      const mock = createMockKnowledgeStore({
        lastSteps: customSteps,
      });

      expect(await mock.getLastSteps?.(10, 'all', undefined)).toStrictEqual(
        customSteps,
      );
    });
  });

  describe('createMockPage', () => {
    it('returns a fresh instance each call', () => {
      const mock1 = createMockPage();
      const mock2 = createMockPage();

      expect(mock1).not.toBe(mock2);
    });

    it('has Playwright Page methods', () => {
      const mock = createMockPage();

      expect(typeof mock.locator).toBe('function');
      expect(typeof mock.waitForLoadState).toBe('function');
      expect(typeof mock.url).toBe('function');
      expect(typeof mock.context).toBe('function');
      expect(typeof mock.screenshot).toBe('function');
    });

    it('url returns string', () => {
      const mock = createMockPage({ url: 'https://example.com' });

      expect(mock.url?.()).toBe('https://example.com');
    });
  });

  describe('createMockLocator', () => {
    it('returns a fresh instance each call', () => {
      const mock1 = createMockLocator();
      const mock2 = createMockLocator();

      expect(mock1).not.toBe(mock2);
    });

    it('creates fresh vi.fn() mocks each call', () => {
      const mock1 = createMockLocator();
      const mock2 = createMockLocator();

      expect(mock1.click).not.toBe(mock2.click);
    });

    it('has Playwright Locator methods', () => {
      const mock = createMockLocator();

      expect(typeof mock.click).toBe('function');
      expect(typeof mock.fill).toBe('function');
      expect(typeof mock.isVisible).toBe('function');
      expect(typeof mock.getAttribute).toBe('function');
      expect(typeof mock.textContent).toBe('function');
      expect(typeof mock.all).toBe('function');
      expect(typeof mock.first).toBe('function');
      expect(typeof mock.nth).toBe('function');
    });

    it('methods are callable', async () => {
      const mock = createMockLocator();

      expect(await mock.click?.()).toBeUndefined();
      expect(await mock.fill?.('text')).toBeUndefined();
      expect(await mock.isVisible?.()).toBe(true);
    });
  });

  describe('createMockBrowserContext', () => {
    it('returns a fresh instance each call', () => {
      const mock1 = createMockBrowserContext();
      const mock2 = createMockBrowserContext();

      expect(mock1).not.toBe(mock2);
    });

    it('has BrowserContext methods', () => {
      const mock = createMockBrowserContext();

      expect(typeof mock.pages).toBe('function');
      expect(typeof mock.newPage).toBe('function');
      expect(typeof mock.close).toBe('function');
    });

    it('pages returns array', () => {
      const mock = createMockBrowserContext();

      expect(mock.pages?.()).toStrictEqual([]);
    });
  });
});
