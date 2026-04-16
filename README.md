# @metamask/client-mcp-core

HTTP daemon and CLI architecture for agent-driven browser extension testing with Playwright.

## Overview

This package provides the core infrastructure for enabling LLM agents to interact with browser extensions through Playwright. It ships a persistent HTTP daemon that manages browser lifecycle and a unified `mm` CLI that agents (and developers) use to drive sessions.

The design is **consumer-agnostic**: the core handles protocol, tooling, and knowledge — consumers provide extension-specific logic by implementing the `ISessionManager` interface and injecting capabilities.

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
  │  ┌──────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────┐ │
  │  │  Routes   │  │ RequestQueue │  │   Tool     │  │ Knowledge  │ │
  │  │ /health   │  │ (async mutex)│  │  Registry  │  │   Store    │ │
  │  │ /status   │  │              │  │  25+ tools │  │            │ │
  │  │ /launch   │  └──────────────┘  └─────┬──────┘  └────────────┘ │
  │  │ /cleanup  │                          │                         │
  │  │ /tool/:n  │                          ▼                         │
  │  └──────────┘               ┌──────────────────┐                 │
  │                             │   ToolContext     │                 │
  │                             │  sessionManager   │                 │
  │                             │  page / refMap    │                 │
  │                             │  workflowContext  │                 │
  │                             │  knowledgeStore   │                 │
  │                             └────────┬─────────┘                 │
  └──────────────────────────────────────┼───────────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   │          ISessionManager                   │
                   │       (consumer implementation)            │
                   │                                            │
                   │  Session lifecycle   Page management       │
                   │  Extension state     A11y reference map    │
                   │  Navigation          Screenshots           │
                   │  Capabilities (opt)  Environment config    │
                   └─────────────────────┬─────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   │          WorkflowContext                   │
                   │                                            │
                   │  build?            fixture?                │
                   │  chain?            contractSeeding?        │
                   │  stateSnapshot?    mockServer?             │
                   │  config: EnvironmentConfig                 │
                   └─────────────────────┬─────────────────────┘
                                         │
                                         ▼
                   ┌───────────────────────────────────────────┐
                   │        Playwright  →  Chrome Browser      │
                   │            Browser Extension               │
                   └───────────────────────────────────────────┘
```

## Requirements

- **Node.js** `^20 || ^22 || >=24`
- **TypeScript** `>=5.0` (for consumer type definitions)
- **Playwright** `^1.49.0` (peer dependency)

## Installation

As a project dependency (the CLI is available via `npx mm` or `yarn mm`):

```bash
yarn add @metamask/client-mcp-core
```

As a global CLI (puts `mm` directly on your PATH — recommended for LLM agents):

```bash
npm install -g @metamask/client-mcp-core
```

The global CLI can target any project via `--project` or `MM_PROJECT` (see [Project Targeting](#project-targeting)).

## Getting Started

Consuming this package requires two things: a **daemon entry point** and a **`package.json` configuration**.

### 1. Create a daemon entry point

```typescript
// daemon.ts
import { createServer } from '@metamask/client-mcp-core';
import { MySessionManager } from './my-session-manager';
import { createMyContext } from './my-context';

const server = createServer({
  sessionManager: new MySessionManager(),
  contextFactory: (options) => createMyContext({ ports: options.ports }),
});

server.start().then((state) => {
  console.error(`Daemon started on port ${state.port}`);
});
```

### 2. Configure `package.json`

```json
{
  "mm": {
    "daemon": "path/to/daemon.ts",
    "runtime": "tsx"
  },
  "scripts": {
    "mm:serve": "tsx path/to/daemon.ts"
  }
}
```

The `mm.daemon` field tells the CLI where the daemon entry point lives. The `mm.runtime` field specifies the TypeScript runner (defaults to `tsx`).

### 3. Use the CLI

```bash
mm launch              # auto-starts daemon, opens browser session
mm describe-screen     # get element references
mm click e3            # interact using a11y refs
mm cleanup --shutdown  # stop browser and daemon
```

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
- **Port Allocation**: The daemon automatically allocates ports for the HTTP server and test infrastructure (Anvil, fixture server, mock server) to avoid conflicts.
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
};
```

Capabilities are created by the consumer's `contextFactory` function, which receives allocated port numbers:

