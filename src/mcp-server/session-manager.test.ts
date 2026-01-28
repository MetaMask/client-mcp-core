import {
  setSessionManager,
  getSessionManager,
  hasSessionManager,
  type ISessionManager,
} from "./session-manager.js";

const createMockSessionManager = (): ISessionManager => ({
  hasActiveSession: jest.fn().mockReturnValue(false),
  getSessionId: jest.fn().mockReturnValue(undefined),
  getSessionState: jest.fn().mockReturnValue(undefined),
  getSessionMetadata: jest.fn().mockReturnValue(undefined),
  launch: jest.fn().mockResolvedValue({
    sessionId: "test-session-123",
    extensionId: "ext-123",
    state: { screen: "home", url: "chrome-extension://ext-123/home.html" },
  }),
  cleanup: jest.fn().mockResolvedValue(true),
  getPage: jest.fn(),
  setActivePage: jest.fn(),
  getTrackedPages: jest.fn().mockReturnValue([]),
  classifyPageRole: jest.fn().mockReturnValue("extension"),
  getContext: jest.fn(),
  getExtensionState: jest.fn().mockResolvedValue({ screen: "home" }),
  setRefMap: jest.fn(),
  getRefMap: jest.fn().mockReturnValue(new Map()),
  clearRefMap: jest.fn(),
  resolveA11yRef: jest.fn(),
  navigateToHome: jest.fn().mockResolvedValue(undefined),
  navigateToSettings: jest.fn().mockResolvedValue(undefined),
  navigateToUrl: jest.fn(),
  navigateToNotification: jest.fn(),
  waitForNotificationPage: jest.fn(),
  screenshot: jest.fn().mockResolvedValue({ path: "/path/to/screenshot.png" }),
  getBuildCapability: jest.fn().mockReturnValue(undefined),
  getFixtureCapability: jest.fn().mockReturnValue(undefined),
  getChainCapability: jest.fn().mockReturnValue(undefined),
  getContractSeedingCapability: jest.fn().mockReturnValue(undefined),
  getStateSnapshotCapability: jest.fn().mockReturnValue(undefined),
  getEnvironmentMode: jest.fn().mockReturnValue("e2e"),
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
