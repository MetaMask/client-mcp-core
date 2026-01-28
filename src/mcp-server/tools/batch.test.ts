import {
  setToolRegistry,
  getToolRegistry,
  hasToolRegistry,
  setToolValidator,
  getToolValidator,
  handleRunSteps,
  type ToolRegistry,
  type ToolHandler,
  type ToolValidator,
} from "./batch.js";
import { setSessionManager, type ISessionManager } from "../session-manager.js";

const createMockSessionManager = (
  hasActive: boolean = true,
): ISessionManager => ({
  hasActiveSession: jest.fn().mockReturnValue(hasActive),
  getSessionId: jest
    .fn()
    .mockReturnValue(hasActive ? "test-session" : undefined),
  getSessionState: jest.fn().mockReturnValue(undefined),
  getSessionMetadata: jest.fn().mockReturnValue(undefined),
  launch: jest.fn().mockResolvedValue({
    sessionId: "test-session",
    extensionId: "ext-123",
    state: {},
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

function clearToolValidator(): void {
  setToolValidator((() => ({ success: true })) as ToolValidator);
  setToolValidator(undefined as unknown as ToolValidator);
}

describe("batch", () => {
  beforeEach(() => {
    setToolRegistry({});
    clearToolValidator();
  });

  describe("setToolRegistry / getToolRegistry", () => {
    it("sets and gets tool registry", () => {
      const mockHandler: ToolHandler = jest
        .fn()
        .mockResolvedValue({ ok: true });
      const registry: ToolRegistry = {
        mm_click: mockHandler,
      };

      setToolRegistry(registry);

      expect(getToolRegistry()).toBe(registry);
      expect(getToolRegistry().mm_click).toBe(mockHandler);
    });

    it("replaces existing registry", () => {
      const registry1: ToolRegistry = { tool1: jest.fn() };
      const registry2: ToolRegistry = { tool2: jest.fn() };

      setToolRegistry(registry1);
      setToolRegistry(registry2);

      expect(getToolRegistry()).toBe(registry2);
      expect(getToolRegistry().tool1).toBeUndefined();
      expect(getToolRegistry().tool2).toBeDefined();
    });
  });

  describe("hasToolRegistry", () => {
    it("returns false for empty registry", () => {
      setToolRegistry({});
      expect(hasToolRegistry()).toBe(false);
    });

    it("returns true when registry has handlers", () => {
      setToolRegistry({ mm_click: jest.fn() });
      expect(hasToolRegistry()).toBe(true);
    });
  });

  describe("setToolValidator / getToolValidator", () => {
    it("sets and gets tool validator", () => {
      const validator: ToolValidator = jest
        .fn()
        .mockReturnValue({ success: true });
      setToolValidator(validator);

      expect(getToolValidator()).toBe(validator);
    });

    it("returns undefined when not set", () => {
      expect(getToolValidator()).toBeUndefined();
    });
  });

  describe("handleRunSteps", () => {
    beforeEach(() => {
      setSessionManager(createMockSessionManager(true));
    });

    it("returns error when no active session", async () => {
      setSessionManager(createMockSessionManager(false));

      const result = await handleRunSteps({
        steps: [{ tool: "mm_click", args: { testId: "button" } }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.code).toBe("MM_NO_ACTIVE_SESSION");
      }
    });

    it("executes steps in sequence", async () => {
      const executionOrder: string[] = [];
      const clickHandler = jest.fn().mockImplementation(async () => {
        executionOrder.push("click");
        return { ok: true, result: "clicked" };
      });
      const typeHandler = jest.fn().mockImplementation(async () => {
        executionOrder.push("type");
        return { ok: true, result: "typed" };
      });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: "mm_click", args: { testId: "button" } },
          { tool: "mm_type", args: { testId: "input", text: "hello" } },
        ],
      });

      expect(result.ok).toBe(true);
      expect(executionOrder).toEqual(["click", "type"]);
      if (result.ok) {
        expect(result.result?.summary.total).toBe(2);
        expect(result.result?.summary.succeeded).toBe(2);
        expect(result.result?.summary.failed).toBe(0);
      }
    });

    it("returns error for unknown tool", async () => {
      setToolRegistry({});

      const result = await handleRunSteps({
        steps: [{ tool: "unknown_tool", args: {} }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe("MM_UNKNOWN_TOOL");
        expect(result.result?.summary.failed).toBe(1);
      }
    });

    it("stops on error when stopOnError is true", async () => {
      const clickHandler = jest.fn().mockResolvedValue({
        ok: false,
        error: { code: "ERR", message: "fail" },
      });
      const typeHandler = jest.fn().mockResolvedValue({ ok: true });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: "mm_click", args: {} },
          { tool: "mm_type", args: { text: "hello" } },
        ],
        stopOnError: true,
      });

      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(typeHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps.length).toBe(1);
      }
    });

    it("continues on error when stopOnError is false", async () => {
      const clickHandler = jest.fn().mockResolvedValue({
        ok: false,
        error: { code: "ERR", message: "fail" },
      });
      const typeHandler = jest
        .fn()
        .mockResolvedValue({ ok: true, result: "typed" });

      setToolRegistry({
        mm_click: clickHandler,
        mm_type: typeHandler,
      });

      const result = await handleRunSteps({
        steps: [
          { tool: "mm_click", args: {} },
          { tool: "mm_type", args: { text: "hello" } },
        ],
        stopOnError: false,
      });

      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(typeHandler).toHaveBeenCalledTimes(1);
      if (result.ok) {
        expect(result.result?.steps.length).toBe(2);
        expect(result.result?.summary.failed).toBe(1);
        expect(result.result?.summary.succeeded).toBe(1);
      }
    });

    it("uses tool validator when set", async () => {
      const clickHandler = jest.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const validator: ToolValidator = jest.fn().mockReturnValue({
        success: false,
        error: { message: "Invalid testId" },
      });
      setToolValidator(validator);

      const result = await handleRunSteps({
        steps: [{ tool: "mm_click", args: { testId: "" } }],
      });

      expect(validator).toHaveBeenCalledWith("mm_click", { testId: "" });
      expect(clickHandler).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe("MM_INVALID_INPUT");
      }
    });

    it("passes validation when validator returns success", async () => {
      const clickHandler = jest
        .fn()
        .mockResolvedValue({ ok: true, result: "clicked" });
      setToolRegistry({ mm_click: clickHandler });

      const validator: ToolValidator = jest
        .fn()
        .mockReturnValue({ success: true });
      setToolValidator(validator);

      const result = await handleRunSteps({
        steps: [{ tool: "mm_click", args: { testId: "btn" } }],
      });

      expect(clickHandler).toHaveBeenCalled();
      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(true);
      }
    });

    it("handles exceptions from tool handlers", async () => {
      const clickHandler = jest.fn().mockRejectedValue(new Error("Timeout"));
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: "mm_click", args: {} }],
      });

      if (result.ok) {
        expect(result.result?.steps[0].ok).toBe(false);
        expect(result.result?.steps[0].error?.code).toBe("MM_INTERNAL_ERROR");
        expect(result.result?.steps[0].error?.message).toContain("Timeout");
      }
    });

    it("includes duration in step results", async () => {
      const clickHandler = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [{ tool: "mm_click", args: {} }],
      });

      if (result.ok) {
        expect(result.result?.steps[0].meta?.durationMs).toBeGreaterThanOrEqual(
          10,
        );
      }
    });

    it("includes total duration in summary", async () => {
      const clickHandler = jest.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      const result = await handleRunSteps({
        steps: [
          { tool: "mm_click", args: {} },
          { tool: "mm_click", args: {} },
        ],
      });

      if (result.ok) {
        expect(result.result?.summary.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("defaults args to empty object when not provided", async () => {
      const clickHandler = jest.fn().mockResolvedValue({ ok: true });
      setToolRegistry({ mm_click: clickHandler });

      await handleRunSteps({
        steps: [{ tool: "mm_click" }],
      });

      expect(clickHandler).toHaveBeenCalledWith({}, expect.any(Object));
    });
  });
});
