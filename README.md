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
  │  │ /status  │  │               │  │  44 tools  │                  │
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
node_modules/.bin/mm launch     # or: yarn mm launch

# Global installation
mm launch
```

For agents and scripts that call the CLI many times, call the bin directly
(`node_modules/.bin/mm`, or an alias to it), not `yarn mm` or `npx mm`. The
CLI itself starts in about 0.1 s; `yarn mm` adds about 0.35-0.45 s and
`npx mm` about 0.3 s to every call (measured on macOS with Yarn 4).

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

Use `node_modules/.bin/mm` (or `yarn mm`) in place of `mm` when the CLI is installed as a project dependency.

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
- **Logs**: Daemon activity is logged to `.mm-daemon.log`. Tool failures are answered with HTTP 200 and `ok: false` in the body, so each request line also has the outcome: `POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT 15080ms`, or `ok=true`. A `run_steps` line with failed steps adds `failed=<n>/<total>` and the first failed step's code. `grep ok=false .mm-daemon.log` lists the failed calls. The line also says what the call acted on: `ref=`, `testid=`, `selector=`, `screen=`, `role=`, `url=` (redacted like `mm network`), `method=` (CDP method only, never its params), `button=` or `direction=` from the request, `steps=` with the tool of each `run_steps` step (for example `steps=click,wait_for`; step args are not logged, so a batch line has no element targets), and `file=` with the saved screenshot's file name. Typed and clipboard text are never logged. Each value is one token: whitespace, control characters and `%` are percent-encoded and values are cut to 200 characters, for example `selector=text=Create%20a%20new%20wallet`.

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

A mobile `launch()` may also return the `metroPort` and `deviceId` it resolved.
Core keeps them as the session's Hermes defaults when the launch flags do not
set them, so later `mm cdp` and `mm hermes-targets` calls use them. Without
either, those tools fall back to `HERMES_METRO_PORT`, then `8081`.

### Session-scoped device teardown

Core captures `sessionManager.getPlatformDriver?.()` before calling the consumer's `cleanup()`, then calls the driver's optional `dispose()` hook. Disposal runs even when consumer cleanup fails. This applies to `mm cleanup`, forced relaunch, failed launch, daemon shutdown, and server startup rollback. A failed disposal fails that cleanup call and is retained for a later attempt. The daemon owns that retention (one per `createServer` instance), so a later `mm cleanup`, forced relaunch, or daemon stop retries it, whatever wrapper of the session manager a tool receives. Only the current session's cleanup and disposal can fail a call. Drivers retained from earlier sessions are retried best-effort and in parallel. When they fail again, the daemon writes a `[WARN]` line to its log, and the current cleanup or launch continues. Tools reach this retention through `ToolContext.cleanupSession()`; without it (a context built outside the daemon), the tools fall back to retention per session-manager object.

`MobilePlatformDriver.dispose()` delegates to its backend's optional `dispose()` hook. Core depends on `@metamask/device-mcp` ^0.9.0, so the consumer must create its backend from the same ^0.9.0 range: the Android fixes and the `dispose()` hook live in the consumer's copy of device-mcp. On iOS, the device-mcp `IdbBackend` uses a private IDB companion per backend, and disposal stops only that backend's companion and recording. The ADB backend has no disposal hook, so disposal does nothing on Android.

Consumers must expose a session-owned driver through `getPlatformDriver()` and create a fresh driver/backend for each launch. If launch fails before the driver is exposed, the consumer must dispose that locally held driver in its own failure path. Direct calls to a consumer's `cleanup()` also remain the consumer's responsibility.

`mm cleanup --shutdown` additionally stops the worktree's daemon. Driver disposal does not shut down a simulator, stop Metro, or terminate shared IDB companions. Use separate worktrees/daemons and explicit device IDs for independent agent sessions. Separate companions isolate connection teardown even for the same simulator; app state on that simulator remains shared.

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

| Tool                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifecycle**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `build`                       | Triggers an extension build using the configured `BuildCapability`. Accepts build type and force options.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `launch`                      | Launches a new browser session with the configured extension. Supports state modes (`default`, `onboarding`, `custom`), fixture presets, tag metadata, and optional contract seeding on start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cleanup`                     | Tears down the active browser session and cleans up all resources (browser, services, fixtures).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Interaction**               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `click`                       | Clicks an element identified by a11y ref, test ID, or CSS selector. Waits for the element to be visible before clicking. Supports `within` to scope the target inside a parent element, and `frame` (browser) to target inside an iframe. Browser: a visually hidden (at most 1×1 pixel) checkbox or radio with one label is toggled by clicking its label, and the result has `clickedLabel: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `type`                        | Types text into an input element identified by a11y ref, test ID, or CSS selector. Clears the field first, then sets the new value (uses Playwright's `fill()`). Supports `within` and `frame` scoping. On the browser, a read-only or disabled element fails at once with `MM_ELEMENT_NOT_EDITABLE` instead of waiting for the timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait_for`                    | Waits for an element to become visible on the page within a configurable timeout. Supports `within` to scope the target inside a parent element, and `frame` (browser) to target inside an iframe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scroll_to_element`           | Scrolls until an element (a11y ref, test ID, or selector) is visible. Browser: waits for the element (`timeoutMs`, default 15 000), then scrolls it into view, also inside a scrollable container; supports `within`; ignores `direction` and `maxAttempts`. Mobile: swipes until the target is inside the viewport, not only in the UI tree, and returns `swipes`, `inViewport` and `bounds`; `direction` is the content direction (`down` reveals content below), default `auto` picks it from the element's position; `maxAttempts` = maximum swipes (default 10); fails with `MM_TARGET_NOT_VISIBLE` (found, not in view) or `MM_TARGET_NOT_FOUND`; `within` is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_text`                    | Reads the text content of an element identified by a11y ref, test ID, or CSS selector. Returns the text, target descriptor, and character length. Supports `within` and `frame` scoping. Categorized as read-only (no observations in response).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `inspect`                     | Browser only. Reads an element's attributes, `disabled` and `readOnly` flags, computed `styles` (`styles` input, default `color`, `background-color`, `opacity`, `cursor`) and `effectiveOpacity` (opacity including ancestors), so two elements can be compared by value. Read in an isolated world, so Extension page restrictions do not apply. Supports `within` and `frame` scoping. Categorized as read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `hover`                       | Browser only. Moves the pointer over an element (a11y ref, test ID, or selector) with Playwright's `locator.hover()`, so its hover state shows. Waits for the element like `click`; supports `timeoutMs` (default 15 000), `within` and `frame`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unhover`                     | Browser only. Moves the pointer off the page, so the hovered element loses its hover state and no other element gets one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `set_viewport`                | Browser only. Sets the active page's viewport to `width` × `height` CSS pixels (width 100–7680, height 100–4320). It stays across reloads of that page. Returns the new size and `original`, the size before the first change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reset_viewport`              | Browser only. Restores the viewport the active page had before its first `set_viewport`. Returns `reset: false` when `set_viewport` was not used on the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `clipboard`                   | Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Navigation**                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `navigate`                    | Navigates the browser to a named screen (`home`, `settings`, `notification`) or an arbitrary URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `reload`                      | Reloads the active page, keeping its URL and hash route. Discards in-memory page state such as cached API data, so the page fetches again through the current network mocks. Browser only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `switch_to_tab`               | Switches the active page to a tab matching a given role (e.g., `extension`, `dapp`) or URL prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `close_tab`                   | Closes a browser tab matching a given role or URL. Falls back to the extension tab if the active tab is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `wait_for_notification`       | Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Discovery**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `describe_screen`             | Captures a comprehensive screen snapshot: extension state, visible test IDs, trimmed a11y tree with refs (visible iframes included, refs `f1e1`, ...), and optional screenshot. Browser: `frame` lists only the content of that iframe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `accessibility_snapshot`      | Captures a trimmed accessibility tree of the current page with deterministic refs (`e1`, `e2`, ...). Supports scoping to a root CSS selector.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `list_testids`                | Collects all visible `data-testid` attributes from the current page with text previews and visibility status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **State**                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_state`                   | Retrieves the current extension state (URL, screen, network, balance, account) and tracked tab information. On mobile the state is partial (`source: 'stub'`): fields that were not read from the app are omitted, not guessed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_context`                 | Returns the current environment context (`e2e` or `prod`), session status, available capabilities, and whether context switching is allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `set_context`                 | Switches the session environment between `e2e` and `prod` modes. Blocked while a session is active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Screenshots**               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `screenshot`                  | Captures a screenshot of the current page. Supports naming, full-page capture, scoping to a CSS selector, and optional base64 output. Browser: `frame` captures an iframe, or the `selector` element inside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Contracts**                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `seed_contract`               | Deploys a single smart contract to the local Anvil chain by name. Requires `ContractSeedingCapability`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `seed_contracts`              | Deploys multiple smart contracts in sequence. Returns both successful deployments and individual failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `get_contract_address`        | Looks up the deployed address of a contract by name from the session's deployment registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `list_contracts`              | Lists all contracts deployed in the current session with addresses and deployment timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Batching**                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run_steps`                   | Executes a batch of tool invocations sequentially. Supports `stopOnError` to halt on first failure, a top-level `observe` level for the single observation collected after the batch (default `diff`; without one, the last executed step's `observe` is used), and `batchTimeoutMs` (1 000–30 000 ms) to set an overall deadline (checked between steps; remaining steps are skipped, partial results are returned). The daemon queue and the CLI wait for the deadline plus the slowest step's own timeout, so a step in progress is never cut off by `MM_QUEUE_TIMEOUT`; without `batchTimeoutMs` the call keeps the daemon queue default (30 s, or 180 s when the host sets it). Accepts tool aliases like `navigate_home` / `navigate-home`. Returns per-step results with timing.                                                                                                                                                                                                                                                                                                                          |
| **Advanced**                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mock_network`                | Adds, clears, lists, and inspects targeted Playwright network mocks on the active browser context. Unmatched same-origin requests are continued unchanged. A rule with `record` and no `response` records the real request and forwards it unchanged. Rules can opt in to record request bodies and headers (redacted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `events`                      | Bookmarks or clears the session event buffer that `mm logs` and `mm network` read: `mark` returns the current cursor (one cursor for both) and `summary.startedAt`; `clear` empties it without resetting the cursor. The buffer starts with a browser session and keeps the newest 1000 console and 2000 network records. Browser only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `logs`                        | Read-only. Console errors and uncaught exceptions of every page and the Extension service worker, from the session event buffer: `{ records, cursor, hasMore, gap, summary }`, oldest first, with `cursor`/`since`/`limit`/`grep`. Records `error` only by default; `configure` widens the levels for the session (`warn` is accepted as `warning`). Object and array arguments are rendered from their CDP preview (a sensitive property name prints `[REDACTED]`), and a leading format string fills its `%s`/`%d`/`%o` specifiers. URLs in the text and the values of sensitive object fields (`privateKey`, `mnemonic`, `password`, …) are redacted; plain string contents are not scanned (JWTs and `Bearer` tokens excepted). Text is cut at 2000 characters. Browser only.                                                                                                                                                                                                                                                                                                                                |
| `network`                     | Read-only, passive. HTTP(S) requests of every page and the Extension service worker, from the session event buffer: one record per request with method, redacted URL, type, status, duration (`ms`), `failure`, JSON-RPC `rpcMethods` and, after `configure` with `rpcErrors`, the JSON-RPC `rpcError`. Filters: `cursor`, `since`, `limit`, `url` (glob or text), `errors`, `settled`; a filtered or `settled` read returns settled requests only, ordered by `settledSeq`. Never routes or changes a request; no bodies are stored. Browser only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cdp`                         | Sends a raw Chrome DevTools Protocol command, dispatched through the active platform driver. **Browser:** targets the active page (`target: "page"`, default) or the Extension service worker (`target: "sw"`) on a persistent CDP session shared across calls, so enabled domains and listeners survive; `fresh: true` uses a one-shot session. Full Runtime/DOM/Network/Page surface; destructive methods (`Browser.close`, `Target.closeTarget`, etc.) are blocked. **Mobile (iOS/Android):** targets the app's React Native Hermes JS runtime via Metro's inspector proxy (delegates to `@metamask/device-mcp`, needs a DEBUG build with Metro running); only the JS-engine subset exists (`Runtime`, `Debugger`, `Log`, `HeapProfiler` — no DOM/Page/Network) and `Runtime.terminateExecution` / `Inspector.detached` are blocked. Optional `metroPort` / `appId` are mobile-only (ignored on browser). Categorized as `cdp`: no observation is collected and refs are not refreshed, so run `describe_screen` after a call that changes state. See [Browser vs Mobile CDP](#browser-vs-mobile-hermes-cdp). |
| **Hermes (mobile only)**      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hermes_targets`              | Lists and diagnoses the debuggable Hermes targets Metro exposes (iOS and Android), reporting which target would be chosen or why selection is ambiguous. Use to confirm Metro is running and the app is registered. Pass `all` to bypass the appId filter and discover the real appId. Mobile only — there is no browser equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Mobile (iOS/Android only)** |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `device_swipe`                | Swipes the screen in a `direction` (`up`/`down`/`left`/`right`), with optional `startX`/`startY`/`distance`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `long_press`                  | Long-presses an element (a11y ref, test ID, or selector) for an optional `durationMs`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tap_coordinates`             | Taps raw `x`/`y` screen coordinates. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dismiss_keyboard`            | Dismisses the on-screen keyboard. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dismiss_alert`               | Dismisses a native alert, accepting it when `accept` is true. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `get_alert_text`              | Returns the text of a visible native alert. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `open_app`                    | Launches or foregrounds an app by `bundleId`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `close_app`                   | Terminates an app by `bundleId`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `press_button`                | Presses a hardware/system button. One of `home`, `back`, `enter`, `lock`. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `device_context`              | Lists native/webview contexts (`list`) or switches to one (`switch` + `name`). Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `device_clipboard`            | Reads (`read`) or writes (`write` + `text`) the device clipboard. Distinct from the browser `clipboard` tool (which uses CDP). Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `screen_recording`            | Starts (`start`, optional `outputPath`) or stops (`stop`) a screen recording. When provided, `outputPath` is sandboxed to the configured `artifactsDir` (paths escaping it are rejected). Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `device_logs`                 | Fetches device logs with optional `durationSeconds` and `filter`. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `generate_locators`           | Generates ranked locator suggestions (identifier > label > text > type, with confidence) for every interactive element on the current screen, by walking the device snapshot. Read-only. Mobile only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Accessibility References

The core uses Chrome DevTools Protocol accessibility APIs to build a deterministic reference map of interactive and meaningful accessibility nodes. Each element gets a short ref like `e1`, `e2`, etc., mapped to a Playwright-compatible selector. Each browser ref resolves to exactly one element, or the action fails (strict mode) instead of acting on another element. The snapshot ties each ref to its DOM node: it adds a token of the snapshot to the element's `data-mm-ref` attribute (from an isolated world, so it works under LavaMoat), and the ref selects that token (`[data-mm-ref~="<token>"]`). A ref therefore does not depend on the role or the accessible name, which Chromium's accessibility tree and Playwright do not always agree on (an `<a>` without `href` is a link for Chromium only) and which can hold live values such as prices. An element keeps the tokens of its last 4 snapshots, so a later snapshot does not invalidate the refs of an earlier one. When the element of a ref was removed or re-mounted after the snapshot, an action on the ref fails at once with `MM_TARGET_NOT_FOUND`; take a new snapshot. When React reuses the node for other content (a "Next" button becomes "Confirm"), the ref fails the same way, naming the old and new text: the ref also checks the element's text from the snapshot (`>> internal:has-text=/^…$/`), with live values (decimals, amounts with a currency sign, percentages, times like `00:59`) masked and plain integers kept, so `Earn $2.42 +3.92%` still matches `Earn $2.43 -0.10%` but `Account 1` does not match `Account 2`. Elements without text (icon buttons) or with more than 100 characters of text get no text check. Refs to elements in closed shadow roots always fail. A node that cannot be stamped falls back to `role=<role>[name="<name>" s]` (exact, case-sensitive accessible name), or `text="<name>"` for generic elements; both fail in strict mode when ambiguous, and are prefixed with the root selector in a scoped `accessibility_snapshot`.

Iframes (browser): a snapshot of the whole page (`describe_screen`, `accessibility_snapshot` without `rootSelector`, observations) gives each iframe element a ref (role `iframe`) and also lists the content of up to 5 visible iframes with content, after the page's nodes; it reads at most the first 10 iframes, so many empty or hidden iframes stay cheap. The nodes of the first such iframe get refs `f1e1`, `f1e2`, ..., the second `f2e1`, ..., and a `path` that starts with the iframe's own path and `iframe:<title>`. Their selectors continue inside the iframe (`<iframe selector> >> internal:control=enter-frame >> role=...`, what Playwright's `frameLocator` builds), where the iframe selector is its `[data-testid="..."]` when that test ID is unique on the page, else the iframe's ref stamp, so `mm click f1e2` acts inside the frame, including cross-origin (out-of-process) iframes. A same-origin iframe is read on the page's CDP session; a cross-origin one, which site isolation runs in another process, on its own session. Inside iframes, refs that share a role and name keep the role selector and fail in strict mode, and generic elements use `text=`. Iframes inside iframes are not read. `describe_screen` with `frame` (`mm describe-screen --frame <iframe>`) lists only that iframe; its refs take a frame number above the `f1` to `f5` of page snapshots (`f6e1`, ..., then `f7` for the next one), so a later page snapshot never reuses it, and are added to the current refs. `click`, `type`, `hover`, `wait_for`, `get_text` and `inspect` take `frame` to target a `testId` or `selector` inside an iframe (`within` is then searched in the iframe too), and `screenshot` takes `frame` to capture the iframe or its `selector` element. `frame` is the iframe element as a test ID, selector or ref; it cannot be combined with a ref target or a ref `within` (refs already point into their frame), and it is rejected on mobile. The `mm` CLI rejects `--frame` on `scroll-to-element` and `long-press`.

Agents call `describe_screen` to get the current reference map, then use refs for interaction:

```
mm describe-screen    → { ..., a11y: [{ ref: "e1", role: "button", name: "Submit" }, ...] }
mm click e1           → clicks the "Submit" button
mm type e3 "hello"    → types into the element mapped to e3
```

This accessibility-first approach provides reliable element targeting that survives minor UI changes.

Refs are numbered in tree order each time the daemon reads the screen (`describe_screen`, `accessibility_snapshot`, or an observation). The same screen gives the same refs, so an unchanged screen diffs as unchanged. When elements appear or disappear above an element, its ref can change: use the refs from the latest response. When a call returns both a tree and an observation (for example `describe_screen` with `observe`), the observation's refs are the ones that resolve. `list_testids` does not change refs.

On mobile, after a mutating or batch call, the daemon may take the snapshot again after 300 ms: while it shows a busy element (a label ending in `, busy`, an Android `ProgressBar`, or an iOS `ActivityIndicator` / `ProgressIndicator` / `UIActivityIndicatorView`), once when it still looks like a screen tearing down (the tree lost a large part of its nodes but kept most of the previous screen's test IDs; on Android a navigating tap can be observed as the old screen, half removed), and at most once when it still equals the previous screen (not when the first snapshot took 1 s or more: the screen already had that time to change). In total at most 3 extra snapshots, and no wait that would end more than about 2 s after the first snapshot started. The test IDs come from the same snapshot as the tree. `describe_screen` on mobile also takes one snapshot for both.

The settle does not wait for a screen that is slow to appear. On Android, the first visit to a tab after an app restart (seen on the MetaMask Mobile Explore and Money tabs, dev build) can show the old screen for about 2 s after the tap (measured on Explore). In that time the observation still shows the old screen, whole or partly removed, and so does a `describe_screen` that runs right after the click. Later visits to the same tab show the new screen at once. A small change on the old screen, such as the tapped button's press feedback, counts as a change, so no unchanged retry runs and the click's `screenChanged` is `true`. To wait for a new screen, call `wait_for` on its test ID.

On mobile, each observation, `describe_screen`, `list_testids` and `accessibility_snapshot` takes one device snapshot (plus the settle retries above). The consumer's `DeviceBackend` takes the snapshot. With the `@metamask/device-mcp` ADB backend (0.6.0 or later), Android snapshots use a signed test-only helper APK by default (`helper-first`). The backend installs it on the device the first time, so the first snapshot takes longer. To use only `uiautomator dump`, set `DEVICE_MCP_ADB_SNAPSHOT=dump` or the backend's `adb.snapshotMode` option. See the device-mcp README. The viewport for `visible` comes from the snapshot's root frames; the device window size is read at most once per session (and not refreshed after a rotation), only when a snapshot has no root frame. Elements that are not part of the app are removed from the tree, the refs, the test IDs and `generate_locators`: on Android, the system status bar and navigation bar windows (a full-width or full-height bar window whose ids are all `com.android.systemui:id/*`; other System UI windows such as the biometric prompt stay); on both platforms, the Expo DevLauncher "Tools" button of development builds (iOS `gearshape.fill` and its "Tools" text). Pass `{ excludeDevOverlay: false }` as the third `MobilePlatformDriver` argument to keep the DevLauncher button. Taps and waits inside `@metamask/device-mcp` still search the whole snapshot.

The mobile accessibility tree (`describe_screen`, `accessibility_snapshot`, observations) is a flat list in pre-order with no `path` (on the browser, `path` holds the `role:name` of the ancestor dialogs and headings; on mobile the ancestors are native view classes). Layout-only elements are left out (`pruneLayoutOnly` in `src/platform/mobile-hierarchy.ts`): an element with no label, no value, no identifier, and a type that is not a control or a progress indicator. Its kept descendants take its place, in order. Controls are iOS `Button`, `Link`, `TextField`, `SecureTextField`, `SearchField`, `TextView`, `TextArea`, `Switch`, `Toggle`, `Slider`, `Stepper`, `Picker`, `Cell`, `Tab`, `MenuItem` and similar AX types (exact match, without the `XCUIElementType` prefix), and Android classes ending in `Button`, `EditText`, `CheckBox`, `CheckedTextView`, `Switch`, `SeekBar`, `Spinner`, `RatingBar` and similar. The device snapshot has no `clickable` flag, so a layout-only plain React Native view (`RCTViewComponentView` on iOS, `android.view.ViewGroup` on Android) that has no kept children and is at least 24×24 (iOS points, Android pixels) stays as an unlabelled tap target, for example the iOS wallet home action buttons. Node `bounds` are `{ x, y, width, height }`, in that key order. Node refs number the kept nodes only, and ambiguity is computed over them. A node with a testId, label or value that no other kept node shares resolves by that identity: the target tools look it up again at action time. Two other kinds of node get a bounds ref (their snapshot frame and identity) instead: unnamed nodes (unlabelled tap targets, progress indicators, unnamed controls), and `ambiguous` nodes (another kept node has the same testId, or the same label or value and type, so a lookup could find the other one). Only `click` takes a bounds ref: it takes a new snapshot, finds the element with the same type and identity at the same frame (1 pt/px tolerance), and taps it through the same viewport check and hit test as any other mobile tap; the result's `target` ends in ` (bounds)`. When no such element is there any more (the screen changed), it fails with `MM_TARGET_NOT_FOUND` and taps nothing. `type`, `wait_for`, `get_text`, `scroll_to_element` and `long_press` (also as `run_steps` steps) refuse a bounds ref with `MM_TARGET_NOT_FOUND` before any device call; the error's `hint` names `click` and `tap_coordinates` (unnamed) or a unique test ID (ambiguous). On real MetaMask screens: iOS wallet home 177 → 67 nodes (183 kB with `path` → 10 kB), Android wallet home 625 → 242 nodes (649 kB → 35 kB), Android login 47 → 15 nodes. `list_testids` and `generate_locators` are not affected, and `describe_screen` still returns the full `testIds` list next to the tree.

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
  /** Queue timeout for tools with no action budget, in milliseconds (default: 30_000). Published in the daemon state so the CLI nests above it. */
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
{ ok: true, result: T, observations?: { testIds, a11y, animationsSettled? } }

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

`observe: 'none'` does not refresh the refs. After a call with `none` that changes the screen, the refs from the last observation or `describe_screen` still point at the previous screen. Refs backed by a test ID or an element id fail with `MM_TARGET_NOT_FOUND` when the element is gone, and so do browser refs whose element was removed, re-mounted or now shows other text. Mobile label refs, browser refs that fell back to `role=`/`text=`, and browser refs to elements without text (icon buttons) can match a different element on the new screen. After `none`, target by test ID, or call `describe_screen` (or use `observe: 'full'`) before using refs again.

On the browser, only mutating, batch and `cdp` calls wait for animations to settle (up to 1 s; every running finite animation counts, also off screen, so a long finite animation adds up to 1 s) before the observation. A read-only or discovery call with `observe: 'diff'` or `'full'` (and `describe_screen`) reads the page at once, so right after a `none` mutation it can catch an animation in progress. To get a settled observation, let the mutation itself observe (`diff` or `full`) instead of chaining it with `none`.

When a call waited for animations, its observation has `animationsSettled`: `true` when no finite animation was running at the end of the wait, `false` when the 1 s cap was hit. Infinite animations (spinners) and network requests are not checked, so to wait for content that loads, use `wait_for` on the expected element (on the browser, `selector: 'text=Copied'` waits for visible text). Calls that do not wait, and mobile observations, omit the field.

For `run_steps`, the top-level `observe` sets the level of the one observation collected after the batch. Without it, the `observe` in the last executed step's `args` is used; per-step `observe` on other steps is ignored. `includeObservations` was removed.

Observations contain `testIds`, `a11y` and, when the call waited for animations, `animationsSettled`. They do not include app state; call `get_state` for that.

A call that times out is cancelled: its signal is aborted, it stops at its next step, it collects no observation, and its refs are dropped. `click` and `type` check the signal again after they wait for the target, so a call that timed out during that wait does not click or type. An action that already started is not cancelled. On the browser, the action includes Playwright's own checks inside `locator.click` / `locator.fill` (stable, enabled, not covered), which can wait up to the rest of the call's `timeoutMs`. On mobile, `@metamask/device-mcp` takes no signal: its element wait, tap and `typeText` run until they end, and the driver checks the signal between them.

## CLI Reference

The `mm` CLI provides a unified interface for agents and developers. All commands communicate with the daemon over HTTP — the daemon is auto-started on `mm launch` if not already running.

### Global Options

| Option              | Description                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <path>`  | Target a specific project directory (absolute or relative). Overrides `MM_PROJECT` and git-based discovery.                                                                                                      |
| `--observe <level>` | Observation to return after the call: `none`, `diff` or `full`. Sent as `observe` in every tool, `/launch` and `/cleanup` request body. Default: `diff` for mutating commands and `run-steps`, `none` otherwise. |
| `--pretty`          | Indent JSON results with 2 spaces. Default: one line per result when stdout is not a terminal (agents, pipes, files), indented on a terminal. Consumed anywhere in the command line, like `--observe`.           |

| Environment Variable | Description                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MM_PROJECT`         | Default project directory when `--project` is not provided. Falls back to the current git worktree root.                                                                                                                                                        |
| `MM_PRETTY`          | `1`/`true`: indent JSON results; `0`/`false`: one line, also on a terminal. `--pretty` takes precedence.                                                                                                                                                        |
| `MM_ARTIFACTS_DIR`   | Directory screenshots and other session artifacts are written to. Passed to `ISessionManager.launch()` as `artifactsDir`; defaults to the workflow context's `config.artifactsDir`. The daemon inherits it from the environment of the process that spawned it. |

### Project Targeting

By default, the CLI resolves the target project from the current git worktree. This works when running from inside the project directory. For other scenarios, the resolution order is:

1. **`--project <path>`** — Explicit flag, highest priority. Accepts absolute or relative paths.
2. **`MM_PROJECT`** — Environment variable. Useful for setting once in agent config or shell profile.
3. **Git worktree** — the nearest directory at or above the current working directory that contains a `.git` entry (directory, or file for linked worktrees and submodules). Falls back to `git rev-parse --show-toplevel` when there is none, or when `GIT_DIR` / `GIT_WORK_TREE` is set.

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

| Command                                                                                                                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm launch [--context e2e\|prod] [--state default\|onboarding\|custom] [--extension-path <path>] [--force]`                                                     | Auto-starts the daemon if needed, then launches a headed Chrome session with the configured extension. Use `--context` to set the environment context before launching. Use `--state` to control wallet initialization. Use `--extension-path` to override the extension directory. Use `--force` to replace an existing session.                                                                                                                                                                                                                                                                                       |
| `mm launch --platform ios\|android [--device-id <id>] [--app-bundle <path>] [--metro-port <port>] [--reinstall] [--reset-app-data] [--allow-fox-code-mismatch]` | Launches a mobile session. Use `--device-id` to target a specific device (auto-detected when exactly one is connected). Use `--app-bundle` to install a specific app artifact before launching. Use `--metro-port` to attach to a running Metro bundler (development builds); the session keeps it for later `mm cdp` and `mm hermes-targets` calls. `--reinstall` and `--reset-app-data` are **destructive** to the app container and wallet state; `--allow-fox-code-mismatch` bypasses the consumer's app-identity guard. Consumers decide how to honor these — see [Mobile launch options](#mobile-launch-options). |
| `mm cleanup [--shutdown]`                                                                                                                                       | Stops the browser, tears down test services (fixture server, Anvil, mock server), and releases session resources. Add `--shutdown` to also terminate the daemon process.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mm stop [--force]`                                                                                                                                             | Stops the daemon process (symmetric to `mm serve`). Sends a best-effort cleanup before shutdown. Use `--force` to remove stale `.mm-server` state from crashed daemons.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mm status`                                                                                                                                                     | Displays the daemon's current status: PID, port, uptime, allocated sub-ports, and whether a browser session is active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mm serve [--background]`                                                                                                                                       | Manually starts the HTTP daemon without launching a browser session. Use `--background` to detach the process. Fails if a daemon is already running for this worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Interaction

| Command                                                                                                                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mm click <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>] [--dismiss-keyboard]`                      | Clicks an element by its accessibility reference (e.g., `e3`). The ref comes from a prior `describe-screen` call. Waits for the element to be visible before clicking. The `--timeout` covers the entire operation (visibility wait + click action). Default: 15s. Use `--within` to scope the target inside a parent element (`testid:<id>`, `selector:<css>`, or a bare a11y ref). Use `--frame` (same forms) to target an element inside that iframe; refs from `describe-screen` (`f1e3`) already point into their iframe. Mobile: fails with `MM_TARGET_OBSCURED` when something covers the target; `--dismiss-keyboard` closes a covering keyboard and taps again. |
| `mm type <ref> <text> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>]`                                     | Types text into an input element identified by its accessibility reference. Clears the field first, then sets the new value (uses Playwright's `fill()`). Accepts `--timeout` for the total time budget (default: 15s). Use `--within` to scope the target inside a parent element. A read-only or disabled field fails at once with `element is not editable (readonly)` / `(disabled)`.                                                                                                                                                                                                                                                                                |
| `mm inspect <ref> [--styles <prop,prop>] [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>]`                  | Browser only. Returns the element's `attributes`, `disabled` and `readOnly` flags, computed `styles` (default `color,background-color,opacity,cursor`) and `effectiveOpacity`. Use it to compare two fields objectively instead of by eye or with `mm cdp Runtime.evaluate`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `mm hover <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>]`                                           | Browser only. Moves the pointer over the element, so its hover state (tooltip, popover, highlight) shows. Use it instead of `mm cdp Input.dispatchMouseEvent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mm unhover`                                                                                                                                         | Browser only. Moves the pointer off the page, so nothing is hovered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mm set-viewport <width> <height>`                                                                                                                   | Browser only. Resizes the active page's viewport, until `mm reset-viewport`. Use it instead of `mm cdp Emulation.setDeviceMetricsOverride`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mm reset-viewport`                                                                                                                                  | Browser only. Restores the size the page had before the first `mm set-viewport`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mm get-text <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>]`                                        | Reads the text content of an element. Returns the inner text, target descriptor, and character length. Accepts `--timeout` for the total time budget (default: 15s). Useful for asserting visible values without screenshots.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mm describe-screen [--frame <iframe>]`                                                                                                              | Captures the full screen state: extension info, visible test IDs, and a trimmed accessibility tree with deterministic refs (`e1`, `e2`, ...). Visible iframes are listed after the page with refs `f1e1`, `f2e1`, ...; `--frame` lists only that iframe. This is the primary command for understanding what's on screen before interacting.                                                                                                                                                                                                                                                                                                                              |
| `mm screenshot [--name <name>] [--selector <css>] [--frame <iframe>]`                                                                                | Takes a full-page screenshot of the current page. Saves to the artifacts directory. Use `--name` to set a descriptive filename, `--selector` to capture one element, and `--frame` to capture an iframe (with `--selector`, the element inside it).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--frame <iframe>]`                                        | Blocks until an element identified by its accessibility reference becomes visible, or the timeout expires. Default timeout is 15 seconds. Use `--within` to scope the target inside a parent element.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mm wait-for-notification [--timeout <ms>]`                                                                                                          | Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mm clipboard <read\|write> [text]`                                                                                                                  | Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mm scroll-to-element <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--direction auto\|down\|up] [--maxAttempts <n>]` | Scrolls until the target element is visible. Browser: scrolls it into view (also inside a scrollable container), with `--timeout` and `--within`. Mobile: swipes until it is inside the viewport, with `--direction` and `--maxAttempts`.                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Navigation

