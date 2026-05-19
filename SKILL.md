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
- **Always `describe-screen` after interacting** — OR use inline `observations` from mutating tool responses. Mutating tools (click, type, navigate, etc.) return an `observations` object with fresh `state`, `testIds`, and `a11y` refs. You can use these refs directly for the next interaction without calling `describe-screen`. Call `describe-screen` when you need `priorKnowledge` or screenshots.
- **One target per command.** Specify exactly ONE of: a11y ref (`e5`), testId, or CSS selector.
- **Errors are structured.** Check the `error.code` field to decide recovery strategy (see Error Codes below).

## Observation Behavior

Tool responses include different data based on the tool's category:

| Category      | Examples                                                          | Observations in response?                      |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| **Mutating**  | click, type, navigate, launch, cleanup, build, clipboard, cdp     | Yes — `state` + `a11y` (compacted) + `testIds` |
| **Read-only** | get_state, get_text, knowledge\_\*, get_context, set_context      | No — faster response                           |
| **Discovery** | describe_screen, list_testids, accessibility_snapshot, screenshot | Data is already in `result`                    |
| **Batch**     | run_steps                                                         | Controlled by `includeObservations` param      |

**Observation Compaction:** Mutating tool observations are **compacted** before returning: option runs of 3 or more under a combobox or listbox are replaced with a single summary node (e.g., `"55 options (refs e2–e56)"`). The `describe-screen` tool always returns the **full, unfiltered** a11y tree — use it when you need the complete option list or `priorKnowledge`.

**Diff-Based Observations:** After the first mutating tool call sets a baseline, subsequent mutations return **diff-based** observations. The `observations.a11y.diff` field (when present) shows what changed:

```json
{
  "added": ["e4", "e5"], // new node refs
  "removed": ["e2"], // disappeared node refs
  "unchanged": 3 // count of unchanged nodes
}
```

The `observations.a11y.nodes` field contains **only the changed and new nodes** (not all nodes). The baseline resets after `describe-screen`, `launch`, or `cleanup` — the next mutation returns a full compact observation (no `diff` field). When the diff would be larger than the full observation, the full option-filtered observation is returned instead (no `diff` field).

### Using inline observations (mutating tools)

After a mutating action, the response includes fresh screen state:

```json
{
  "ok": true,
  "result": { ... },
  "observations": {
    "state": { "screen": "send", "url": "...", "balance": "1.5 ETH" },
    "testIds": ["send-amount-input", "send-button"],
    "a11y": {
      "nodes": [
        { "ref": "e1", "role": "textbox", "name": "Amount" },
        { "ref": "e2", "role": "button", "name": "Send" }
      ]
    }
  }
}
```

You can use the `ref` values from `observations.a11y.nodes` for the next interaction — no `describe-screen` needed. Note that refs in compacted observations may be summary nodes (e.g., `"55 options (refs e2–e56)"`) when there are 3+ options under a combobox or listbox.

**Quick reference:**

- Use `observations.state` for quick checks (screen name, loading status, balance, etc.)
- Use `observations.a11y.nodes` with the compact refs for the next interaction
- Call `describe-screen` only when you need the full tree or `priorKnowledge`

```bash
mm click e3                 # mutating: response includes fresh observations
# observations.a11y.nodes has updated refs — use them directly:
mm type e1 "0.01"           # use ref from previous response
```

Call `describe-screen` explicitly when you need:

- `priorKnowledge` (historical actions for this screen)
- A screenshot via `includeScreenshot`
- Full context after unexpected navigation
- The complete, unfiltered a11y tree (e.g., all options in a dropdown)

### `run_steps` and `includeObservations`

The `run_steps` tool collects observations once after all steps complete. Control inclusion with the `includeObservations` parameter:

| Value             | Behavior                                      |
| ----------------- | --------------------------------------------- |
| `'all'` (default) | Always include final state observations       |
| `'none'`          | Never include observations (fastest response) |
| `'failures'`      | Include observations only if any step failed  |

