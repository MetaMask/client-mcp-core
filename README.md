# @metamask/client-mcp-core

HTTP daemon and CLI architecture for agent-driven browser extension testing with Playwright.

## Overview

This package provides the core infrastructure for enabling LLM agents to interact with browser extensions through Playwright. It ships a persistent HTTP daemon that manages browser lifecycle and a unified `mm` CLI that agents (and developers) use to drive sessions.

The design is **consumer-agnostic**: the core handles protocol and tooling — consumers provide extension-specific logic by implementing the `ISessionManager` interface and injecting capabilities.

```
                         ┌─────────────────────────────────┐
                         │         LLM Agent / Dev         │
                         └────────────┬────────────────────┘
                                      │  mm CLI commands
                                      ▼
                         ┌─────────────────────────────────┐
                         │     mm CLI  (src/cli/mm.ts)     │
                         │  discover / auto-start daemon   │
                         └────────────┬────────────────────┘
                                      │  HTTP (127.0.0.1)
                                      ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │                    HTTP Daemon (createServer)                     │
  │                                                                   │
  │  ┌──────────┐  ┌───────────────┐  ┌────────────┐                  │
  │  │  Routes  │  │ RequestQueue  │  │   Tool     │                  │
  │  │ /health  │  │ (async mutex) │  │  Registry  │                  │
  │  │ /status  │  │               │  │  43 tools  │                  │
  │  │ /launch  │  └───────────────┘  └─────┬──────┘                  │
  │  │ /cleanup │                           │                         │
  │  │ /tool/:n │                           ▼                         │
  │  └──────────┘               ┌──────────────────┐                  │
  │                             │   ToolContext    │                  │
  │                             │  sessionManager  │                  │
  │                             │  page / refMap   │                  │
  │                             │  workflowContext │                  │
  │                             └────────┬─────────┘                  │
  └──────────────────────────────────────┼────────────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   │          ISessionManager                  │
                   │       (consumer implementation)           │
                   │                                           │
                   │  Session lifecycle   Page management      │
                   │  Extension state     A11y reference map   │
                   │  Navigation          Screenshots          │
                   │  Capabilities (opt)  Environment config   │
                   └─────────────────────┬─────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   │          WorkflowContext                  │
                   │                                           │
                   │  build?            fixture?               │
                   │  chain?            contractSeeding?       │
                   │  stateSnapshot?    mockServer?            │
                   │  config: EnvironmentConfig                │
                   └─────────────────────┬─────────────────────┘
                                         │
                                         ▼
                   ┌───────────────────────────────────────────┐
                   │        Playwright  →  Chrome Browser      │
                   │            Browser Extension              │
                   └───────────────────────────────────────────┘
```

## Requirements

- **Node.js** `^20 || ^22 || >=24`
- **TypeScript** `>=5.0` (for consumer type definitions)
- **Playwright** `^1.49.0` (peer dependency)

## Installation

As a project dependency, run the CLI through your package manager. It does not put a bare `mm` command on your shell `PATH`:

```bash
yarn add @metamask/client-mcp-core
```

As a global CLI (puts `mm` directly on your PATH — recommended for LLM agents):

```bash
npm install -g @metamask/client-mcp-core
```

