# mm CLI — Agent Reference

You control a browser extension through the `mm` CLI. Every command talks to a local HTTP daemon that manages Playwright and the extension lifecycle. The daemon auto-starts when you run `mm launch`.

If you are running outside the target project directory, use `--project <path>` or set the `MM_PROJECT` environment variable to point at the project root. All commands accept `--project` before the command name (e.g., `mm --project ../metamask-extension launch`).

## Core Loop

```
mm launch                  # 1. Start browser + extension
mm describe-screen         # 2. See what's on screen (ALWAYS do this before interacting)
mm click <ref>             # 3. Interact using refs from describe-screen
mm describe-screen         # 4. Re-describe after every action to get fresh refs
mm cleanup --shutdown      # 5. Clean up when done
```

**Critical rules:**

- **Always `describe-screen` before interacting.** Refs like `e1`, `e2` are ephemeral — they change after every action.
- **Always `describe-screen` after interacting.** The screen state changed; your old refs are stale.
- **One target per command.** Specify exactly ONE of: a11y ref (`e5`), testId, or CSS selector.
- **Errors are structured.** Check the `error.code` field to decide recovery strategy (see Error Codes below).

## Commands

### Session Lifecycle

#### `mm launch`

Starts the daemon (if not running) and launches a headed Chrome session with the extension.

```
mm launch [--state default|onboarding|custom] [--extension-path <path>] [--force]
```

