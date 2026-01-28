# @metamask/metamask-mcp-core

MCP (Model Context Protocol) server for MetaMask Extension visual testing with LLM agents.

## Overview

This package provides the core MCP server infrastructure for enabling LLM agents to interact with the MetaMask browser extension through Playwright.

## Installation

```bash
yarn add @metamask/metamask-mcp-core
```

## Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           LLM Agent                                     │
│                    (Claude, GPT, etc.)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ MCP Protocol (stdio)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    @metamask/metamask-mcp-core                     │
│                                                                         │
│  Core MCP Server + Generic Tools                                        │
│  - Session management                                                   │
│  - Element interaction (click, type, wait)                              │
│  - Discovery (testIds, accessibility tree)                              │
│  - Screenshots                                                          │
│  - Knowledge store (cross-session learning)                             │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ Capability Injection
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   MetaMask Extension Provider                           │
│                                                                         │
│  - Build capability (yarn build:test)                                   │
│  - Fixture/state management                                             │
│  - Anvil blockchain integration                                         │
│  - Contract seeding                                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ Playwright
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Headed Chrome Browser                                │
│                    + MetaMask Extension                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Detailed Architecture

The package follows a **capability-based dependency injection** pattern that separates concerns between:

1. **Core MCP Server** - Protocol handling, tool routing, and generic browser interactions
2. **Session Manager Interface** - Abstract contract for extension-specific session management
3. **Capabilities** - Optional features injected by consumer implementations

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         createMcpServer()                               │
│                                                                         │
│  ┌─────────────────────┐    ┌─────────────────────────────────────┐    │
│  │   Tool Definitions  │───▶│         Tool Handlers               │    │
│  │   (mm_click, etc.)  │    │   (registry.ts + individual tools)  │    │
│  └─────────────────────┘    └──────────────┬──────────────────────┘    │
│                                            │                            │
│                                            ▼                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    ISessionManager Interface                     │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐  │   │
│  │  │ Page Mgmt   │ │ Navigation  │ │ Screenshots │ │ A11y Refs │  │   │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │              Optional Capabilities                        │   │   │
│  │  │  • BuildCapability      • FixtureCapability              │   │   │
│  │  │  • ChainCapability      • ContractSeedingCapability      │   │   │
│  │  │  • StateSnapshotCapability                               │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ setSessionManager()
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Consumer Implementation (e.g., MetaMask)                   │
│                                                                         │
│  class MetaMaskSessionManager implements ISessionManager {              │
│    // Browser context, page tracking, extension-specific logic          │
│    // Capability implementations for build, fixtures, chain, etc.       │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Description |
|-----------|-------------|
| `createMcpServer()` | Factory function that creates the MCP server instance |
| `ISessionManager` | Interface that consumers must implement for session management |
| `setSessionManager()` | Injects the consumer's session manager into the core |
| `WorkflowContext` | Container for browser capability and optional capabilities |
| `EnvironmentConfig` | Configuration discriminated by `'e2e'` or `'prod'` mode |

### Capability System

The package defines several capabilities that consumers can provide.

#### BuildCapability (Optional)

Enables the `mm_build` tool. Implement this to allow LLM agents to build the extension from source.

```typescript
type BuildCapability = {
  // Build the extension (e.g., yarn build:test)
  build(options?: BuildOptions): Promise<BuildResult>;
  
  // Get path to built extension directory
  getExtensionPath(): string;
  
  // Check if extension is already built
  isBuilt(): Promise<boolean>;
};

type BuildOptions = {
  buildType?: string;  // e.g., "build:test"
  force?: boolean;     // Force rebuild even if exists
};

type BuildResult = {
  success: boolean;
  extensionPath: string;
  durationMs: number;
  error?: string;
};
```

---

#### FixtureCapability (Optional)

Enables wallet state management through fixtures. Essential for E2E testing where you need reproducible wallet states.

```typescript
type FixtureCapability = {
  // Start fixture server with given wallet state
  start(state: WalletState): Promise<void>;
  
  // Stop fixture server
  stop(): Promise<void>;
  
  // Get default pre-onboarded wallet state (25 ETH, unlocked)
  getDefaultState(): WalletState;
  
  // Get fresh onboarding state (no wallet configured)
  getOnboardingState(): WalletState;
  
  // Resolve a named preset to fixture data
  resolvePreset(presetName: string): WalletState;
};

type WalletState = {
  data: Record<string, unknown>;  // Extension storage state
  meta?: { version: number };
};
```

---

#### ChainCapability (Optional)

Manages local blockchain (Anvil) for E2E testing. Required for contract interactions.

```typescript
type ChainCapability = {
  // Start the local Anvil node
  start(): Promise<void>;
  
  // Stop the Anvil node
  stop(): Promise<void>;
  
  // Check if Anvil is running
  isRunning(): boolean;
};
```

---

#### ContractSeedingCapability (Optional)

Enables smart contract deployment tools (`mm_seed_contract`, `mm_seed_contracts`, etc.).

```typescript
type ContractSeedingCapability = {
  // Deploy a single contract
  deployContract(name: string, options?: DeployOptions): Promise<ContractDeployment>;
  
  // Deploy multiple contracts in sequence
  deployContracts(names: string[], options?: DeployOptions): Promise<{
    deployed: ContractDeployment[];
    failed: { name: string; error: string }[];
  }>;
  
  // Get deployed contract address by name
  getContractAddress(name: string): string | null;
  
  // List all deployed contracts in this session
  listDeployedContracts(): ContractInfo[];
  
  // Get available contract names
  getAvailableContracts(): string[];
  
  // Clear the deployment registry
  clearRegistry(): void;
};

type DeployOptions = {
  hardfork?: string;  // EVM hardfork (default: "prague")
  deployerOptions?: {
    fromAddress?: string;     // Impersonate address
    fromPrivateKey?: string;  // Deploy from specific key
  };
};
```
---

#### StateSnapshotCapability (Optional)

```typescript
type StateSnapshotCapability = {
  // Get detailed state snapshot
  getState(page: Page, options: StateOptions): Promise<StateSnapshot>;
  
  // Detect current screen from page content
  detectCurrentScreen(page: Page): Promise<string>;
};

type StateOptions = {
  extensionId?: string;
  chainId?: number;
};
```

## Client Integration

### How to Consume the Package

Consumers must:

1. **Implement `ISessionManager`** - The core interface for session management
2. **Inject the session manager** - Call `setSessionManager()` before starting the server
3. **Start the MCP server** - Call `server.start()`

### McpServerConfig

The `createMcpServer()` function accepts a configuration object:

```typescript
export type McpServerConfig = {
  name: string;
  version: string;
  onCleanup?: () => Promise<void>;
  logger?: (message: string) => void;
};
```

### Minimal Integration Example

```typescript
import {
  createMcpServer,
  setSessionManager,
  ISessionManager,
  type McpServerConfig,
} from '@metamask/metamask-mcp-core';

// 1. Implement the ISessionManager interface
class MyExtensionSessionManager implements ISessionManager {
  // ... implement all required methods
  // See ISessionManager interface for full contract
}

// 2. Create and inject your session manager
const sessionManager = new MyExtensionSessionManager();
setSessionManager(sessionManager);

// 3. Create and start the MCP server
const config: McpServerConfig = {
  name: 'my-extension-mcp',
  version: '1.0.0',
  onCleanup: async () => {
    // Optional cleanup logic
  },
};

const server = createMcpServer(config);
await server.start();
```

### Full Integration Example

```typescript
import {
  createMcpServer,
  setSessionManager,
  ISessionManager,
  SessionLaunchInput,
  SessionLaunchResult,
  TrackedPage,
  type ExtensionState,
  type BuildCapability,
  type FixtureCapability,
  type ChainCapability,
  type ContractSeedingCapability,
  type EnvironmentMode,
} from '@metamask/metamask-mcp-core';
import type { Page, BrowserContext } from '@playwright/test';

class MetaMaskSessionManager implements ISessionManager {
  private context?: BrowserContext;
  private activePage?: Page;
  private extensionId?: string;
  private sessionId?: string;
  private refMap = new Map<string, string>();
  
  // Capabilities (inject via constructor or lazy-load)
  private buildCapability?: BuildCapability;
  private fixtureCapability?: FixtureCapability;
  private chainCapability?: ChainCapability;
  private contractSeedingCapability?: ContractSeedingCapability;

  // Session Lifecycle
  hasActiveSession(): boolean {
    return this.context !== undefined;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async launch(input: SessionLaunchInput): Promise<SessionLaunchResult> {
    // 1. Start local chain if needed
    if (this.chainCapability) {
      await this.chainCapability.start();
    }
    
    // 2. Start fixture server if needed
    if (this.fixtureCapability && input.stateMode !== 'onboarding') {
      const fixture = input.fixture ?? this.fixtureCapability.getDefaultState();
      await this.fixtureCapability.start(fixture);
    }
    
    // 3. Launch browser with extension
    // ... Playwright browser launch logic
    
    // 4. Return session info
    return {
      sessionId: this.sessionId!,
      extensionId: this.extensionId!,
      state: await this.getExtensionState(),
    };
  }

  async cleanup(): Promise<boolean> {
    if (!this.hasActiveSession()) return false;
    
    // Close browser, stop services
    await this.context?.close();
    await this.chainCapability?.stop();
    await this.fixtureCapability?.stop();
    
    this.context = undefined;
    this.activePage = undefined;
    return true;
  }

  // Page Management
  getPage(): Page {
    if (!this.activePage) throw new Error('No active session');
    return this.activePage;
  }

  setActivePage(page: Page): void {
    this.activePage = page;
  }

  getTrackedPages(): TrackedPage[] {
    // Return all tracked pages with roles
    return [];
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('No active session');
    return this.context;
  }

  // Extension State
  async getExtensionState(): Promise<ExtensionState> {
    // Query extension for current state
    return {
      isLoaded: true,
      currentUrl: this.activePage?.url() ?? '',
      extensionId: this.extensionId ?? '',
      isUnlocked: false,
      currentScreen: 'unknown',
      accountAddress: null,
      networkName: null,
      chainId: null,
      balance: null,
    };
  }

  // A11y Reference Map
  setRefMap(map: Map<string, string>): void {
    this.refMap = map;
  }

  getRefMap(): Map<string, string> {
    return this.refMap;
  }

  clearRefMap(): void {
    this.refMap.clear();
  }

  resolveA11yRef(ref: string): string | undefined {
    return this.refMap.get(ref);
  }

  // Screenshots
  async screenshot(options: { name: string; fullPage?: boolean }) {
    // ... screenshot logic
    return { path: '', base64: '', width: 0, height: 0 };
  }

  // Capabilities
  getBuildCapability() { return this.buildCapability; }
  getFixtureCapability() { return this.fixtureCapability; }
  getChainCapability() { return this.chainCapability; }
  getContractSeedingCapability() { return this.contractSeedingCapability; }
  getStateSnapshotCapability() { return undefined; }

  // Environment
  getEnvironmentMode(): EnvironmentMode {
    return 'e2e';
  }

  // Required by interface but implementation-specific
  classifyPageRole(page: Page): 'extension' | 'notification' | 'dapp' | 'other' {
    return 'extension';
  }
  getSessionState() { return undefined; }
  getSessionMetadata() { return undefined; }
}

// Bootstrap the server
async function main() {
  const sessionManager = new MetaMaskSessionManager();
  setSessionManager(sessionManager);

  const server = createMcpServer({
    name: 'metamask-mcp',
    version: '1.0.0',
  });

  await server.start();
}

main().catch(console.error);
```

### Environment Configuration

The package supports two environment modes:

```typescript
// E2E Testing Environment
const e2eConfig: E2EEnvironmentConfig = {
  environment: 'e2e',
  extensionName: 'MetaMask',
  defaultPassword: 'password123',
  toolPrefix: 'mm',
  artifactsDir: './test-artifacts',
  defaultChainId: 1337,
  ports: {
    anvil: 8545,
    fixtureServer: 12345,
  },
};

// Production-like Environment
const prodConfig: ProdEnvironmentConfig = {
  environment: 'prod',
  extensionName: 'MetaMask',
  toolPrefix: 'mm',
};
```

### Custom Tool Definitions

The package provides a fixed set of tools prefixed with `mm_`. Custom tool injection is currently not supported. You can inspect the available tool definitions using `getToolDefinitions()`:

```typescript
import { getToolDefinitions } from '@metamask/metamask-mcp-core';

const tools = getToolDefinitions();
console.log(`Available tools: ${tools.map(t => t.name).join(', ')}`);
```

### Registering Custom Tool Handlers

Custom tool handlers are not supported. The server uses a fixed set of handlers for the provided tools.

## Available Tools

All tools are prefixed with `mm_` and return a standardized response format:

```typescript
type ToolResponse<T> = {
  ok: boolean;           // Whether the operation succeeded
  ts: number;            // Timestamp (ms since epoch)
  sessionId?: string;    // Current session ID
  durationMs: number;    // Operation duration
  result?: T;            // Success payload
  error?: {              // Error details (when ok=false)
    code: string;
    message: string;
    details?: unknown;
  };
};
```

---

### Session Management Tools

#### `mm_build`

Build the extension from source. Requires `BuildCapability`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `buildType` | `"build:test"` | `"build:test"` | Build script to run |
| `force` | `boolean` | `false` | Force rebuild even if build exists |

**Output:**
```typescript
{
  buildType: "build:test";
  extensionPathResolved: string;  // Absolute path to built extension
}
```

**Example:**
```json
{ "buildType": "build:test", "force": true }
```

---

#### `mm_launch`

Launch a headed Chrome browser with the extension loaded. This is typically the first tool called.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `autoBuild` | `boolean` | `true` | Auto-build if extension not found |
| `stateMode` | `"default" \| "onboarding" \| "custom"` | `"default"` | Wallet initialization mode |
| `fixturePreset` | `string` | - | Named preset when `stateMode="custom"` |
| `fixture` | `object` | - | Direct fixture object when `stateMode="custom"` |
| `ports.anvil` | `number` | `8545` | Anvil RPC port |
| `ports.fixtureServer` | `number` | `12345` | Fixture server port |
| `slowMo` | `number` | `0` | Slow down actions (ms) for debugging |
| `extensionPath` | `string` | - | Custom extension directory path |
| `goal` | `string` | - | Session goal for knowledge store |
| `flowTags` | `string[]` | - | Flow categorization tags |
| `tags` | `string[]` | - | Free-form tags |
| `seedContracts` | `string[]` | - | Contracts to deploy on launch |

**State Modes:**
- `default` - Pre-onboarded wallet with 25 ETH, ready to use
- `onboarding` - Fresh state, requires wallet setup flow
- `custom` - Use provided fixture or preset

**Output:**
```typescript
{
  sessionId: string;        // Unique session identifier
  extensionId: string;      // Extension's Chrome ID
  state: ExtensionState;    // Initial extension state
  prerequisites?: [{        // Steps taken before launch
    step: string;
    description: string;
  }];
}
```

**Example:**
```json
{
  "stateMode": "default",
  "goal": "Test send flow",
  "flowTags": ["send"],
  "seedContracts": ["hst"]
}
```

---

#### `mm_cleanup`

Stop the browser and all services (Anvil, fixture server). Always call when done.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sessionId` | `string` | - | Optional session ID to clean up |

**Output:**
```typescript
{
  cleanedUp: boolean;  // Whether cleanup was performed
}
```

---

### Discovery Tools

#### `mm_get_state`

Get current extension state including screen, balance, network, and account.

**Input:** None

**Output:**
```typescript
{
  state: {
    isLoaded: boolean;
    currentUrl: string;
    extensionId: string;
    isUnlocked: boolean;
    currentScreen: ScreenName;
    accountAddress: string | null;
    networkName: string | null;
    chainId: number | null;
    balance: string | null;
  };
  tabs?: {
    active: { role: TabRole; url: string };
    tracked: { role: TabRole; url: string }[];
  };
}
```

---

#### `mm_list_testids`

List all visible `data-testid` attributes on the current page. Use to discover interaction targets.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `150` | Maximum items to return (1-500) |

**Output:**
```typescript
{
  items: [{
    testId: string;    // The data-testid value
    tag: string;       // HTML tag (button, input, div, etc.)
    text?: string;     // Visible text content
    visible: boolean;  // Whether element is visible
  }];
}
```

**Example Output:**
```json
{
  "items": [
    { "testId": "account-menu-icon", "tag": "button", "text": "", "visible": true },
    { "testId": "eth-overview-send", "tag": "button", "text": "Send", "visible": true },
    { "testId": "token-balance", "tag": "span", "text": "25 ETH", "visible": true }
  ]
}
```

---

#### `mm_accessibility_snapshot`

Get a trimmed accessibility tree with deterministic refs (e1, e2, ...). Refs can be used with `mm_click` and `mm_type`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rootSelector` | `string` | - | CSS selector to scope the snapshot |

**Included Roles:**
- **Actionable:** button, link, checkbox, radio, switch, textbox, combobox, menuitem
- **Important:** dialog, alert, status, heading

**Output:**
```typescript
{
  nodes: [{
    ref: string;       // Deterministic ref (e1, e2, e3, ...)
    role: string;      // ARIA role
    name: string;      // Accessible name
    disabled?: boolean;
    checked?: boolean;
    expanded?: boolean;
    path: string[];    // Ancestor path for context
  }];
}
```

**Example Output:**
```json
{
  "nodes": [
    { "ref": "e1", "role": "button", "name": "Send", "path": ["main", "div"] },
    { "ref": "e2", "role": "button", "name": "Swap", "path": ["main", "div"] },
    { "ref": "e3", "role": "textbox", "name": "Amount", "path": ["form"] }
  ]
}
```

---

#### `mm_describe_screen`

Comprehensive screen state combining extension state, testIds, and accessibility snapshot. Optionally includes screenshot.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeScreenshot` | `boolean` | `false` | Capture screenshot |
| `screenshotName` | `string` | - | Screenshot filename |
| `includeScreenshotBase64` | `boolean` | `false` | Include base64 in response |

**Output:**
```typescript
{
  state: ExtensionState;
  testIds: { items: TestIdItem[] };
  a11y: { nodes: A11yNodeTrimmed[] };
  screenshot: {
    path: string;
    width: number;
    height: number;
    base64?: string;
  } | null;
  priorKnowledge?: PriorKnowledgeV1;  // Past session hints
}
```

---

### Interaction Tools

#### `mm_click`

Click an element. Specify exactly ONE of: `a11yRef`, `testId`, or `selector`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `a11yRef` | `string` | - | Accessibility ref from `mm_accessibility_snapshot` (e.g., "e5") |
| `testId` | `string` | - | `data-testid` attribute value |
| `selector` | `string` | - | CSS selector |
| `timeoutMs` | `number` | `15000` | Max wait time (0-60000) |

**Output:**
```typescript
{
  clicked: boolean;
  target: string;                 // Resolved selector
  pageClosedAfterClick?: boolean; // True if click caused page close
}
```

**Examples:**
```json
{ "a11yRef": "e5" }
{ "testId": "confirm-btn" }
{ "selector": "button.primary" }
```

---

#### `mm_type`

Type text into an input element. Specify exactly ONE of: `a11yRef`, `testId`, or `selector`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `a11yRef` | `string` | - | Accessibility ref |
| `testId` | `string` | - | `data-testid` value |
| `selector` | `string` | - | CSS selector |
| `text` | `string` | **required** | Text to type |
| `timeoutMs` | `number` | `15000` | Max wait time |

**Output:**
```typescript
{
  typed: boolean;
  target: string;
  textLength: number;
}
```

**Example:**
```json
{ "testId": "amount-input", "text": "0.5" }
```

---

#### `mm_wait_for`

Wait for an element to become visible. Specify exactly ONE of: `a11yRef`, `testId`, or `selector`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `a11yRef` | `string` | - | Accessibility ref |
| `testId` | `string` | - | `data-testid` value |
| `selector` | `string` | - | CSS selector |
| `timeoutMs` | `number` | `15000` | Max wait time (100-120000) |

**Output:**
```typescript
{
  found: boolean;
  target: string;
}
```

---

#### `mm_navigate`

Navigate to a specific screen in the extension.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `screen` | `"home" \| "settings" \| "notification" \| "url"` | **required** | Target screen |
| `url` | `string` | - | Required when `screen="url"` |

**Output:**
```typescript
{
  navigated: boolean;
  currentUrl: string;
}
```

**Examples:**
```json
{ "screen": "home" }
{ "screen": "settings" }
{ "screen": "url", "url": "https://app.uniswap.org" }
```

---

### Multi-Tab Tools

#### `mm_wait_for_notification`

Wait for a notification popup to appear (e.g., after dApp interaction). Sets the notification page as active.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeoutMs` | `number` | `15000` | Max wait time (1000-60000) |

**Output:**
```typescript
{
  found: boolean;
  pageUrl: string;
}
```

---

#### `mm_switch_to_tab`

Switch the active page for subsequent interactions.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `role` | `"extension" \| "notification" \| "dapp" \| "other"` | - | Tab role to switch to |
| `url` | `string` | - | URL prefix to match |

**Output:**
```typescript
{
  switched: boolean;
  activeTab: {
    role: TabRole;
    url: string;
  };
}
```

**Example:**
```json
{ "role": "dapp" }
{ "url": "https://app.uniswap.org" }
```

---

#### `mm_close_tab`

Close a specific tab. Cannot close the extension home page.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `role` | `"notification" \| "dapp" \| "other"` | - | Tab role to close |
| `url` | `string` | - | URL prefix to match |

**Output:**
```typescript
{
  closed: boolean;
  closedUrl: string;
}
```

---

### Screenshot Tools

#### `mm_screenshot`

Capture a screenshot and save to `test-artifacts/screenshots/`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | **required** | Filename (without extension) |
| `fullPage` | `boolean` | `true` | Capture full page |
| `selector` | `string` | - | Capture specific element only |
| `includeBase64` | `boolean` | `false` | Include base64 in response |

**Output:**
```typescript
{
  path: string;      // File path
  width: number;
  height: number;
  base64?: string;   // If includeBase64=true
}
```

---

### Smart Contract Tools

#### `mm_seed_contract`

Deploy a smart contract to the local Anvil node. Requires `ContractSeedingCapability`.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `contractName` | `string` | **required** | Contract to deploy (see list below) |
| `hardfork` | `string` | `"prague"` | EVM hardfork |
| `deployerOptions.fromAddress` | `string` | - | Impersonate address |
| `deployerOptions.fromPrivateKey` | `string` | - | Deploy from specific key |

**Available Contracts:**
| Name | Description |
|------|-------------|
| `hst` | ERC-20 TST token |
| `nfts` | ERC-721 NFT collection |
| `erc1155` | ERC-1155 multi-token |
| `piggybank` | Simple ETH storage |
| `failing` | Always reverts (error testing) |
| `multisig` | Multi-signature wallet |
| `entrypoint` | ERC-4337 EntryPoint |
| `simpleAccountFactory` | ERC-4337 account factory |
| `verifyingPaymaster` | ERC-4337 paymaster |

**Output:**
```typescript
{
  contractName: string;
  contractAddress: string;
  deployedAt: string;  // ISO timestamp
}
```

---

#### `mm_seed_contracts`

Deploy multiple contracts in sequence.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `contracts` | `string[]` | **required** | Contracts to deploy (1-9) |
| `hardfork` | `string` | `"prague"` | EVM hardfork |

**Output:**
```typescript
{
  deployed: [{ contractName, contractAddress, deployedAt }];
  failed: [{ contractName, error }];
}
```

---

#### `mm_get_contract_address`

Get the deployed address of a contract.

**Input:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `contractName` | `string` | Contract name to look up |

**Output:**
```typescript
{
  contractName: string;
  contractAddress: string | null;
}
```

---

#### `mm_list_contracts`

List all contracts deployed in this session.

**Input:** None

**Output:**
```typescript
{
  contracts: [{
    contractName: string;
    contractAddress: string;
    deployedAt: string;
  }];
}
```

---

### Knowledge Store Tools

The knowledge store enables cross-session learning by recording tool invocations and their context.

#### `mm_knowledge_last`

Get the last N step records from the knowledge store.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n` | `number` | `20` | Number of steps (1-200) |
| `scope` | `"current" \| "all" \| { sessionId }` | `"current"` | Which sessions to query |
| `filters.flowTag` | `string` | - | Filter by flow tag |
| `filters.tag` | `string` | - | Filter by tag |
| `filters.screen` | `string` | - | Filter by screen |
| `filters.sinceHours` | `number` | - | Only steps from last N hours |
| `filters.gitBranch` | `string` | - | Filter by git branch |

**Output:**
```typescript
{
  steps: [{
    timestamp: string;
    tool: string;
    screen: ScreenName;
    snippet: string;      // Human-readable summary
    sessionId?: string;
    matchedFields?: string[];
    sessionGoal?: string;
  }];
}
```

---

#### `mm_knowledge_search`

Search step records by tool name, screen, testId, or accessibility names.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | **required** | Search query (1-200 chars) |
| `limit` | `number` | `20` | Max results (1-100) |
| `scope` | `"current" \| "all" \| { sessionId }` | `"all"` | Which sessions to search |
| `filters` | `KnowledgeFilters` | - | Additional filters |

**Output:**
```typescript
{
  matches: KnowledgeStepSummary[];
  query: string;
}
```

---

#### `mm_knowledge_summarize`

Generate a recipe-like summary of steps taken in a session.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | `"current" \| { sessionId }` | `"current"` | Session to summarize |

**Output:**
```typescript
{
  sessionId: string;
  stepCount: number;
  recipe: [{
    stepNumber: number;
    tool: string;
    notes: string;
  }];
}
```

---

#### `mm_knowledge_sessions`

List recent sessions with metadata.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `10` | Max sessions (1-50) |
| `filters` | `KnowledgeFilters` | - | Filter options |

**Output:**
```typescript
{
  sessions: [{
    sessionId: string;
    createdAt: string;
    goal?: string;
    flowTags: string[];
    tags: string[];
    git?: { branch?: string; commit?: string };
  }];
}
```

---

### Batching Tools

#### `mm_run_steps`

Execute multiple tools in sequence. Reduces round trips for multi-step flows.

**Input:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `steps` | `array` | **required** | Tool calls to execute (1-50) |
| `steps[].tool` | `string` | **required** | Tool name (e.g., `mm_click`) |
| `steps[].args` | `object` | `{}` | Tool arguments |
| `stopOnError` | `boolean` | `false` | Stop on first error |
| `includeObservations` | `"none" \| "failures" \| "all"` | `"all"` | When to include state observations |

**Output:**
```typescript
{
  steps: [{
    tool: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; details?: unknown };
    meta: { durationMs: number; timestamp: string };
  }];
  summary: {
    ok: boolean;      // All steps succeeded
    total: number;
    succeeded: number;
    failed: number;
    durationMs: number;
  };
}
```

**Example:**
```json
{
  "steps": [
    { "tool": "mm_click", "args": { "testId": "send-button" } },
    { "tool": "mm_type", "args": { "testId": "amount-input", "text": "0.1" } },
    { "tool": "mm_click", "args": { "testId": "confirm-button" } }
  ],
  "stopOnError": true
}
```

## Development

### Building

```bash
yarn build
```

### Testing

```bash
yarn test
```

### Local Development with yalc

```bash
# In this repo
yarn build && yalc publish

# In consumer repo
yalc add @metamask/metamask-mcp-core
```

## License

MIT