```json
{
  "steps": [
    { "tool": "click", "args": { "a11yRef": "e3" } },
    { "tool": "type", "args": { "a11yRef": "e5", "text": "0.01" } }
  ],
  "includeObservations": "failures"
}
```

## Commands

### Session Lifecycle

#### `mm launch`

Starts the daemon (if not running) and launches a headed Chrome session with the extension.

```
mm launch [--context e2e|prod] [--state default|onboarding|custom] [--extension-path <path>] [--goal <text>] [--force] [--flow-tags <tags>]
```

| Flag                      | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `--context e2e\|prod`     | Set the environment context before launching                    |
| `--state default`         | Pre-onboarded wallet with 25 ETH on local Anvil chain (default) |
| `--state onboarding`      | Fresh wallet requiring manual onboarding setup                  |
| `--state custom`          | Use a custom fixture for wallet state                           |
| `--extension-path <path>` | Override the extension build directory                          |
| `--goal <text>`           | Tag the session with a goal for knowledge store                 |
| `--force`                 | Replace an existing active session                              |
| `--flow-tags <tags>`      | Comma-separated flow tags for cross-session knowledge           |

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

#### `mm stop`

Stops the daemon process (symmetric to `mm serve`). Sends a best-effort cleanup before shutdown.

```
mm stop [--force]
```

| Flag      | Description                                          |
| --------- | ---------------------------------------------------- |
| `--force` | Remove stale `.mm-server` state from crashed daemons |

#### `mm build`

Triggers an extension build using the configured `BuildCapability`. The daemon must be running.

```
mm build [--force]
```

| Flag      | Description                                            |
| --------- | ------------------------------------------------------ |
| `--force` | Force a rebuild even if the extension is already built |

#### `mm serve`

Manually starts the daemon without launching a browser. Useful for debugging.

```
mm serve [--background]
```

### Screen Discovery

#### `mm describe-screen`

**Your primary observation tool.** Returns the complete screen state:

- **Extension state**: current URL, screen name, network, account, balance
- **Active tab**: the currently focused tab's role and URL (if tracked)
- **Test IDs**: visible `data-testid` attributes with text previews
- **A11y tree**: interactive elements with deterministic refs (`e1`, `e2`, ...)
- **Prior knowledge**: suggested actions from past sessions on this screen

```
mm describe-screen
```

The a11y tree includes actionable roles: `button`, `link`, `checkbox`, `radio`, `switch`, `textbox`, `combobox`, `menuitem`; structural roles: `menu`, `listbox`, `option`, `tab`, `tabpanel`, `list`, `listitem`; and important roles: `dialog`, `alert`, `status`, `heading`.

Each node looks like:

```json
{
  "ref": "e3",
  "role": "button",
  "name": "Confirm",
  "path": ["dialog:Transaction"],
  "testId": "confirm-footer-button",
  "textContent": "Confirm"
}
```

The `testId` and `textContent` fields appear only on nodes with short or generic names — they provide extra context from the DOM to help identify ambiguous elements. Nodes with clear names omit these fields.

When 3+ consecutive identical nodes appear (same role, name, and path), they are collapsed into a summary like `… 3 more "maskicon" (refs e2–e4)` to reduce token waste. Individual refs still work for targeting.

Use the `ref` value (`e3`) for click/type/get-text/wait-for commands.

#### `mm list-testids`

Lists all visible `data-testid` attributes on the current page with text previews.

```
mm list-testids [--limit <n>]
```

| Flag          | Description                          |
| ------------- | ------------------------------------ |
| `--limit <n>` | Maximum number of test IDs to return |

Useful when you know a `testId` value and want to verify it exists. Prefer `describe-screen` for general observation.

#### `mm accessibility-snapshot`

Captures just the trimmed accessibility tree with deterministic refs. Lighter than `describe-screen` (no state, no prior knowledge, no test IDs).

```
mm accessibility-snapshot [--root <selector>]
```

| Flag                | Description                                     |
| ------------------- | ----------------------------------------------- |
| `--root <selector>` | CSS selector to scope the snapshot to a subtree |

