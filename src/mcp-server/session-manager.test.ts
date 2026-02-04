import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setSessionManager,
  getSessionManager,
  hasSessionManager,
  type ISessionManager,
} from "./session-manager.js";

const createMockSessionManager = (): ISessionManager => ({
  hasActiveSession: vi.fn().mockReturnValue(false),
  getSessionId: vi.fn().mockReturnValue(undefined),
  getSessionState: vi.fn().mockReturnValue(undefined),
  getSessionMetadata: vi.fn().mockReturnValue(undefined),
  launch: vi.fn().mockResolvedValue({
    sessionId: "test-session-123",
    extensionId: "ext-123",
    state: { screen: "home", url: "chrome-extension://ext-123/home.html" },
  }),
  cleanup: vi.fn().mockResolvedValue(true),
  getPage: vi.fn(),
  setActivePage: vi.fn(),
  getTrackedPages: vi.fn().mockReturnValue([]),
  classifyPageRole: vi.fn().mockReturnValue("extension"),
  getContext: vi.fn(),
  getExtensionState: vi.fn().mockResolvedValue({ screen: "home" }),
  setRefMap: vi.fn(),
  getRefMap: vi.fn().mockReturnValue(new Map()),
  clearRefMap: vi.fn(),
  resolveA11yRef: vi.fn(),
  navigateToHome: vi.fn().mockResolvedValue(undefined),
  navigateToSettings: vi.fn().mockResolvedValue(undefined),
  navigateToUrl: vi.fn(),
  navigateToNotification: vi.fn(),
  waitForNotificationPage: vi.fn(),
  screenshot: vi.fn().mockResolvedValue({ path: "/path/to/screenshot.png" }),
  getBuildCapability: vi.fn().mockReturnValue(undefined),
  getFixtureCapability: vi.fn().mockReturnValue(undefined),
  getChainCapability: vi.fn().mockReturnValue(undefined),
  getContractSeedingCapability: vi.fn().mockReturnValue(undefined),
  getStateSnapshotCapability: vi.fn().mockReturnValue(undefined),
  getEnvironmentMode: vi.fn().mockReturnValue("e2e"),
});

describe("session-manager", () => {
  beforeEach(() => {
    setSessionManager(undefined as unknown as ISessionManager);
  });

  describe("setSessionManager", () => {
    it("sets the session manager instance", () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(hasSessionManager()).toBe(true);
    });

    it("replaces the existing session manager", () => {
      const mockManager1 = createMockSessionManager();
      const mockManager2 = createMockSessionManager();

      setSessionManager(mockManager1);
      setSessionManager(mockManager2);

      expect(getSessionManager()).toBe(mockManager2);
    });
  });

  describe("getSessionManager", () => {
    it("returns the session manager when set", () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(getSessionManager()).toBe(mockManager);
    });

    it("throws error when session manager is not set", () => {
      expect(() => getSessionManager()).toThrow(
        "Session manager not initialized. Call setSessionManager() first.",
      );
    });
  });

  describe("hasSessionManager", () => {
    it("returns false when no session manager is set", () => {
      expect(hasSessionManager()).toBe(false);
    });

    it("returns true when session manager is set", () => {
      const mockManager = createMockSessionManager();
      setSessionManager(mockManager);

      expect(hasSessionManager()).toBe(true);
    });
  });

  describe("ISessionManager interface compliance", () => {
    let manager: ISessionManager;

    beforeEach(() => {
      manager = createMockSessionManager();
      setSessionManager(manager);
    });

    it("can call hasActiveSession", () => {
      const result = getSessionManager().hasActiveSession();
      expect(typeof result).toBe("boolean");
    });

    it("can call getSessionId", () => {
      const result = getSessionManager().getSessionId();
      expect(result).toBeUndefined();
    });

    it("can call launch", async () => {
      const result = await getSessionManager().launch({});
      expect(result.sessionId).toBe("test-session-123");
    });

    it("can call cleanup", async () => {
      const result = await getSessionManager().cleanup();
      expect(result).toBe(true);
    });

    it("can call screenshot", async () => {
      const result = await getSessionManager().screenshot({ name: "test" });
      expect(result.path).toBeDefined();
    });

    it("can access capability methods", () => {
      expect(getSessionManager().getBuildCapability()).toBeUndefined();
      expect(getSessionManager().getFixtureCapability()).toBeUndefined();
      expect(getSessionManager().getChainCapability()).toBeUndefined();
      expect(
        getSessionManager().getContractSeedingCapability(),
      ).toBeUndefined();
    });
  });
});