| Flag                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--state default`         | Pre-onboarded wallet with 25 ETH on local Anvil chain (default) |
| `--state onboarding`      | Fresh wallet requiring manual onboarding setup                  |
| `--state custom`          | Use a custom fixture for wallet state                           |
| `--extension-path <path>` | Override the extension build directory                          |
| `--force`                 | Replace an existing active session                              |

Returns: `sessionId`, `extensionId`, `state` (current extension state).

#### `mm cleanup`

Stops the browser, tears down test services, and releases session resources.

```
mm cleanup [--shutdown]
```

| Flag         | Description                       |
| ------------ | --------------------------------- |
| `--shutdown` | Also terminate the daemon process |

Without `--shutdown`, the daemon stays running for the next `mm launch`.

#### `mm status`

Shows daemon status: PID, port, uptime, allocated sub-ports.

```
mm status
```

#### `mm serve`

Manually starts the daemon without launching a browser. Useful for debugging.

```
mm serve [--background]
```

### Screen Discovery

#### `mm describe-screen`

**Your primary observation tool.** Returns the complete screen state:

- **Extension state**: current URL, screen name, network, account, balance
- **Test IDs**: visible `data-testid` attributes with text previews
- **A11y tree**: interactive elements with deterministic refs (`e1`, `e2`, ...)
- **Prior knowledge**: suggested actions from past sessions on this screen

```
mm describe-screen
```

The a11y tree only includes actionable roles: `button`, `link`, `checkbox`, `radio`, `switch`, `textbox`, `combobox`, `menuitem`, and important roles: `dialog`, `alert`, `status`, `heading`.

Each node looks like:

```json
{
  "ref": "e3",
  "role": "button",
  "name": "Confirm",
  "path": ["dialog:Transaction"]
}
```

Use the `ref` value (`e3`) for click/type/wait-for commands.

#### `mm get-state`

Returns extension state and tracked tabs without the full a11y tree.

```
mm get-state
```

Returns: `state` (extension state) and `tabs` (active + tracked tabs with roles and URLs).

#### `mm screenshot`

Captures a screenshot of the current page.

```
mm screenshot [--name <name>]
```

Returns: file path, dimensions.

### Element Interaction

All interaction commands accept an element reference from `describe-screen`.

#### `mm click <ref>`

Clicks an element. Waits up to 15s for it to become visible.

```
mm click e3
```

If the page closes after clicking (e.g., confirmation popup), the response includes `pageClosedAfterClick: true` — this is normal, not an error.

#### `mm type <ref> <text>`

Types text into an input field. Replaces existing content (uses `fill()`).

```
mm type e5 "0x1234abcd..."
```

#### `mm wait-for <ref>`

Blocks until an element becomes visible. Default timeout: 15s.

```
mm wait-for e7 [--timeout <ms>]
```

### Navigation

#### `mm navigate <url>`

Opens a new tab and navigates to the given URL.

```
mm navigate https://app.uniswap.org
```

#### `mm navigate-home`

Navigates the extension tab to the wallet home screen.

```
mm navigate-home
```

#### `mm navigate-settings`

Navigates the extension tab to the settings page.

```
mm navigate-settings
```

### Knowledge Store

The knowledge store records every tool invocation and uses past sessions to suggest actions.

#### `mm knowledge-search <query>`

Searches past sessions for steps matching the query. Matches against tool names, screen names, test IDs, and a11y node names.

```
mm knowledge-search "confirm transaction"
```

#### `mm knowledge-last`

Gets the most recent step records from the current session.

```
mm knowledge-last
```

#### `mm knowledge-sessions`

Lists recent sessions with metadata (goal, flow tags, timestamps).

```
mm knowledge-sessions
```

### Batch Execution

#### `mm run-steps <json>`

Executes multiple tool invocations in sequence from a JSON array. Each step specifies a tool name and arguments.

```
mm run-steps '{"steps":[{"tool":"click","args":{"a11yRef":"e3"}},{"tool":"wait_for","args":{"a11yRef":"e5"}}]}'
```

Supports `stopOnError` (halt on first failure) and returns per-step results with timing.

## Element Targeting

Every interaction command (`click`, `type`, `wait-for`) needs a target. You must provide exactly ONE of:

| Method           | Format              | Stability                       | When to use                                          |
| ---------------- | ------------------- | ------------------------------- | ---------------------------------------------------- |
| **a11y ref**     | `e1`, `e2`, ...     | Ephemeral (per describe-screen) | Default — use refs from the latest `describe-screen` |
| **testId**       | `data-testid` value | Stable across sessions          | When you know the testId from prior knowledge        |
| **CSS selector** | Any CSS selector    | Fragile                         | Last resort fallback                                 |

**Prefer a11y refs.** They come directly from the accessibility tree and map to ARIA selectors, making them the most reliable for the current screen state.

## Prior Knowledge

When you call `describe-screen`, the response may include a `priorKnowledge` section with:

- **`similarSteps`**: Past tool invocations on the same screen with confidence scores
- **`suggestedNextActions`**: Ranked actions based on historical success (e.g., "click confirm button")
- **`avoid`**: Targets that frequently fail on this screen — skip these

Use prior knowledge to guide your actions, but always verify against the current a11y tree.

## Error Codes

When a command fails, the response includes `error.code`. Use this to decide what to do:

| Code                          | Meaning                                      | Recovery                                                  |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `MM_NO_ACTIVE_SESSION`        | No browser session running                   | Run `mm launch` first                                     |
| `MM_SESSION_ALREADY_RUNNING`  | Session already exists                       | Run `mm cleanup` first, or use `--force`                  |
| `MM_TARGET_NOT_FOUND`         | Element ref/testId/selector not found        | Run `mm describe-screen` to get fresh refs                |
| `MM_WAIT_TIMEOUT`             | Element didn't appear in time                | Increase timeout or verify you're on the right screen     |
| `MM_CLICK_FAILED`             | Click failed after finding element           | Element may be obscured; try waiting or scrolling         |
| `MM_TYPE_FAILED`              | Type failed after finding element            | Element may not be an input; verify with describe-screen  |
| `MM_PAGE_CLOSED`              | Page was closed unexpectedly                 | Normal after some confirmations; run describe-screen      |
| `MM_NAVIGATION_FAILED`        | Navigation error or network failure          | Check URL validity; retry once                            |
| `MM_NOTIFICATION_TIMEOUT`     | Extension notification popup didn't appear   | Action may not have triggered a notification; check state |
| `MM_TAB_NOT_FOUND`            | Tab role/URL not found                       | Run `mm get-state` to see available tabs                  |
| `MM_CAPABILITY_NOT_AVAILABLE` | Feature requires a capability not configured | Check environment mode (e2e vs prod)                      |
| `MM_CONTEXT_SWITCH_BLOCKED`   | Can't switch context with active session     | Run `mm cleanup` first                                    |
| `MM_INVALID_INPUT`            | Bad parameters                               | Fix input and retry                                       |
| `MM_CONTRACT_NOT_FOUND`       | Unknown contract name for seeding            | See available contracts below                             |

## Available Contracts (E2E only)

These contracts can be deployed to the local Anvil chain via `seed_contract` / `seed_contracts`:

| Name                   | Type                                                |
| ---------------------- | --------------------------------------------------- |
| `hst`                  | ERC-20 token                                        |
| `nfts`                 | ERC-721 NFT                                         |
| `erc1155`              | ERC-1155 multi-token                                |
| `piggybank`            | Simple deposit contract                             |
| `failing`              | Contract that always reverts (for testing failures) |
| `multisig`             | Multi-signature wallet                              |
| `entrypoint`           | ERC-4337 EntryPoint                                 |
| `simpleAccountFactory` | ERC-4337 account factory                            |
| `verifyingPaymaster`   | ERC-4337 paymaster                                  |

## Flow Tags

When launching, tag your session with flow tags for cross-session knowledge:

| Tag               | Use for                        |
| ----------------- | ------------------------------ |
| `send`            | Token send flows               |
| `swap`            | Token swap flows               |
| `connect`         | dApp connection flows          |
| `sign`            | Message/transaction signing    |
| `onboarding`      | Wallet setup/onboarding        |
| `settings`        | Settings configuration         |
| `tx-confirmation` | Transaction confirmation flows |

## Daemon Model

- Daemon runs per project, state tracked in `.mm-server` at the project root
- Auto-starts on `mm launch` if not running
- Shuts down after 30 minutes of inactivity
- Logs to `.mm-daemon.log`
- One tool executes at a time (requests are queued)
- Project resolution: `--project` flag → `MM_PROJECT` env var → current git worktree

## Workflow Examples

### Basic Interaction

```bash
mm launch --state default
mm describe-screen
# Response includes a11y nodes: [{ ref: "e1", role: "button", name: "Send" }, ...]
mm click e1
mm describe-screen
# Now on send screen — get new refs
mm type e3 "0.01"
mm click e5
mm cleanup --shutdown
```

### Transaction with Notification

```bash
mm launch --state default
mm navigate https://app.uniswap.org
mm describe-screen
# Interact with dApp...
mm click e4                    # triggers wallet popup
mm wait-for e2 --timeout 10000 # wait for confirm button in notification
mm click e2                    # confirm
mm describe-screen             # check result
mm cleanup --shutdown
```

### Running From a Parent Folder

```bash
# Set once — all subsequent mm commands target this project
export MM_PROJECT=/path/to/metamask-extension

mm launch --state default
mm describe-screen
mm click e1
mm cleanup --shutdown

# Or use --project per command
mm --project ../metamask-extension launch
mm --project ../metamask-extension describe-screen
```

### Using Prior Knowledge

```bash
mm launch --state default --goal "Test send flow" --flow-tags send
mm describe-screen
# Response includes priorKnowledge.suggestedNextActions:
# [{ action: "click", preferredTarget: { type: "testId", value: "send-button" }, confidence: 0.85 }]
# Use the suggestion but verify the target exists in the current a11y tree
mm click e3
mm cleanup --shutdown
```

## Project-Specific Commands

<!-- Consumer repos extend this section -->

## Project-Specific Workflow Examples

<!-- Consumer repos add examples here -->