```typescript
function createMyContext(options: {
  ports: { anvil: number; fixture: number; mock: number };
}): WorkflowContext {
  return {
    build: new MyBuildCapability(),
    fixture: new MyFixtureCapability(options.ports.fixture),
    chain: new MyChainCapability(options.ports.anvil),
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
  page: Page;
  refMap: Map<string, string>;
  workflowContext: WorkflowContext;
  knowledgeStore: KnowledgeStore;
};
```

The daemon routes `POST /tool/:name` requests through the registry, applies Zod validation on inputs, executes the tool through the request queue, and captures observations (extension state, test IDs, a11y snapshot) after each execution.

**Registered tools:**

| Tool                     | Description                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifecycle**            |                                                                                                                                                                                                                                                                             |
| `build`                  | Triggers an extension build using the configured `BuildCapability`. Accepts build type and force options.                                                                                                                                                                   |
| `launch`                 | Launches a new browser session with the configured extension. Supports state modes (`default`, `onboarding`, `custom`), fixture presets, goal/tag metadata, and optional contract seeding on start.                                                                         |
| `cleanup`                | Tears down the active browser session and cleans up all resources (browser, services, fixtures).                                                                                                                                                                            |
| **Interaction**          |                                                                                                                                                                                                                                                                             |
| `click`                  | Clicks an element identified by a11y ref, test ID, or CSS selector. Waits for the element to be visible before clicking.                                                                                                                                                    |
| `type`                   | Types text into an input element identified by a11y ref, test ID, or CSS selector. Uses Playwright's `fill()` for reliable input.                                                                                                                                           |
| `wait_for`               | Waits for an element to become visible on the page within a configurable timeout.                                                                                                                                                                                           |
| `clipboard`              | Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.                                                                                                                                            |
| **Navigation**           |                                                                                                                                                                                                                                                                             |
| `navigate`               | Navigates the browser to a named screen (`home`, `settings`, `notification`) or an arbitrary URL.                                                                                                                                                                           |
| `switch_to_tab`          | Switches the active page to a tab matching a given role (e.g., `extension`, `dapp`) or URL prefix.                                                                                                                                                                          |
| `close_tab`              | Closes a browser tab matching a given role or URL. Falls back to the extension tab if the active tab is closed.                                                                                                                                                             |
| `wait_for_notification`  | Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.                                                                                                                                                                   |
| **Discovery**            |                                                                                                                                                                                                                                                                             |
| `describe_screen`        | Captures a comprehensive screen snapshot: extension state, visible test IDs, trimmed a11y tree with refs, optional screenshot, and prior knowledge from historical sessions.                                                                                                |
| `accessibility_snapshot` | Captures a trimmed accessibility tree of the current page with deterministic refs (`e1`, `e2`, ...). Supports scoping to a root CSS selector.                                                                                                                               |
| `list_testids`           | Collects all visible `data-testid` attributes from the current page with text previews and visibility status.                                                                                                                                                               |
| **State**                |                                                                                                                                                                                                                                                                             |
| `get_state`              | Retrieves the current extension state (URL, screen, network, balance, account) and tracked tab information.                                                                                                                                                                 |
| `get_context`            | Returns the current environment context (`e2e` or `prod`), session status, available capabilities, and whether context switching is allowed.                                                                                                                                |
| `set_context`            | Switches the session environment between `e2e` and `prod` modes. Blocked while a session is active.                                                                                                                                                                         |
| **Screenshots**          |                                                                                                                                                                                                                                                                             |
| `screenshot`             | Captures a screenshot of the current page. Supports naming, full-page capture, scoping to a CSS selector, and optional base64 output.                                                                                                                                       |
| **Knowledge**            |                                                                                                                                                                                                                                                                             |
| `knowledge_last`         | Retrieves the N most recent step records from the knowledge store, with optional scope and filter parameters.                                                                                                                                                               |
| `knowledge_search`       | Searches step records by query string with token-based matching and synonym expansion. Scores results by relevance to screen, URL, test IDs, and a11y nodes.                                                                                                                |
| `knowledge_summarize`    | Generates a recipe-style summary of a session's tool invocations, showing the step sequence with targets and outcomes.                                                                                                                                                      |
| `knowledge_sessions`     | Lists available knowledge sessions with metadata (goal, flow tags, timestamps), with optional filtering.                                                                                                                                                                    |
| **Contracts**            |                                                                                                                                                                                                                                                                             |
| `seed_contract`          | Deploys a single smart contract to the local Anvil chain by name. Requires `ContractSeedingCapability`.                                                                                                                                                                     |
| `seed_contracts`         | Deploys multiple smart contracts in sequence. Returns both successful deployments and individual failures.                                                                                                                                                                  |
| `get_contract_address`   | Looks up the deployed address of a contract by name from the session's deployment registry.                                                                                                                                                                                 |
| `list_contracts`         | Lists all contracts deployed in the current session with addresses and deployment timestamps.                                                                                                                                                                               |
| **Batching**             |                                                                                                                                                                                                                                                                             |
| `run_steps`              | Executes a batch of tool invocations sequentially. Supports `stopOnError` to halt on first failure and `includeObservations` (`'all'`, `'none'`, `'failures'`) to control whether post-execution observations appear in the response. Returns per-step results with timing. |