The global CLI can target any project via `--project` or `MM_PROJECT` (see [Project Targeting](#project-targeting)).

Use the invocation that matches your installation:

```bash
# Project dependency
yarn mm launch

# Global installation
mm launch
```

## Getting Started

Consuming this package requires two things: a **daemon entry point** and a **configuration file**.

### 1. Create a daemon entry point

```typescript
// daemon.ts
import { createServer, allocatePort } from '@metamask/client-mcp-core';
import { MySessionManager } from './my-session-manager';
import { createMyContext } from './my-context';

const server = createServer({
  sessionManager: new MySessionManager(),
  contextFactory: async () => {
    // Consumer owns port allocation — use the allocatePort() helper
    // or any other strategy that fits your infrastructure.
    const anvil = await allocatePort();
    const fixture = await allocatePort();
    await Promise.all([
      new Promise<void>((r) => anvil.server.close(() => r())),
      new Promise<void>((r) => fixture.server.close(() => r())),
    ]);

    return createMyContext({
      ports: { anvil: anvil.port, fixture: fixture.port },
    });
  },
});

server.start().then((state) => {
  console.error(`Daemon started on port ${state.port}`);
});
```

### 2. Create a configuration file

Create `mm-client-cli.config.ts` in your project root:

```typescript
export default {
  daemon: 'path/to/daemon.ts',
  runtime: 'tsx',
};
```

The `daemon` field tells the CLI where the daemon entry point lives. The `runtime` field supports `tsx` (the default) and `node`. For `tsx`, the CLI resolves the project's installed `tsx/cli` module and launches it through Node.

The CLI uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) for config discovery, so you can also use `mm-client-cli.config.js`, `.mm-client-clirc.json`, or other supported formats.

### 3. Use the CLI

```bash
mm launch              # auto-starts daemon, opens browser session
mm describe-screen     # get element references
mm click e3            # interact using a11y refs
mm cleanup --shutdown  # stop browser and daemon
```

Use `yarn mm` in place of `mm` when the CLI is installed as a project dependency.

If running from outside the project directory (e.g., a parent folder containing multiple repos):

```bash
mm --project ./my-extension launch
mm --project ./my-extension describe-screen

# Or set once via environment variable
export MM_PROJECT=/path/to/my-extension
mm launch
```

## Core Concepts

### Daemon Model

The architecture relies on a persistent background HTTP daemon that manages the browser lifecycle:

- **Worktree Isolation**: Each git worktree runs its own daemon instance, tracked via a `.mm-server` state file in the project root. This allows parallel work across branches.
- **Port Allocation**: The daemon allocates its own HTTP port automatically. Sub-service ports (Anvil, fixture server, etc.) are allocated by the consumer's `contextFactory` and reported back via `allocatedPorts`. The `allocatePort()` helper is exported for convenience.
- **Auto-Start**: The daemon starts automatically on `mm launch` if not already running, and shuts down after a period of inactivity (default: 30 minutes).
- **Request Serialization**: A `RequestQueue` (async mutex) ensures only one tool executes at a time, preventing race conditions on shared browser state.
- **Health Checks**: Each daemon generates a unique nonce on startup. The CLI verifies daemon identity via `GET /health` to detect stale `.mm-server` files from crashed processes.
- **Logs**: Daemon activity is logged to `.mm-daemon.log`.

### Session Manager Interface

`ISessionManager` is the core abstraction boundary between this package and consumer implementations. Consumers must implement this interface to provide extension-specific browser control.

```typescript
type ISessionManager = {
  // Session Lifecycle
  hasActiveSession(): boolean;
  getSessionId(): string | undefined;
  getSessionState(): SessionState | undefined;
  getSessionMetadata(): SessionMetadata | undefined;
  launch(input: SessionLaunchInput): Promise<SessionLaunchResult>;
  cleanup(): Promise<boolean>;

  // Page Management
  getPage(): Page;
  setActivePage(page: Page): void;
  getTrackedPages(): TrackedPage[];
  classifyPageRole(page: Page, extensionId?: string): TabRole;
  getContext(): BrowserContext;

  // Extension State
  getExtensionState(): Promise<ExtensionState>;

  // A11y Reference Map
  setRefMap(map: Map<string, string>): void;
  getRefMap(): Map<string, string>;
  clearRefMap(): void;
  resolveA11yRef(ref: string): string | undefined;

  // Navigation
  navigateToHome(): Promise<void>;
  navigateToSettings(): Promise<void>;
  navigateToUrl(url: string): Promise<Page>;
  navigateToNotification(): Promise<Page>;
  waitForNotificationPage(timeoutMs: number): Promise<Page>;

  // Screenshots
  screenshot(options: SessionScreenshotOptions): Promise<ScreenshotResult>;

  // Capabilities (optional, extension-specific)
  getBuildCapability(): BuildCapability | undefined;
  getFixtureCapability(): FixtureCapability | undefined;
  getChainCapability(): ChainCapability | undefined;
  getContractSeedingCapability(): ContractSeedingCapability | undefined;
  getStateSnapshotCapability(): StateSnapshotCapability | undefined;

  // Environment
  setWorkflowContext(context: WorkflowContext): void;
  getEnvironmentMode(): EnvironmentMode;
  setContext(context: 'e2e' | 'prod', options?: Record<string, unknown>): void;
  getContextInfo(): { currentContext: 'e2e' | 'prod'; ... };
};
```

### Workflow Context & Capabilities

The `WorkflowContext` aggregates optional capabilities that consumers inject through the `contextFactory`. The tool system checks for capabilities at runtime — tools that depend on missing capabilities return clear errors.

```typescript
type WorkflowContext = {
  build?: BuildCapability;
  fixture?: FixtureCapability;
  chain?: ChainCapability;
  contractSeeding?: ContractSeedingCapability;
  stateSnapshot?: StateSnapshotCapability;
  mockServer?: MockServerCapability;
  config: EnvironmentConfig;
  allocatedPorts?: PortMap; // reported to /status and persisted in .mm-server
};
```

Capabilities are created by the consumer's `contextFactory` function. The factory is responsible for allocating any sub-service ports it needs (the `allocatePort()` helper is exported for convenience):

```typescript
async function createMyContext(options: {
  ports: { anvil: number; fixture: number };
}): Promise<WorkflowContext> {
  return {
    build: new MyBuildCapability(),
    fixture: new MyFixtureCapability(options.ports.fixture),
    chain: new MyChainCapability(options.ports.anvil),
    allocatedPorts: {
      anvil: options.ports.anvil,
      fixture: options.ports.fixture,
    },
    config: {
      environment: 'e2e',
      extensionName: 'MyExtension',
      defaultPassword: 'test-password',
      artifactsDir: './test-artifacts',
      defaultChainId: 1337,
      ports: {
        anvil: options.ports.anvil,
        fixtureServer: options.ports.fixture,
      },
    },
  };
}
```

### Capability Reference

| Capability                  | Purpose                                 | Enables Tools                                                               |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `BuildCapability`           | Build extension from source             | `build`                                                                     |
| `FixtureCapability`         | Manage wallet state via fixtures        | `launch` (state modes)                                                      |
| `ChainCapability`           | Local blockchain (Anvil) lifecycle      | Chain interactions                                                          |
| `ContractSeedingCapability` | Deploy smart contracts to Anvil         | `seed_contract`, `seed_contracts`, `get_contract_address`, `list_contracts` |
| `StateSnapshotCapability`   | Read extension state and detect screens | `get_state`                                                                 |
| `MockServerCapability`      | HTTP mock server for API stubbing       | Mock-dependent tests                                                        |

Each capability interface is defined in `src/capabilities/types.ts`:

```typescript
type BuildCapability = {
  build(options?: BuildOptions): Promise<BuildResult>;
  getExtensionPath(): string;
  isBuilt(): Promise<boolean>;
};

type FixtureCapability = {
  start(state: WalletState): Promise<void>;
  stop(): Promise<void>;
  getDefaultState(): WalletState;
  getOnboardingState(): WalletState;
  resolvePreset(presetName: string): WalletState;
};

type ChainCapability = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  setPort(port: number): void;
};

type ContractSeedingCapability = {
  deployContract(
    name: string,
    options?: DeployOptions,
  ): Promise<ContractDeployment>;
  deployContracts(
    names: string[],
    options?: DeployOptions,
  ): Promise<{
    deployed: ContractDeployment[];
    failed: { name: string; error: string }[];
  }>;
  getContractAddress(name: string): string | null;
  listDeployedContracts(): ContractInfo[];
  getAvailableContracts(): string[];
  clearRegistry(): void;
  initialize(): void;
};

type StateSnapshotCapability = {
  getState(page: Page, options: StateOptions): Promise<StateSnapshot>;
  detectCurrentScreen(page: Page): Promise<string>;
};

type MockServerCapability = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getServer(): unknown;
  getPort(): number;
};
```

### Tool System

Tools are standalone functions registered in a central `toolRegistry`. Each tool receives a `ToolContext` and returns a `ToolResponse`.

```typescript
type ToolFunction<TParams, TResult> = (
  params: TParams,
  context: ToolContext,
) => Promise<ToolResponse<TResult>>;

type ToolContext = {
  sessionManager: ISessionManager;
  get page(): Page; // lazy — throws if no session
  get refMap(): Map<string, string>; // lazy — returns empty map if no session
  workflowContext: WorkflowContext;
  toolRegistry: Map<string, ToolFunction<unknown, unknown>>;
  driver?: IPlatformDriver;
  signal?: AbortSignal; // aborted when the request times out
};
```

Tools check `signal?.aborted` between steps and stop. In the daemon, `context.sessionManager.setRefMap` goes through a guard (`RefStore`) that drops a write from a request that timed out or was replaced by a newer one, so a cancelled call cannot overwrite the refs of later calls.

The daemon routes `POST /tool/:name` requests through the registry, applies Zod validation on inputs, executes the tool through the request queue, and captures observations (test IDs, a11y snapshot) according to the call's `observe` level (see [Observations](#observations)).

**Registered tools:**

| Tool                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifecycle**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `build`                       | Triggers an extension build using the configured `BuildCapability`. Accepts build type and force options.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `launch`                      | Launches a new browser session with the configured extension. Supports state modes (`default`, `onboarding`, `custom`), fixture presets, tag metadata, and optional contract seeding on start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cleanup`                     | Tears down the active browser session and cleans up all resources (browser, services, fixtures).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Interaction**               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `click`                       | Clicks an element identified by a11y ref, test ID, or CSS selector. Waits for the element to be visible before clicking. Supports `within` to scope the target inside a parent element.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `type`                        | Types text into an input element identified by a11y ref, test ID, or CSS selector. Clears the field first, then sets the new value (uses Playwright's `fill()`). Supports `within` scoping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wait_for`                    | Waits for an element to become visible on the page within a configurable timeout. Supports `within` to scope the target inside a parent element.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_text`                    | Reads the text content of an element identified by a11y ref, test ID, or CSS selector. Returns the text, target descriptor, and character length. Supports `within` scoping. Categorized as read-only (no observations in response).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `clipboard`                   | Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Navigation**                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `navigate`                    | Navigates the browser to a named screen (`home`, `settings`, `notification`) or an arbitrary URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `switch_to_tab`               | Switches the active page to a tab matching a given role (e.g., `extension`, `dapp`) or URL prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `close_tab`                   | Closes a browser tab matching a given role or URL. Falls back to the extension tab if the active tab is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `wait_for_notification`       | Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Discovery**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `describe_screen`             | Captures a comprehensive screen snapshot: extension state, visible test IDs, trimmed a11y tree with refs, and optional screenshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `accessibility_snapshot`      | Captures a trimmed accessibility tree of the current page with deterministic refs (`e1`, `e2`, ...). Supports scoping to a root CSS selector.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `list_testids`                | Collects all visible `data-testid` attributes from the current page with text previews and visibility status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **State**                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_state`                   | Retrieves the current extension state (URL, screen, network, balance, account) and tracked tab information. On mobile the state is partial (`source: 'stub'`): fields that were not read from the app are omitted, not guessed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_context`                 | Returns the current environment context (`e2e` or `prod`), session status, available capabilities, and whether context switching is allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `set_context`                 | Switches the session environment between `e2e` and `prod` modes. Blocked while a session is active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Screenshots**               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `screenshot`                  | Captures a screenshot of the current page. Supports naming, full-page capture, scoping to a CSS selector, and optional base64 output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Contracts**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `seed_contract`               | Deploys a single smart contract to the local Anvil chain by name. Requires `ContractSeedingCapability`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `seed_contracts`              | Deploys multiple smart contracts in sequence. Returns both successful deployments and individual failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_contract_address`        | Looks up the deployed address of a contract by name from the session's deployment registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `list_contracts`              | Lists all contracts deployed in the current session with addresses and deployment timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Batching**                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `run_steps`                   | Executes a batch of tool invocations sequentially. Supports `stopOnError` to halt on first failure, a top-level `observe` level for the single observation collected after the batch (default `diff`; without one, the last executed step's `observe` is used), and `batchTimeoutMs` to set an overall deadline (remaining steps are skipped on timeout). Accepts tool aliases like `navigate_home` / `navigate-home`. Returns per-step results with timing.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Advanced**                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mock_network`                | Adds, clears, lists, and inspects targeted Playwright network mocks on the active browser context. Unmatched same-origin requests are continued unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cdp`                         | Sends a raw Chrome DevTools Protocol command, dispatched through the active platform driver. **Browser:** targets the page's Chrome CDP session (full Runtime/DOM/Network/Page surface); destructive methods (`Browser.close`, `Target.closeTarget`, etc.) are blocked. **Mobile (iOS/Android):** targets the app's React Native Hermes JS runtime via Metro's inspector proxy (delegates to `@metamask/device-mcp`, needs a DEBUG build with Metro running); only the JS-engine subset exists (`Runtime`, `Debugger`, `Log`, `HeapProfiler` — no DOM/Page/Network) and `Runtime.terminateExecution` / `Inspector.detached` are blocked. Optional `metroPort` / `appId` are mobile-only (ignored on browser). Categorized as `cdp`: no observation is collected and refs are not refreshed, so run `describe_screen` after a call that changes state. See [Browser vs Mobile CDP](#browser-vs-mobile-hermes-cdp). |
| **Hermes (mobile only)**      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `hermes_targets`              | Lists and diagnoses the debuggable Hermes targets Metro exposes (iOS and Android), reporting which target would be chosen or why selection is ambiguous. Use to confirm Metro is running and the app is registered. Pass `all` to bypass the appId filter and discover the real appId. Mobile only — there is no browser equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Mobile (iOS/Android only)** |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scroll_to_element`           | Scrolls the screen until an element (a11y ref, test ID, or selector) becomes visible. Supports `direction` (`up`/`down`) and `maxAttempts`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `device_swipe`                | Swipes the screen in a `direction` (`up`/`down`/`left`/`right`), with optional `startX`/`startY`/`distance`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `long_press`                  | Long-presses an element (a11y ref, test ID, or selector) for an optional `durationMs`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tap_coordinates`             | Taps raw `x`/`y` screen coordinates. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dismiss_keyboard`            | Dismisses the on-screen keyboard. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dismiss_alert`               | Dismisses a native alert, accepting it when `accept` is true. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_alert_text`              | Returns the text of a visible native alert. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `open_app`                    | Launches or foregrounds an app by `bundleId`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `close_app`                   | Terminates an app by `bundleId`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `press_button`                | Presses a hardware/system button. One of `home`, `back`, `enter`, `lock`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `device_context`              | Lists native/webview contexts (`list`) or switches to one (`switch` + `name`). Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `device_clipboard`            | Reads (`read`) or writes (`write` + `text`) the device clipboard. Distinct from the browser `clipboard` tool (which uses CDP). Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `screen_recording`            | Starts (`start`, optional `outputPath`) or stops (`stop`) a screen recording. When provided, `outputPath` is sandboxed to the configured `artifactsDir` (paths escaping it are rejected). Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `device_logs`                 | Fetches device logs with optional `durationSeconds` and `filter`. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `generate_locators`           | Generates ranked locator suggestions (identifier > label > text > type, with confidence) for every interactive element on the current screen, by walking the device snapshot. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Accessibility References

The core uses Chrome DevTools Protocol accessibility APIs to build a deterministic reference map of interactive and meaningful accessibility nodes. Each element gets a short ref like `e1`, `e2`, etc., mapped to a Playwright-compatible selector. Each browser ref resolves to exactly one element, or the action fails (strict mode) instead of acting on another element. A ref uses `role=<role>[name="<name>" s]`, which matches the exact, case-sensitive accessible name. When several elements of a snapshot share a role and name, each of them gets a selector built from its DOM node and verified unique the way Playwright matches CSS (unique `data-testid`, else unique `id`, else a path anchored at the nearest ancestor with a unique `data-testid` or `id`; elements in open shadow roots get `css=<host> >> css=<inside>`). When no such selector can be built, the ref keeps the plain role selector, so an action on it fails in strict mode; refs to elements in closed shadow roots always fail. Generic elements without a DOM selector use `text="<name>"`, which also fails when ambiguous. Role and text refs from a scoped `accessibility_snapshot` are prefixed with the root selector.

Agents call `describe_screen` to get the current reference map, then use refs for interaction:

```
mm describe-screen    → { ..., a11y: [{ ref: "e1", role: "button", name: "Submit" }, ...] }
mm click e1           → clicks the "Submit" button
mm type e3 "hello"    → types into the element mapped to e3
```

This accessibility-first approach provides reliable element targeting that survives minor UI changes.

Refs are numbered in tree order each time the daemon reads the screen (`describe_screen`, `accessibility_snapshot`, or an observation). The same screen gives the same refs, so an unchanged screen diffs as unchanged. When elements appear or disappear above an element, its ref can change: use the refs from the latest response. When a call returns both a tree and an observation (for example `describe_screen` with `observe`), the observation's refs are the ones that resolve. `list_testids` does not change refs.

On mobile, after a mutating or batch call, the daemon may take the snapshot again after 300 ms: while it shows a busy element (a label ending in `, busy`, an Android `ProgressBar`, or an iOS `ActivityIndicator` / `ProgressIndicator` / `UIActivityIndicatorView`), and at most once when it still equals the previous screen (not when the first snapshot took 1 s or more: the screen already had that time to change). In total at most 3 extra snapshots, and no wait that would end more than about 2 s after the first snapshot started. The test IDs come from the same snapshot as the tree. `describe_screen` on mobile also takes one snapshot for both.

On mobile, each observation, `describe_screen`, `list_testids` and `accessibility_snapshot` takes one device snapshot (plus the settle retries above). The consumer's `DeviceBackend` takes the snapshot. With the `@metamask/device-mcp` ADB backend (0.6.0 or later), Android snapshots use a signed test-only helper APK by default (`helper-first`). The backend installs it on the device the first time, so the first snapshot takes longer. To use only `uiautomator dump`, set `DEVICE_MCP_ADB_SNAPSHOT=dump` or the backend's `adb.snapshotMode` option. See the device-mcp README. The viewport for `visible` comes from the snapshot's root frames; the device window size is read at most once per session (and not refreshed after a rotation), only when a snapshot has no root frame. Elements that are not part of the app are removed from the tree, the refs, the test IDs and `generate_locators`: on Android, the system status bar and navigation bar windows (a full-width or full-height bar window whose ids are all `com.android.systemui:id/*`; other System UI windows such as the biometric prompt stay); on both platforms, the Expo DevLauncher "Tools" button of development builds (iOS `gearshape.fill` and its "Tools" text). Pass `{ excludeDevOverlay: false }` as the third `MobilePlatformDriver` argument to keep the DevLauncher button. Taps and waits inside `@metamask/device-mcp` still search the whole snapshot.

The mobile accessibility tree (`describe_screen`, `accessibility_snapshot`, observations) is a flat list in pre-order with no `path` (on the browser, `path` holds the `role:name` of the ancestor dialogs and headings; on mobile the ancestors are native view classes). Layout-only elements are left out (`pruneLayoutOnly` in `src/platform/mobile-hierarchy.ts`): an element with no label, no value, no identifier, and a type that is not a control or a progress indicator. Its kept descendants take its place, in order. Controls are iOS `Button`, `Link`, `TextField`, `SecureTextField`, `SearchField`, `TextView`, `TextArea`, `Switch`, `Toggle`, `Slider`, `Stepper`, `Picker`, `Cell`, `Tab`, `MenuItem` and similar AX types (exact match, without the `XCUIElementType` prefix), and Android classes ending in `Button`, `EditText`, `CheckBox`, `CheckedTextView`, `Switch`, `SeekBar`, `Spinner`, `RatingBar` and similar. The device snapshot has no `clickable` flag, so a layout-only plain React Native view (`RCTViewComponentView` on iOS, `android.view.ViewGroup` on Android) that has no kept children and is at least 24×24 (iOS points, Android pixels) stays as an unlabelled tap target, for example the iOS wallet home action buttons. Node `bounds` are `{ x, y, width, height }`, in that key order. Node refs number the kept nodes only, and ambiguity is computed over them. Only nodes with a testId, label or value have a refMap entry, so only their refs can be targeted; unlabelled tap targets, progress indicators and unnamed controls are listed with `bounds` (use `tap_coordinates`) but their refs do not resolve. On real MetaMask screens: iOS wallet home 177 → 67 nodes (183 kB with `path` → 10 kB), Android wallet home 625 → 242 nodes (649 kB → 35 kB), Android login 47 → 15 nodes. `list_testids` and `generate_locators` are not affected, and `describe_screen` still returns the full `testIds` list next to the tree.

### Session Metadata

Consumers can persist launch metadata with `writeSessionMetadata(artifactsDir, metadata)`. It writes `<artifactsDir>/<sessionId>/session.json` (for example `test-artifacts/<sessionId>/session.json` with `artifactsDir: 'test-artifacts'`) and returns the file path.

### Environment Modes

The package supports two environment modes via discriminated union configuration:

**E2E Testing** — Full test infrastructure with local chain, fixtures, and contract seeding:

```typescript
const e2eConfig: E2EEnvironmentConfig = {
  environment: 'e2e',
  extensionName: 'MetaMask',
  defaultPassword: 'password123',
  artifactsDir: './test-artifacts',
  defaultChainId: 1337,
  ports: { anvil: 8545, fixtureServer: 12345 },
};
```

**Production-like** — Minimal configuration without test infrastructure:

```typescript
const prodConfig: ProdEnvironmentConfig = {
  environment: 'prod',
  extensionName: 'MetaMask',
};
```

Use `set_context` / `get_context` tools to switch between modes at runtime (requires no active session).

## Server Configuration

The `createServer()` function accepts a `ServerConfig` object:

```typescript
type ServerConfig = {
  /** Session manager instance (required) */
  sessionManager: ISessionManager;
  /** Factory function to create workflow context (may be sync or async) */
  contextFactory: () => WorkflowContext | Promise<WorkflowContext>;
  /** Idle timeout in milliseconds (optional, defaults to 1_800_000 = 30 min) */
  idleShutdownMs?: number;
  /** Per-request execution timeout in milliseconds (default: 30_000) */
  requestTimeoutMs?: number;
  /** Path to log file (optional) */
  logFilePath?: string;
};
```

The `contextFactory` is called once during `start()`. It is responsible for allocating any sub-service ports and returning a `WorkflowContext`. The core validates the returned shape at runtime — `config.environment` must be a string and every value in `allocatedPorts` (if provided) must be a finite number.

The `allocatePort()` utility is exported as a convenience for consumers who need ephemeral port allocation inside their factory.

The returned `ServerInstance` exposes:

- `start(): Promise<DaemonState>` — Calls `contextFactory`, starts HTTP server, writes `.mm-server` state, sets up idle timeout and signal handlers.
- `stop(): Promise<void>` — Stops accepting connections, cleans up session, removes `.mm-server` state.

## HTTP API

The daemon exposes the following endpoints on `127.0.0.1`:

| Method | Path          | Description                                  |
| ------ | ------------- | -------------------------------------------- |
| `GET`  | `/health`     | Health check with nonce verification         |
| `GET`  | `/status`     | Daemon status (PID, port, uptime, sub-ports) |
| `POST` | `/launch`     | Start a browser session                      |
| `POST` | `/cleanup`    | Stop the current browser session             |
| `POST` | `/tool/:name` | Execute a registered tool with JSON body     |

All responses follow a consistent shape:

```typescript
// Success
{ ok: true, result: T, observations?: { testIds, a11y } }