| Command                                                   | Description                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mm navigate <url>`                                       | Opens a new tab and navigates to the given URL. Useful for navigating to dApps or external pages.                                                |
| `mm navigate-home`                                        | Navigates the extension tab to the wallet home screen.                                                                                           |
| `mm navigate-settings`                                    | Navigates the extension tab to the settings page.                                                                                                |
| `mm reload`                                               | Reloads the active page on the same screen, so data the Extension cached in memory is fetched again (e.g. after changing a network mock).        |
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

| Command                                                                                                                                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm mock-network add '<json-rule-or-config>'`                                                                                              | Adds targeted route mocks during an active session. Pass either a single rule, an array of rules, or an object with a `routes` array. Add `"record":{"body":true}` to a rule to record the bodies of the requests it matches. A rule with `record` and no `response` forwards the real request unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mm mock-network clear`                                                                                                                    | Clears route mocks and recorded requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mm mock-network list`                                                                                                                     | Lists active route mocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mm mock-network requests [--limit <n>] [--url <glob-or-text>] [--bodies]`                                                                 | Shows recorded matched and missed requests, with URLs redacted like `mm network`. `--url` keeps only matching URLs. `--bodies` adds the recorded (redacted) request bodies and headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mm events mark`                                                                                                                           | Returns the current cursor of the session event buffer and `summary.startedAt`. Take it at the start of a flow and pass it to `mm logs` / `mm network` at the end. Browser only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mm events clear [--kind console\|network]`                                                                                                | Empties the session event buffer (one kind or all). The cursor keeps counting, so older cursors stay valid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mm logs [--cursor <n> \| --since <iso\|epoch-ms>] [--limit <n>] [--grep <regex>]`                                                         | Console errors and uncaught exceptions of every page and the Extension service worker since the cursor. Read again with the returned `cursor` while `hasMore`; `gap: true` also means the cursor is from an earlier session (the read restarts from the oldest record). `--grep` is a case-sensitive JavaScript regex of at most 256 characters; the pattern runs in the daemon, so avoid nested quantifiers such as `(a+)+`; a value that starts with `--` must be escaped (`--grep '\-\-x'`). Browser only.                                                                                                                                                                                                                                                                                                     |
| `mm logs configure --levels <error,warning,info,log,debug>`                                                                                | Changes the recorded console levels for the session (default `error`; `warn` is accepted as `warning`). Only `--levels <list>` is accepted; any other flag or a second `--levels` is a usage error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mm network [--cursor <n> \| --since <iso\|epoch-ms>] [--limit <n>] [--url <glob\|text>] [--errors] [--settled]`                           | HTTP(S) requests of every page and the Extension service worker since the cursor: status, `ms`, `failure`, `rpcMethods`. `--errors` keeps status >= 400, failures and `rpcError`. An unfiltered read returns every record in start order, pending requests included. A filtered read (`--url`, `--errors`) returns only settled requests, in `settledSeq` order, so a request that becomes a match when it ends is returned once by the next read, even when it started before the cursor; `--settled` does the same without a filter, for the end of a step. `--since` compares the request start (`t`). A request whose page or worker goes away is finalized with `failure: "target closed"`; one dropped from the pending limit as `"abandoned"`. Requests during `mm launch` are not recorded. Browser only. |
| `mm network configure --rpc-errors \| --no-rpc-errors`                                                                                     | Reads JSON-RPC response bodies (up to 64 KiB decoded, 8 at a time) and records their `error` as `rpcError`. Off by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mm cdp <method> [params-json] [--timeout <ms>] [--target page\|sw\|hermes\|android-webview] [--fresh] [--metro-port <p>] [--app-id <id>]` | Sends a raw Chrome DevTools Protocol command against the active session. Escape hatch for when structured tools are insufficient. Works on both browser and mobile — the target runtime and blocked methods differ by platform (see below). Browser targets are the active page (`page`, default) and the Extension service worker (`sw`); `--fresh` uses a one-shot session. On mobile the session keeps the `--metro-port` given to `mm launch`, so later calls use it; a per-call `--metro-port` is only an override.                                                                                                                                                                                                                                                                                          |