#### `mm screenshot`

Captures a screenshot of the current page.

```
mm screenshot [--name <name>]
```

Returns: file path, dimensions.

### Element Interaction

All interaction commands accept an element reference from `describe-screen`.

#### `mm click <ref>`

Clicks an element. Waits for it to become visible, then clicks. The `--timeout` flag covers the **entire operation** (visibility wait + click action combined). Default: 15s.

```
mm click e3
mm click --testid end-accessory --within "testid:account-list-item/0"
mm click --testid onboarding-complete-done --timeout 60000
```

Use `--within` to scope the target inside a parent element. Values use the format `testid:<id>`, `selector:<css>`, or a bare a11y ref (`e5`).

If the page closes after clicking (e.g., confirmation popup), the response includes `pageClosedAfterClick: true` — this is normal, not an error.

**Timeout behavior:** If the click hangs (e.g., element found but click never resolves due to a side effect), `MM_CLICK_TIMEOUT` is returned with structured diagnostics. The click may still complete in the background — run `mm describe-screen` to verify current state before retrying.

#### `mm type <ref> <text>`

Types text into an input field. **Clears the field first**, then sets the new value (uses Playwright's `fill()`). No `clearFirst` flag needed — clearing is always implicit. Accepts `--timeout <ms>` to set the total time budget for the visibility wait + fill operation. Default: 15s.

```
mm type e5 "0x1234abcd..."
mm type e5 "0x1234abcd..." --timeout 10000
```

#### `mm get-text <ref>`

Reads the text content of an element. Returns the inner text, target descriptor, and character length. Useful for asserting visible values without screenshots. Categorized as read-only (no observations in response). Accepts `--timeout <ms>` to set the total time budget. Default: 15s.

```
mm get-text e5
mm get-text --testid balance-amount
mm get-text --testid amount --within "testid:tx-row"
mm get-text --testid balance-amount --timeout 5000
```

Returns: `text` (string content), `target` (descriptor like `testId:balance-amount`), `length` (character count).

#### `mm wait-for <ref>`

Blocks until an element becomes visible. Default timeout: 15s.

```
mm wait-for e7 [--timeout <ms>]
mm wait-for --testid confirm-btn --within "testid:dialog-container"
```

#### `mm wait-for-notification`

Waits for the extension notification popup to appear within a timeout. Returns the notification page URL.

```
mm wait-for-notification [--timeout <ms>]
```

#### `mm clipboard`

Reads from or writes to the system clipboard via Chrome DevTools Protocol. Useful for pasting seed phrases or copying addresses.

```
mm clipboard read
mm clipboard write "0x1234abcd..."
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

#### `mm switch-to-tab`

Switches the active page to a tab matching a given role or URL prefix. Supports a positional role as the first argument.

```
mm switch-to-tab dapp
mm switch-to-tab --role extension
mm switch-to-tab --url https://app.uniswap.org
```

#### `mm close-tab`

Closes a browser tab matching a given role or URL. Falls back to the extension tab if the active tab is closed.

```
mm close-tab --role dapp
mm close-tab --url https://app.uniswap.org
```

### State & Context

#### `mm get-state`

Returns extension state and tracked tabs without the full a11y tree.

```
mm get-state
```

Returns: `state` (extension state) and `tabs` (active + tracked tabs with roles and URLs).

#### `mm get-context`

Returns the current environment context (`e2e` or `prod`), session status, available capabilities, and whether context switching is allowed.

```
mm get-context
```

#### `mm set-context`

Switches the session environment between `e2e` and `prod` modes. Blocked while a session is active — run `mm cleanup` first.

```
mm set-context <e2e|prod>
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

#### `mm knowledge-summarize`

Generates a recipe-style summary of a session's tool invocations, showing the step sequence with targets and outcomes.

```
mm knowledge-summarize [--session <id>]
```

### Contracts (E2E only)

#### `mm seed-contract <name>`

Deploys a single smart contract to the local Anvil chain by name. Requires `ContractSeedingCapability`.

```
mm seed-contract hst
mm seed-contract piggybank --hardfork london
```

| Flag                | Description                        |
| ------------------- | ---------------------------------- |
| `--hardfork <fork>` | EVM hardfork to use for deployment |

#### `mm seed-contracts <names...>`

Deploys multiple smart contracts in sequence.

```
mm seed-contracts hst nfts piggybank
```

#### `mm get-contract-address <name>`

Looks up the deployed address of a contract by name.

```
mm get-contract-address hst
```

#### `mm list-contracts`

Lists all contracts deployed in the current session with addresses and timestamps.

```
mm list-contracts
```

### Batch Execution

#### `mm run-steps <json>`

Executes multiple tool invocations in sequence from a JSON array. Each step specifies a tool name and arguments.

```
mm run-steps '{"steps":[{"tool":"click","args":{"a11yRef":"e3"}},{"tool":"wait_for","args":{"a11yRef":"e5"}}]}'
```

Supports `stopOnError` (halt on first failure) and returns per-step results with timing. The `includeObservations` param controls whether final-state observations appear in the response: `'all'` (default), `'none'`, or `'failures'` (only on partial failure). Use `batchTimeoutMs` to set an overall deadline — if exceeded, remaining steps are marked as skipped and partial results are returned immediately. The summary includes a `skipped` count alongside `succeeded` and `failed`.

Tool aliases are supported in steps: `navigate_home` / `navigate-home`, `navigate_settings` / `navigate-settings`, and `navigate_notification` / `navigate-notification` resolve to `navigate` with the appropriate `screen` argument. You can also use `ref` as shorthand for `a11yRef` in step args and within targets.

### Advanced

#### `mm cdp <method> [params-json] [--timeout <ms>]`

Sends a raw Chrome DevTools Protocol command against the active page. This is an escape hatch for cases where structured tools are insufficient — e.g., evaluating JavaScript, enabling network tracking, or inspecting the DOM tree directly.

```bash
mm cdp Runtime.evaluate '{"expression":"document.title"}'
mm cdp Network.enable
mm cdp DOM.getDocument '{"depth":2}' --timeout 60000
```

| Argument        | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `<method>`      | CDP method name (e.g., `Runtime.evaluate`, `DOM.getDocument`) |
| `[params-json]` | Optional JSON object with method-specific parameters          |
| `--timeout`     | Per-command timeout in ms (default: 30 000, max: 30 000)      |

**Blocked methods** (would destroy the browser session): `Browser.close`, `Target.closeTarget`, `Target.disposeBrowserContext`, `Browser.crashGpuProcess`. Attempting a blocked method returns `MM_CDP_BLOCKED`.

The tool is categorized as **mutating** — run `describe-screen` afterward to re-sync if the CDP call changed page state.

## Element Targeting

Every interaction command (`click`, `type`, `get-text`, `wait-for`) needs a target. You must provide exactly ONE of:

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

| Code                             | Meaning                                            | Recovery                                                                                            |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MM_NO_ACTIVE_SESSION`           | No browser session running                         | Run `mm launch` first                                                                               |
| `MM_SESSION_ALREADY_RUNNING`     | Session already exists                             | Run `mm cleanup` first, or use `--force`                                                            |
| `MM_TARGET_NOT_FOUND`            | Element ref/testId/selector not found              | Run `mm describe-screen` to get fresh refs                                                          |
| `MM_WAIT_TIMEOUT`                | Element didn't appear in time                      | Increase timeout or verify you're on the right screen                                               |
| `MM_CLICK_FAILED`                | Click failed after finding element                 | Element may be obscured; try waiting or scrolling                                                   |
| `MM_CLICK_TIMEOUT`               | Click action timed out (element found, click hung) | Run `mm describe-screen` to verify if click completed; retry with `--timeout` or different approach |
| `MM_TYPE_TIMEOUT`                | Fill action timed out                              | Run `mm describe-screen` to verify state; retry with `--timeout`                                    |
| `MM_GETTEXT_TIMEOUT`             | textContent action timed out                       | Retry with `--timeout`                                                                              |
| `MM_GETTEXT_FAILED`              | getText operational failure (non-timeout)          | Element may be detached; run `mm describe-screen` and re-target                                     |
| `MM_TYPE_FAILED`                 | Type failed after finding element                  | Element may not be an input; verify with describe-screen                                            |
| `MM_PAGE_CLOSED`                 | Page was closed unexpectedly                       | Normal after some confirmations; run describe-screen                                                |
| `MM_CLIPBOARD_PERMISSION_DENIED` | Clipboard permission denied by browser             | Check browser permissions; try CDP approach                                                         |
| `MM_CLIPBOARD_LAVAMOAT_BLOCKED`  | Clipboard blocked by LavaMoat policy               | Extension security policy blocks clipboard; use alternative input method                            |
| `MM_CLIPBOARD_FAILED`            | Clipboard operation failed                         | Retry; check if page is still active                                                                |
| `MM_NAVIGATION_FAILED`           | Navigation error or network failure                | Check URL validity; retry once                                                                      |
| `MM_NOTIFICATION_TIMEOUT`        | Extension notification popup didn't appear         | Action may not have triggered a notification; check state                                           |
| `MM_TAB_NOT_FOUND`               | Tab role/URL not found                             | Run `mm get-state` to see available tabs                                                            |
| `MM_CAPABILITY_NOT_AVAILABLE`    | Feature requires a capability not configured       | Check environment mode (e2e vs prod)                                                                |
| `MM_CONTEXT_SWITCH_BLOCKED`      | Can't switch context with active session           | Run `mm cleanup` first                                                                              |
| `MM_INVALID_INPUT`               | Bad parameters                                     | Fix input and retry                                                                                 |
| `MM_BATCH_TIMEOUT`               | `batchTimeoutMs` deadline exceeded                 | Remaining steps were skipped; check partial results                                                 |
| `MM_CDP_BLOCKED`                 | CDP method is blocked (destructive)                | Use a different CDP method; see blocked list                                                        |
| `MM_CDP_FAILED`                  | CDP command failed or timed out                    | Check method name/params; retry or increase timeout                                                 |
| `MM_CONTRACT_NOT_FOUND`          | Unknown contract name for seeding                  | See available contracts below                                                                       |

## Interaction Timeout Diagnostics

When a timeout error occurs (`MM_CLICK_TIMEOUT`, `MM_TYPE_TIMEOUT`, `MM_WAIT_TIMEOUT`, `MM_GETTEXT_TIMEOUT`), the error response includes a `diagnostics` object with details about what happened:

```json
{
  "code": "MM_CLICK_TIMEOUT",
  "message": "Click action timed out after 15000ms. Note: the click action may have completed in the background after this timeout. Run describe-screen to verify current page state before retrying.",
  "diagnostics": {
    "phase": "action",
    "targetType": "testId",
    "targetValue": "cancel-btn",
    "timeoutMs": 15000,
    "elapsedMs": 15001,
    "elementFound": true,
    "elementVisible": true,
    "elementEnabled": true,
    "boundingBox": { "x": -100, "y": 500, "width": 80, "height": 40 },
    "suspectedCause": "element-offscreen"
  }
}
```

**`suspectedCause` values:**

- `element-not-found` — element is not in the DOM. Solution: verify you're on the right screen and check the selector/testId with `mm describe-screen`.
- `element-offscreen` — element is in the DOM and visible but outside the viewport. Solution: scroll into view before clicking.
- `element-not-actionable` — element is visible but disabled. Solution: wait for it to become enabled.
- `page-closed` — the browser page was closed during the operation.
- `unknown` — cause could not be determined.

**Recovery pattern after any timeout:**

1. Always run `mm describe-screen` first — the action may have completed in the background.
2. Use `suspectedCause` to choose a recovery strategy.
3. For `element-offscreen`: try scrolling or using a different selector.
4. For visibility timeouts: use `mm wait-for --timeout <ms>` before the interaction.

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