// Error
{ ok: false, error: { code: string, message: string } }
```

### Observations

Every tool input (and the `/launch` and `/cleanup` bodies) accepts an optional `observe` level:

| Level  | Behaviour                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| `none` | No observation is collected or returned (`meta.timing.observationMs` is 0).                                      |
| `diff` | The observation is diffed against the previous one: `a11y.nodes` holds only changed nodes, `a11y.diff` the refs. |
| `full` | The whole option-collapsed observation, with no diff. It becomes the new diff baseline.                          |

When `observe` is absent, the default comes from the tool category: `diff` for **mutating** tools (click, type, navigate, launch, cleanup, build, etc.) and `run_steps`; `none` for **read-only**, **discovery** and `cdp` tools. An explicit `diff` or `full` on a read-only, discovery or `cdp` tool collects and returns an observation.

For `run_steps`, the top-level `observe` sets the level of the one observation collected after the batch. Without it, the `observe` in the last executed step's `args` is used; per-step `observe` on other steps is ignored. `includeObservations` was removed.

Observations contain `testIds` and `a11y` only. They do not include app state; call `get_state` for that.

A call that times out is cancelled: its signal is aborted, it stops at its next step, it collects no observation, and its refs are dropped.

## CLI Reference

The `mm` CLI provides a unified interface for agents and developers. All commands communicate with the daemon over HTTP — the daemon is auto-started on `mm launch` if not already running.

### Global Options

| Option              | Description                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <path>`  | Target a specific project directory (absolute or relative). Overrides `MM_PROJECT` and git-based discovery.                                                                                                      |
| `--observe <level>` | Observation to return after the call: `none`, `diff` or `full`. Sent as `observe` in every tool, `/launch` and `/cleanup` request body. Default: `diff` for mutating commands and `run-steps`, `none` otherwise. |
| `--pretty`          | Indent JSON results with 2 spaces. Default: one line per result when stdout is not a terminal (agents, pipes, files), indented on a terminal. Consumed anywhere in the command line, like `--observe`.           |