```bash
mm cdp Runtime.evaluate '{"expression":"document.title"}'
mm cdp Network.enable
mm cdp DOM.getDocument '{"depth":2}' --timeout 5000
mm cdp Runtime.evaluate '{"expression":"typeof globalThis.stateHooks","returnByValue":true}' --target sw
mm cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}' --fresh
```

The `params-json` argument must be a valid JSON object. The `--timeout` flag sets the per-command action timeout (default and max: 30 000 ms); the CLI waits up to 47 s for the default so the daemon can run the command and collect its observation. Browser commands share one persistent CDP session per target (page or service worker), so a domain enabled by one call stays enabled for later calls; the session is dropped and re-attached after the page or service worker restarts. An event subscription owns the domains it enables on a target. While it holds one, a `<Domain>.enable` on that target with no params (or the subscription's own params) sends nothing and returns the result of the subscription's enable (`{}` for the standard domains): the domain is already enabled. A `<Domain>.enable` with other params and a `<Domain>.disable` are refused with `MM_CDP_BLOCKED`, because they would change or stop the subscription's events (send them with `--fresh` to run them on a session of their own). `--fresh` opens a one-shot session for a single command and detaches it afterwards. The tool is categorized as `cdp`: by default it returns no observation and does not refresh refs, so pass `--observe full` (or run `mm describe-screen`) after a call that changes state.

#### Browser vs Mobile (Hermes) CDP

`cdp` dispatches through the active platform driver, so the same command works on a browser or a mobile session — but the two targets are not interchangeable:

| Aspect              | Browser (Playwright)                                                                             | Mobile (React Native Hermes)                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target runtime      | The active page or the Extension service worker (`--target sw`), each on a persistent session    | The app's Hermes JS engine, via Metro's inspector proxy                                                                                                                                             |
| Available domains   | Full Chrome surface — `Runtime`, `DOM`, `Network`, `Page`, `Accessibility`, …                    | JS-engine subset only — `Runtime`, `Debugger`, `Log`, `HeapProfiler` (no `DOM` / `Page` / `Network`)                                                                                                |
| Blocked methods     | `Browser.close`, `Target.closeTarget`, `Target.disposeBrowserContext`, `Browser.crashGpuProcess` | `Runtime.terminateExecution`, `Inspector.detached`                                                                                                                                                  |
| `metroPort`/`appId` | Ignored                                                                                          | Default to the session's (the launch `--metro-port`, else `HERMES_METRO_PORT`, else `8081`; app id: `HERMES_APP_ID`, else the platform default). A per-call flag overrides them for that call only. |
| Prerequisite        | An active browser session                                                                        | An active mobile session with a DEBUG build and Metro running                                                                                                                                       |
| Errors              | `MM_CDP_BLOCKED` / `MM_CDP_FAILED`; `MM_INVALID_INPUT` for a mobile-only target                  | `MM_CDP_BLOCKED` / `MM_CDP_FAILED` (the underlying `HERMES_*` code is preserved in the message, with the Metro port used); `MM_INVALID_INPUT` for a browser-only target                             |

On mobile, `Runtime.evaluate` nests its value at `result.result.value`. `cdp` and `hermes-targets` use the Metro port the session was launched with (`mm launch --metro-port` or the consumer's), then the `HERMES_METRO_PORT` env var, then `8081`; `--metro-port` / `--app-id` on a call only override it for that call, and such a call opens a one-shot connection. The app id defaults to `HERMES_APP_ID`, else the platform default. The session keeps one Hermes connection for its Metro port and app id and reuses it across calls.

```bash
# Mobile (Hermes) — the session keeps the launch Metro port
mm launch --platform ios --metro-port 8085
mm cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}'

# Override the port for this call only
mm cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}' --app-id io.metamask --metro-port 8081
```

#### Hermes targets (mobile only)

| Command                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm hermes-targets [--all] [--metro-port <p>] [--app-id <id>]` | Lists and diagnoses the debuggable Hermes targets Metro exposes, reporting which target would be chosen or why selection is ambiguous. Pass `--all` to bypass the appId filter and discover the real appId. The report also says which Metro port the session keeps (`sessionMetroPort`), which device is pinned (`pinnedDeviceId`), whether the persistent connection is open (`connected`), and the session device (`deviceId`). Mobile only — there is no browser equivalent. |

```bash
mm hermes-targets
mm hermes-targets --all
```

#### Mobile launch options

`mm launch --platform ios|android` accepts additional options that the core
validates and forwards verbatim to the consumer's `ISessionManager.launch()`.
The core owns no install or device lifecycle; each consumer decides how (or
whether) to honor them. After a successful launch, core also keeps `metroPort`
and `deviceId` as the session's Hermes defaults, so later `mm cdp` and
`mm hermes-targets` calls use them without a per-call flag.

| Option                      | Field                  | Meaning                                                                                                                               |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--device-id <id>`          | `deviceId`             | Target a specific device. Auto-detected when exactly one is connected.                                                                |
| `--app-bundle <path>`       | `appBundlePath`        | App artifact to install before launching (iOS `.app`, Android `.apk`).                                                                |
| `--metro-port <port>`       | `metroPort`            | Metro bundler / inspector proxy port for watch-mode attach (development builds). Kept for later `mm cdp` / `mm hermes-targets` calls. |
| `--reinstall`               | `reinstall`            | **Destructive.** Uninstall and reinstall the app, discarding its container.                                                           |
| `--reset-app-data`          | `resetAppData`         | **Destructive.** Clear app data, discarding existing wallet state.                                                                    |
| `--allow-fox-code-mismatch` | `allowFoxCodeMismatch` | **Dangerous.** Bypass the consumer's app-identity compatibility guard.                                                                |

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

When a consumer's `launch()` throws an error carrying an `MM_*` `code` (a known
[`ErrorCode`](#error-classification) or a consumer-specific one), the `launch`
tool preserves it instead of collapsing it into `MM_LAUNCH_FAILED`, so precise
device/prerequisite failures reach the agent intact. The CLI maps a code it does
not know to exit 1.

#### Mobile device actions (iOS/Android only)

These commands require a mobile session (`mm launch --platform ios|android`). Run on a
browser session, they return `MM_TOOL_NOT_SUPPORTED_ON_PLATFORM`.

| Command                                                                                              | Description                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `mm device-swipe --direction <up\|down\|left\|right> [--startX <n>] [--startY <n>] [--distance <n>]` | Swipes the screen in a direction.                                              |
| `mm long-press <ref> [--duration <ms>] [--selector <css>] [--testid <id>]`                           | Long-presses the target element.                                               |
| `mm tap-coordinates <x> <y>`                                                                         | Taps raw screen coordinates.                                                   |
| `mm dismiss-keyboard`                                                                                | Dismisses the on-screen keyboard.                                              |
| `mm dismiss-alert [--accept]`                                                                        | Dismisses a native alert; `--accept` accepts it.                               |
| `mm get-alert-text`                                                                                  | Prints the text of a visible native alert.                                     |
| `mm open-app <bundleId>`                                                                             | Launches or foregrounds an app.                                                |
| `mm close-app <bundleId>`                                                                            | Terminates an app.                                                             |
| `mm press-button <home\|back\|enter\|lock>`                                                          | Presses a hardware/system button.                                              |
| `mm device-context list` / `mm device-context switch <name>`                                         | Lists or switches native/webview contexts.                                     |
| `mm device-clipboard read` / `mm device-clipboard write <text>`                                      | Reads or writes the device clipboard.                                          |
| `mm screen-recording start [--output <path>]` / `mm screen-recording stop`                           | Starts or stops a screen recording; `--output` is sandboxed to `artifactsDir`. |
| `mm device-logs [--duration <seconds>] [--filter <text>]`                                            | Fetches device logs.                                                           |
| `mm generate-locators`                                                                               | Lists ranked selector suggestions for on-screen elements.                      |

```bash
mm scroll-to-element e12          # auto: scrolls toward the element
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
| `MM_TARGET_OBSCURED`                | Mobile: another element (keyboard, sheet, overlay) covers the target; nothing was tapped                |
| `MM_TARGET_NOT_VISIBLE`             | Mobile: the target is outside the viewport (tap or `scroll_to_element`)                                 |
| `MM_CLICK_TIMEOUT`                  | Click action timed out (element found, click hung)                                                      |
| `MM_TYPE_FAILED`                    | Type operation failed                                                                                   |
| `MM_TYPE_TIMEOUT`                   | Fill action timed out                                                                                   |
| `MM_GETTEXT_FAILED`                 | getText operation failed                                                                                |
| `MM_GETTEXT_TIMEOUT`                | textContent action timed out                                                                            |
| `MM_ELEMENT_NOT_EDITABLE`           | Type target is read-only or disabled (browser)                                                          |
| `MM_INSPECT_FAILED`                 | inspect could not read the element                                                                      |
| `MM_HOVER_FAILED`                   | hover or unhover failed                                                                                 |
| `MM_VIEWPORT_FAILED`                | set_viewport or reset_viewport could not resize the page                                                |
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
| `MM_QUEUE_TIMEOUT`                  | The daemon stopped the request before it finished; the action may have run                              |
| `MM_CDP_BLOCKED`                    | CDP method is blocked (destructive to session); on mobile the Hermes blocklist maps here too            |
| `MM_CDP_FAILED`                     | CDP command execution failed or timed out (on mobile, the underlying `HERMES_*` code is in the message) |
| `MM_HERMES_FAILED`                  | `hermes_targets` discovery failed (underlying `HERMES_*` code is in the message)                        |
| `MM_HERMES_NOT_AVAILABLE`           | `hermes_targets` used outside a mobile (iOS/Android) session                                            |
| `MM_DEVICE_ACTION_FAILED`           | A mobile device action (swipe, tap, app control, clipboard, etc.) failed                                |
| `MM_DEVICE_NOT_AVAILABLE`           | A mobile-only tool was invoked without a mobile driver capability                                       |
| `MM_TOOL_NOT_SUPPORTED_ON_PLATFORM` | Tool gated off the active platform (browser-only tool on mobile, or mobile-only tool on browser)        |
| **CLI (set by `mm`, not a tool)**   |                                                                                                         |
| `MM_DAEMON_NOT_RUNNING`             | No daemon, or the daemon refused the connection                                                         |
| `MM_DAEMON_START_FAILED`            | The daemon did not become ready in time                                                                 |
| `MM_DAEMON_ALREADY_RUNNING`         | `mm serve` while a daemon is running                                                                    |
| `MM_DAEMON_CONNECTION_LOST`         | The connection failed after the request was sent; the action may have run                               |
| `MM_REQUEST_TIMEOUT`                | The CLI stopped waiting for the daemon; the action state is unknown                                     |

The daemon HTTP server also sets `VALIDATION_ERROR` (schema), `TOOL_NOT_FOUND`,
`SERVER_NOT_STARTED`, `TOOL_EXECUTION_FAILED` and `INTERNAL_ERROR`
(`DaemonErrorCodes`).

A timed-out observation is not a tool error: the action response stays `ok` and
carries `"observations": {"timedOut": true}`, so the caller knows the screen was
not read (the diff baseline is not replaced). `MM_QUEUE_TIMEOUT` means the
daemon's request queue stopped the call before it finished; it is exit 5, not
retryable, and the action may have run, so check the state before retrying.

### CLI failure output and exit codes

A failed `mm` command prints one JSON line on **stdout** and exits non-zero.
stderr is for human logs only (on a terminal it also gets `Error: <message>`).

```json
{
  "ok": false,
  "error": {
    "code": "MM_TARGET_NOT_FOUND",
    "message": "...",
    "hint": "Run `mm describe-screen` to get fresh refs.",
    "retryable": false
  },
  "meta": { "totalMs": 512 }
}
```

`hint` is optional. `retryable` is true only when running the same command
again, unchanged, is safe (the call only reads, or nothing ran); it is false for
click, type and request timeouts because the action state is unknown. `meta` is
present when the daemon answered. `exitCodeForError()` in
`src/tools/types/errors.ts` is the one map from error code to exit code:

| Exit | Meaning                                                          | Codes (examples)                                                                                                       |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0    | ok                                                               |                                                                                                                        |
| 1    | anything else (internal error, tool failure, unknown code)       | `MM_INTERNAL_ERROR`, `TOOL_EXECUTION_FAILED`, `MM_LAUNCH_FAILED`, `MM_SEED_FAILED`                                     |
| 2    | usage or validation; nothing ran                                 | `MM_INVALID_INPUT`, `MM_INVALID_CONFIG`, `VALIDATION_ERROR`, `TOOL_NOT_FOUND`, `MM_CDP_BLOCKED`                        |
| 3    | no session, daemon not running, daemon connection lost           | `MM_NO_ACTIVE_SESSION`, `MM_PAGE_CLOSED`, `MM_DAEMON_NOT_RUNNING`, `MM_DAEMON_CONNECTION_LOST`                         |
| 4    | target not found or not actionable                               | `MM_TARGET_NOT_FOUND`, `MM_TARGET_NOT_VISIBLE`, `MM_TARGET_OBSCURED`, `MM_CLICK_FAILED`, `MM_TAB_NOT_FOUND`            |
| 5    | timeout (click, type and request timeouts: action state unknown) | `MM_WAIT_TIMEOUT`, `MM_CLICK_TIMEOUT`, `MM_TYPE_TIMEOUT`, `MM_REQUEST_TIMEOUT`, `MM_BATCH_TIMEOUT`, `MM_QUEUE_TIMEOUT` |
| 6    | platform, device, Metro or Hermes not available                  | `MM_DEVICE_ACTION_FAILED`, `MM_DEVICE_NOT_AVAILABLE`, `MM_HERMES_FAILED`, `MM_TOOL_NOT_SUPPORTED_ON_PLATFORM`          |
| 7    | daemon version mismatch (reserved)                               |                                                                                                                        |

## Development

```bash
yarn build        # Build the package
yarn test         # Run tests and type checks
yarn lint         # Lint everything
yarn lint:fix     # Auto-fix lint issues
```

## License

(MIT OR Apache-2.0)