### Accessibility References

The core uses Playwright's `ariaSnapshot()` to build a deterministic reference map of interactive elements. Each element gets a short ref like `e1`, `e2`, etc., mapped to an ARIA selector.

Agents call `describe_screen` to get the current reference map, then use refs for interaction:

```
mm describe-screen    → { ..., a11y: [{ ref: "e1", role: "button", name: "Submit" }, ...] }
mm click e1           → clicks the "Submit" button
mm type e3 "hello"    → types into the element mapped to e3
```

This accessibility-first approach provides reliable element targeting that survives minor UI changes.

### Knowledge Store

The `KnowledgeStore` provides cross-session learning by recording every tool execution as a structured step record:

- **Step Recording**: Each tool invocation captures the tool name, input, outcome, observation (extension state, visible test IDs, a11y nodes), and timing.
- **Session Metadata**: Sessions are tagged with goals, flow tags, and free-form tags for filtering.
- **Prior Knowledge**: Before tool execution, the store can generate context from historical sessions — similar steps, suggested actions, and patterns to avoid — based on the current screen state.
- **Search**: Token-based search with synonym expansion across sessions, scored by relevance to screen, URL, test IDs, and a11y nodes.
- **Sensitive Data Handling**: Input text for password fields and other sensitive inputs is automatically redacted.

Knowledge artifacts are stored on disk at `test-artifacts/llm-knowledge/` organized by session ID.

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
  /** Factory function to create workflow context (required) */
  contextFactory: (options: ContextFactoryOptions) => WorkflowContext;
  /** Idle timeout in milliseconds (optional, defaults to 30000) */
  idleTimeoutMs?: number;
  /** Path to log file (optional) */
  logFilePath?: string;
};

type ContextFactoryOptions = {
  ports: {
    anvil: number;
    fixture: number;
    mock: number;
  };
};
```

The returned `ServerInstance` exposes:

- `start(): Promise<DaemonState>` — Allocates ports, starts HTTP server, writes `.mm-server` state, sets up idle timeout and signal handlers.
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
{ ok: true, result: T, observations?: { state, testIds, a11y } }

// Error
{ ok: false, error: { code: string, message: string } }
```

The `observations` field is included for **mutating** tools (click, type, navigate, launch, cleanup, build, etc.) and for `run_steps` when its `includeObservations` parameter is `'all'` (default) or `'failures'`. **Read-only** and **discovery** tools omit observations from the response.

## CLI Reference

The `mm` CLI provides a unified interface for agents and developers. All commands communicate with the daemon over HTTP — the daemon is auto-started on `mm launch` if not already running.

### Global Options

| Option             | Description                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `--project <path>` | Target a specific project directory (absolute or relative). Overrides `MM_PROJECT` and git-based discovery. |

| Environment Variable | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `MM_PROJECT`         | Default project directory when `--project` is not provided. Falls back to the current git worktree root. |

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