| Environment Variable | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `MM_PROJECT`         | Default project directory when `--project` is not provided. Falls back to the current git worktree root. |
| `MM_PRETTY`          | `1`/`true`: indent JSON results; `0`/`false`: one line, also on a terminal. `--pretty` takes precedence. |

### Project Targeting

By default, the CLI resolves the target project from the current git worktree. This works when running from inside the project directory. For other scenarios, the resolution order is:

1. **`--project <path>`** — Explicit flag, highest priority. Accepts absolute or relative paths.
2. **`MM_PROJECT`** — Environment variable. Useful for setting once in agent config or shell profile.
3. **Git worktree** — `git rev-parse --show-toplevel` from the current working directory (existing behavior).

```bash
# From inside the project (unchanged)
mm launch

# From a parent folder containing multiple repos
mm --project ./metamask-extension launch

# Via environment variable
export MM_PROJECT=/path/to/metamask-extension
mm describe-screen
```

### Lifecycle

| Command                                                                                                                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mm launch [--context e2e\|prod] [--state default\|onboarding\|custom] [--extension-path <path>] [--force]`                                                     | Auto-starts the daemon if needed, then launches a headed Chrome session with the configured extension. Use `--context` to set the environment context before launching. Use `--state` to control wallet initialization. Use `--extension-path` to override the extension directory. Use `--force` to replace an existing session.                                                                                                                                                                                                                |
| `mm launch --platform ios\|android [--device-id <id>] [--app-bundle <path>] [--metro-port <port>] [--reinstall] [--reset-app-data] [--allow-fox-code-mismatch]` | Launches a mobile session. Use `--device-id` to target a specific device (auto-detected when exactly one is connected). Use `--app-bundle` to install a specific app artifact before launching. Use `--metro-port` to attach to a running Metro bundler (development builds). `--reinstall` and `--reset-app-data` are **destructive** to the app container and wallet state; `--allow-fox-code-mismatch` bypasses the consumer's app-identity guard. Consumers decide how to honor these — see [Mobile launch options](#mobile-launch-options). |
| `mm cleanup [--shutdown]`                                                                                                                                       | Stops the browser, tears down test services (fixture server, Anvil, mock server), and releases session resources. Add `--shutdown` to also terminate the daemon process.                                                                                                                                                                                                                                                                                                                                                                         |
| `mm stop [--force]`                                                                                                                                             | Stops the daemon process (symmetric to `mm serve`). Sends a best-effort cleanup before shutdown. Use `--force` to remove stale `.mm-server` state from crashed daemons.                                                                                                                                                                                                                                                                                                                                                                          |
| `mm status`                                                                                                                                                     | Displays the daemon's current status: PID, port, uptime, allocated sub-ports, and whether a browser session is active.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mm serve [--background]`                                                                                                                                       | Manually starts the HTTP daemon without launching a browser session. Use `--background` to detach the process. Fails if a daemon is already running for this worktree.                                                                                                                                                                                                                                                                                                                                                                           |

### Interaction

| Command                                                                                       | Description                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mm click <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]`       | Clicks an element by its accessibility reference (e.g., `e3`). The ref comes from a prior `describe-screen` call. Waits for the element to be visible before clicking. The `--timeout` covers the entire operation (visibility wait + click action). Default: 15s. Use `--within` to scope the target inside a parent element (`testid:<id>`, `selector:<css>`, or a bare a11y ref). |
| `mm type <ref> <text> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]` | Types text into an input element identified by its accessibility reference. Clears the field first, then sets the new value (uses Playwright's `fill()`). Accepts `--timeout` for the total time budget (default: 15s). Use `--within` to scope the target inside a parent element.                                                                                                  |
| `mm get-text <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]`    | Reads the text content of an element. Returns the inner text, target descriptor, and character length. Accepts `--timeout` for the total time budget (default: 15s). Useful for asserting visible values without screenshots.                                                                                                                                                        |
| `mm describe-screen`                                                                          | Captures the full screen state: extension info, visible test IDs, and a trimmed accessibility tree with deterministic refs (`e1`, `e2`, ...). This is the primary command for understanding what's on screen before interacting.                                                                                                                                                     |
| `mm screenshot [--name <name>]`                                                               | Takes a full-page screenshot of the current page. Saves to the artifacts directory. Use `--name` to set a descriptive filename.                                                                                                                                                                                                                                                      |
| `mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]`    | Blocks until an element identified by its accessibility reference becomes visible, or the timeout expires. Default timeout is 15 seconds. Use `--within` to scope the target inside a parent element.                                                                                                                                                                                |
| `mm wait-for-notification [--timeout <ms>]`                                                   | Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.                                                                                                                                                                                                                                                                            |
| `mm clipboard <read\|write> [text]`                                                           | Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.                                                                                                                                                                                                                                                     |

### Navigation

| Command                                                   | Description                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mm navigate <url>`                                       | Opens a new tab and navigates to the given URL. Useful for navigating to dApps or external pages.                                                |
| `mm navigate-home`                                        | Navigates the extension tab to the wallet home screen.                                                                                           |
| `mm navigate-settings`                                    | Navigates the extension tab to the settings page.                                                                                                |
| `mm switch-to-tab <role> \| --role <role> \| --url <url>` | Switches the active page to a tab matching a given role (e.g., `extension`, `dapp`) or URL prefix. Supports a positional role as first argument. |
| `mm close-tab --role <role> \| --url <url>`               | Closes a browser tab matching a given role or URL. Falls back to the extension tab if the active tab is closed.                                  |