| Command                                                                               | Description                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm launch [--state default\|onboarding\|custom] [--extension-path <path>] [--force]` | Auto-starts the daemon if needed, then launches a headed Chrome session with the configured extension. Use `--state` to control wallet initialization (pre-configured, onboarding flow, or custom fixture). Use `--extension-path` to override the extension directory. Use `--force` to replace an existing session. |
| `mm cleanup [--shutdown]`                                                             | Stops the browser, tears down test services (fixture server, Anvil, mock server), and releases session resources. Add `--shutdown` to also terminate the daemon process.                                                                                                                                              |
| `mm status`                                                                           | Displays the daemon's current status: PID, port, uptime, allocated sub-ports, and whether a browser session is active.                                                                                                                                                                                                |
| `mm serve [--background]`                                                             | Manually starts the HTTP daemon without launching a browser session. Use `--background` to detach the process. Fails if a daemon is already running for this worktree.                                                                                                                                                |

### Interaction

| Command                              | Description                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm click <ref>`                     | Clicks an element by its accessibility reference (e.g., `e3`). The ref comes from a prior `describe-screen` call. Waits for the element to be visible before clicking.                                                                                                     |
| `mm type <ref> <text>`               | Types text into an input element identified by its accessibility reference. Replaces any existing content in the field.                                                                                                                                                    |
| `mm describe-screen`                 | Captures the full screen state: extension info, visible test IDs, a trimmed accessibility tree with deterministic refs (`e1`, `e2`, ...), and prior knowledge from historical sessions. This is the primary command for understanding what's on screen before interacting. |
| `mm screenshot [--name <name>]`      | Takes a full-page screenshot of the current page. Saves to the artifacts directory. Use `--name` to set a descriptive filename.                                                                                                                                            |
| `mm wait-for <ref> [--timeout <ms>]` | Blocks until an element identified by its accessibility reference becomes visible, or the timeout expires. Default timeout is 5 seconds.                                                                                                                                   |

### Navigation

| Command                | Description                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `mm navigate <url>`    | Opens a new tab and navigates to the given URL. Useful for navigating to dApps or external pages. |
| `mm navigate-home`     | Navigates the extension tab to the wallet home screen.                                            |
| `mm navigate-settings` | Navigates the extension tab to the settings page.                                                 |

### State & Knowledge

| Command                       | Description                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mm get-state`                | Returns the current extension state: loaded status, current URL, screen name, network, chain ID, account address, and balance. Also lists all tracked browser tabs. |
| `mm knowledge-search <query>` | Searches the knowledge store for past tool invocations matching the query. Results are scored by relevance to screen, URL, test IDs, and a11y nodes.                |
| `mm knowledge-last`           | Retrieves the most recent step records from the current session's knowledge store.                                                                                  |
| `mm knowledge-sessions`       | Lists recent knowledge sessions with metadata (goal, flow tags, timestamps).                                                                                        |
| `mm run-steps <json>`         | Executes a batch of tool invocations sequentially from a JSON definition. Each step specifies a tool name and arguments.                                            |

For the full agent-facing reference and workflow guidelines, see [SKILL.md](./SKILL.md).

## Error Classification

Tool errors are classified into specific error codes for structured handling:

| Code                        | Meaning                                       |
| --------------------------- | --------------------------------------------- |
| `MM_TARGET_NOT_FOUND`       | Element not found by ref, testId, or selector |
| `MM_WAIT_TIMEOUT`           | Timeout waiting for element or condition      |
| `MM_CLICK_FAILED`           | Click operation failed                        |
| `MM_TYPE_FAILED`            | Type operation failed                         |
| `MM_NAVIGATION_FAILED`      | Navigation error or network failure           |
| `MM_PAGE_CLOSED`            | Browser page was closed unexpectedly          |
| `MM_NOTIFICATION_TIMEOUT`   | Notification popup did not appear             |
| `MM_TAB_NOT_FOUND`          | Tab not found by role or URL                  |
| `MM_DISCOVERY_FAILED`       | Discovery tool failure                        |
| `MM_SCREENSHOT_FAILED`      | Screenshot capture failure                    |
| `MM_CONTRACT_NOT_FOUND`     | Unknown contract name                         |
| `MM_SEED_FAILED`            | Contract deployment failure                   |
| `MM_CONTEXT_SWITCH_BLOCKED` | Context switch while session is active        |

## Development

```bash
yarn build        # Build the package
yarn test         # Run tests and type checks
yarn lint         # Lint everything
yarn lint:fix     # Auto-fix lint issues
```

## License

(MIT OR Apache-2.0)