### State & Context

| Command                      | Description                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm get-state`               | Returns the current extension state: loaded status, current URL, screen name, network, chain ID, account address, and balance. Also lists all tracked browser tabs. Observations do not carry state, so use this command for it. On mobile the state is partial (`source: "stub"`): fields that were not read from the app are omitted. |
| `mm get-context`             | Returns the current environment context (`e2e` or `prod`), session status, available capabilities, and whether context switching is allowed.                                                                                                                                                                                            |
| `mm set-context <e2e\|prod>` | Switches the session environment between `e2e` and `prod` modes. Blocked while a session is active — run `mm cleanup` first.                                                                                                                                                                                                            |

### Batching

| Command               | Description                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mm run-steps <json>` | Executes a batch of tool invocations sequentially from a JSON definition. Each step specifies a tool name and arguments. |

### Advanced

| Command                                                                             | Description                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm mock-network add '<json-rule-or-config>'`                                       | Adds targeted route mocks during an active session. Pass either a single rule, an array of rules, or an object with a `routes` array.                                                                                                                |
| `mm mock-network clear`                                                             | Clears route mocks and recorded requests.                                                                                                                                                                                                            |
| `mm mock-network list`                                                              | Lists active route mocks.                                                                                                                                                                                                                            |
| `mm mock-network requests [--limit <n>]`                                            | Shows recorded matched and missed requests.                                                                                                                                                                                                          |
| `mm cdp <method> [params-json] [--timeout <ms>] [--metro-port <p>] [--app-id <id>]` | Sends a raw Chrome DevTools Protocol command against the active session. Escape hatch for when structured tools are insufficient. Works on both browser and mobile (Hermes) — the target runtime and blocked methods differ by platform (see below). |

```bash
mm cdp Runtime.evaluate '{"expression":"document.title"}'
mm cdp Network.enable
mm cdp DOM.getDocument '{"depth":2}' --timeout 60000
```

The `params-json` argument must be a valid JSON object. The `--timeout` flag sets a per-command timeout (default: 30 000 ms, max: 30 000 ms). The tool is categorized as `cdp`: by default it returns no observation and does not refresh refs, so pass `--observe full` (or run `mm describe-screen`) after a call that changes state.

#### Browser vs Mobile (Hermes) CDP

`cdp` dispatches through the active platform driver, so the same command works on a browser or a mobile session — but the two targets are not interchangeable:

| Aspect              | Browser (Playwright)                                                                             | Mobile (React Native Hermes)                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Target runtime      | The page's Chrome DevTools target                                                                | The app's Hermes JS engine, via Metro's inspector proxy                                                              |
| Available domains   | Full Chrome surface — `Runtime`, `DOM`, `Network`, `Page`, `Accessibility`, …                    | JS-engine subset only — `Runtime`, `Debugger`, `Log`, `HeapProfiler` (no `DOM` / `Page` / `Network`)                 |
| Blocked methods     | `Browser.close`, `Target.closeTarget`, `Target.disposeBrowserContext`, `Browser.crashGpuProcess` | `Runtime.terminateExecution`, `Inspector.detached`                                                                   |
| `metroPort`/`appId` | Ignored                                                                                          | Select the Metro inspector port (default `8081`) and target app (`io.metamask.MetaMask` iOS / `io.metamask` Android) |
| Prerequisite        | An active browser session                                                                        | An active mobile session with a DEBUG build and Metro running                                                        |
| Errors              | `MM_CDP_BLOCKED` / `MM_CDP_FAILED`                                                               | `MM_CDP_BLOCKED` / `MM_CDP_FAILED` (the underlying `HERMES_*` code is preserved in the message)                      |

On mobile, `Runtime.evaluate` nests its value at `result.result.value`. Metro defaults can also be set globally via the `HERMES_METRO_PORT` / `HERMES_APP_ID` env vars on the `@metamask/device-mcp` backend.

```bash
# Mobile (Hermes) — evaluate JS in the running app
mm cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}' --app-id io.metamask --metro-port 8081
```

#### Hermes targets (mobile only)

| Command                                                        | Description                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm hermes-targets [--all] [--metro-port <p>] [--app-id <id>]` | Lists and diagnoses the debuggable Hermes targets Metro exposes, reporting which target would be chosen or why selection is ambiguous. Pass `--all` to bypass the appId filter and discover the real appId. Mobile only — there is no browser equivalent. |

```bash
mm hermes-targets
mm hermes-targets --all
```

#### Mobile launch options

`mm launch --platform ios|android` accepts additional options that the core
validates and forwards verbatim to the consumer's `ISessionManager.launch()`.
The core does **not** act on them itself — it owns no install or device
lifecycle. Each consumer decides how (or whether) to honor them:

| Option                      | Field                  | Meaning                                                                          |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `--device-id <id>`          | `deviceId`             | Target a specific device. Auto-detected when exactly one is connected.           |
| `--app-bundle <path>`       | `appBundlePath`        | App artifact to install before launching (iOS `.app`, Android `.apk`).           |
| `--metro-port <port>`       | `metroPort`            | Metro bundler / inspector proxy port for watch-mode attach (development builds). |
| `--reinstall`               | `reinstall`            | **Destructive.** Uninstall and reinstall the app, discarding its container.      |
| `--reset-app-data`          | `resetAppData`         | **Destructive.** Clear app data, discarding existing wallet state.               |
| `--allow-fox-code-mismatch` | `allowFoxCodeMismatch` | **Dangerous.** Bypass the consumer's app-identity compatibility guard.           |

```bash
# Reuse whatever is already installed on the only booted device
mm launch --platform ios

# Install a specific build on a specific simulator
mm launch --platform ios --device-id <UDID> --app-bundle ios/build/MetaMask.app

# Attach to a running Metro bundler (development build)
mm launch --platform ios --metro-port 8081

# Replace the installed app, discarding wallet state
mm launch --platform ios --app-bundle ios/build/MetaMask.app --reinstall
```

The destructive flags default to `false`. Because they can irreversibly destroy
real wallet state in a prod-context session, consumers are expected to guard
them — for example by refusing `--reinstall` when no `--app-bundle` is supplied,
or by requiring `--allow-fox-code-mismatch` before replacing an app whose
identity differs from the installed one.

When a consumer's `launch()` throws an error carrying a `code` that is a known
[`ErrorCode`](#error-classification), the `launch` tool preserves it instead of
collapsing it into `MM_LAUNCH_FAILED`, so precise device/prerequisite failures
reach the agent intact.

#### Mobile device actions (iOS/Android only)

These commands require a mobile session (`mm launch --platform ios|android`). Run on a
browser session, they return `MM_TOOL_NOT_SUPPORTED_ON_PLATFORM`.

| Command                                                                                                    | Description                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `mm scroll-to-element <ref> [--direction up\|down] [--maxAttempts <n>] [--selector <css>] [--testid <id>]` | Scrolls until the target element is visible.                                   |
| `mm device-swipe --direction <up\|down\|left\|right> [--startX <n>] [--startY <n>] [--distance <n>]`       | Swipes the screen in a direction.                                              |
| `mm long-press <ref> [--duration <ms>] [--selector <css>] [--testid <id>]`                                 | Long-presses the target element.                                               |
| `mm tap-coordinates <x> <y>`                                                                               | Taps raw screen coordinates.                                                   |
| `mm dismiss-keyboard`                                                                                      | Dismisses the on-screen keyboard.                                              |
| `mm dismiss-alert [--accept]`                                                                              | Dismisses a native alert; `--accept` accepts it.                               |
| `mm get-alert-text`                                                                                        | Prints the text of a visible native alert.                                     |
| `mm open-app <bundleId>`                                                                                   | Launches or foregrounds an app.                                                |
| `mm close-app <bundleId>`                                                                                  | Terminates an app.                                                             |
| `mm press-button <home\|back\|enter\|lock>`                                                                | Presses a hardware/system button.                                              |
| `mm device-context list` / `mm device-context switch <name>`                                               | Lists or switches native/webview contexts.                                     |
| `mm device-clipboard read` / `mm device-clipboard write <text>`                                            | Reads or writes the device clipboard.                                          |
| `mm screen-recording start [--output <path>]` / `mm screen-recording stop`                                 | Starts or stops a screen recording; `--output` is sandboxed to `artifactsDir`. |
| `mm device-logs [--duration <seconds>] [--filter <text>]`                                                  | Fetches device logs.                                                           |
| `mm generate-locators`                                                                                     | Lists ranked selector suggestions for on-screen elements.                      |

```bash
mm scroll-to-element e12 --direction down
mm device-swipe --direction up --distance 400
mm open-app io.metamask
mm device-context switch WEBVIEW_1
mm device-logs --filter MetaMask --duration 30
mm generate-locators
```

For the full agent-facing reference and workflow guidelines, see [SKILL.md](./SKILL.md).

## Error Classification

Tool errors are classified into specific error codes for structured handling:

| Code                                | Meaning                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Session & Lifecycle**             |                                                                                                         |
| `MM_NO_ACTIVE_SESSION`              | No browser session running                                                                              |
| `MM_SESSION_ALREADY_RUNNING`        | Session already exists                                                                                  |
| `MM_LAUNCH_FAILED`                  | Browser session launch failed                                                                           |
| `MM_PAGE_CLOSED`                    | Browser page was closed unexpectedly                                                                    |
| **Build**                           |                                                                                                         |
| `MM_BUILD_FAILED`                   | Extension build failed                                                                                  |
| `MM_DEPENDENCIES_MISSING`           | Required build dependencies not installed                                                               |
| **Interaction**                     |                                                                                                         |
| `MM_TARGET_NOT_FOUND`               | Element not found by ref, testId, or selector                                                           |
| `MM_WAIT_TIMEOUT`                   | Timeout waiting for element visibility                                                                  |
| `MM_CLICK_FAILED`                   | Click operation failed                                                                                  |
| `MM_CLICK_TIMEOUT`                  | Click action timed out (element found, click hung)                                                      |
| `MM_TYPE_FAILED`                    | Type operation failed                                                                                   |
| `MM_TYPE_TIMEOUT`                   | Fill action timed out                                                                                   |
| `MM_GETTEXT_FAILED`                 | getText operation failed                                                                                |
| `MM_GETTEXT_TIMEOUT`                | textContent action timed out                                                                            |
| **Clipboard**                       |                                                                                                         |
| `MM_CLIPBOARD_PERMISSION_DENIED`    | Clipboard permission denied by browser                                                                  |
| `MM_CLIPBOARD_LAVAMOAT_BLOCKED`     | Clipboard blocked by LavaMoat policy                                                                    |
| `MM_CLIPBOARD_FAILED`               | Clipboard operation failed                                                                              |
| **Navigation & Tabs**               |                                                                                                         |
| `MM_NAVIGATION_FAILED`              | Navigation error or network failure                                                                     |
| `MM_NOTIFICATION_TIMEOUT`           | Notification popup did not appear                                                                       |
| `MM_TAB_NOT_FOUND`                  | Tab not found by role or URL                                                                            |
| **Discovery & State**               |                                                                                                         |
| `MM_DISCOVERY_FAILED`               | Discovery tool failure                                                                                  |
| `MM_SCREENSHOT_FAILED`              | Screenshot capture failure                                                                              |
| `MM_STATE_FAILED`                   | State retrieval failed                                                                                  |
| **Contracts**                       |                                                                                                         |
| `MM_CONTRACT_NOT_FOUND`             | Unknown contract name                                                                                   |
| `MM_SEED_FAILED`                    | Contract deployment failure                                                                             |
| **Context & Config**                |                                                                                                         |
| `MM_CONTEXT_SWITCH_BLOCKED`         | Context switch while session is active                                                                  |
| `MM_SET_CONTEXT_FAILED`             | Context switch operation failed                                                                         |
| `MM_CAPABILITY_NOT_AVAILABLE`       | Feature requires a capability not configured                                                            |
| `MM_INVALID_INPUT`                  | Bad parameters                                                                                          |
| `MM_INVALID_CONFIG`                 | Invalid configuration                                                                                   |
| `MM_PORT_IN_USE`                    | Port already in use                                                                                     |
| **System**                          |                                                                                                         |
| `MM_UNKNOWN_TOOL`                   | Unknown tool name                                                                                       |
| `MM_REQUEST_ABORTED`                | Internal: a cancelled (timed-out) call stopped; the caller gets the timeout error                       |
| `MM_INTERNAL_ERROR`                 | Internal server error                                                                                   |
| `MM_BATCH_TIMEOUT`                  | `batchTimeoutMs` deadline exceeded in run_steps                                                         |
| `MM_CDP_BLOCKED`                    | CDP method is blocked (destructive to session); on mobile the Hermes blocklist maps here too            |
| `MM_CDP_FAILED`                     | CDP command execution failed or timed out (on mobile, the underlying `HERMES_*` code is in the message) |
| `MM_HERMES_FAILED`                  | `hermes_targets` discovery failed (underlying `HERMES_*` code is in the message)                        |
| `MM_HERMES_NOT_AVAILABLE`           | `hermes_targets` used outside a mobile (iOS/Android) session                                            |
| `MM_DEVICE_ACTION_FAILED`           | A mobile device action (swipe, tap, app control, clipboard, etc.) failed                                |
| `MM_DEVICE_NOT_AVAILABLE`           | A mobile-only tool was invoked without a mobile driver capability                                       |
| `MM_TOOL_NOT_SUPPORTED_ON_PLATFORM` | Tool gated off the active platform (browser-only tool on mobile, or mobile-only tool on browser)        |

## Development

```bash
yarn build        # Build the package
yarn test         # Run tests and type checks
yarn lint         # Lint everything
yarn lint:fix     # Auto-fix lint issues
```

## License

(MIT OR Apache-2.0)
