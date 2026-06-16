# iOS Runner Architecture

`ios-runner` provides the iOS-side automation runtime used by
`@metamask/client-mcp-core` for MetaMask Mobile sessions.

It combines two complementary discovery mechanisms:

- XCUITest HTTP runner (`AgentDeviceRunner`) for interaction and primary snapshots.
- AXSnapshot binary for robust fallback discovery when XCTest accessibility snapshots degrade.

## Goals

- Keep MetaMask foregrounded and controllable for LLM-driven interaction.
- Avoid runner-side UI side effects during health checks.
- Recover from transient runner failures without forcing full session rebuilds.
- Preserve actionable discovery data across unlock and navigation transitions.

## High-Level System

```
┌──────────────────────────────────────────────────────────────────────┐
│                     @metamask/client-mcp-core                        │
│  IOSPlatformDriver + XCUITestClient + Runner Lifecycle              │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTP JSON commands
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AgentDeviceRunnerUITests (XCUITest host process)                     │
│  - command dispatch                                                   │
│  - ping/bind/tap/type/fill/snapshot                                  │
│  - exception-safe XCTest wrappers                                    │
└──────────────────────────────────────────────────────────────────────┘
            │                                      │
            │ XCUITest snapshots                   │ fallback trigger
            ▼                                      ▼
┌──────────────────────────────┐      ┌───────────────────────────────┐
│ XCUIElement snapshot graph   │      │ AXSnapshot Swift binary       │
│ (fast path)                  │      │ (accessibility fallback path) │
└──────────────────────────────┘      └───────────────────────────────┘
            │                                      │
            └──────────────────┬───────────────────┘
                               ▼
                    normalized MCP discovery output
```

## Command Protocol

Runner command API is optimized for reliability, not just raw XCTest parity.

- `ping`: health check without changing app focus.
- `bind`: binds target app context and metadata without snapshot side effects.
- `snapshot`: requests XCTest accessibility snapshot.
- `tapElement`: interaction command for resolved element IDs.
- `typeText`: direct typing path (kept for compatibility).
- `fill`: resilient text entry path used when direct typing is unstable.

The MCP-facing tools stay stable (`mm_click`, `mm_type`, `mm_wait_for`), while
driver internals decide whether to route text entry to typing or `fill` behavior.

## Discovery Strategy

Default backend: `xctest-with-ax-fallback`

```
Discovery request
  ├─ Try XCTest snapshot
  │    ├─ success + useful tree -> use XCTest tree
  │    └─ empty/invalid/degraded -> classify error
  └─ AX fallback
       ├─ run AXSnapshot binary
       ├─ choose best root/window set (upstream-style heuristics)
       └─ normalize to MCP a11y + testId-like discovery model
```

Important safeguards:

- Empty XCTest results do not wipe previously valid ref maps.
- Recovery errors surface as explicit error codes, including:
  - `MM_IOS_EMPTY_SNAPSHOT`
  - `MM_IOS_RUNNER_RECOVERING`
  - `MM_IOS_AX_PERMISSION_REQUIRED`
  - `MM_IOS_AX_BINARY_MISSING`
  - `MM_IOS_AX_SNAPSHOT_FAILED`

## Recovery Model

Recovery is designed to minimize disruptive simulator behavior.

- Readiness checks use `ping` (not snapshot), reducing unnecessary UI churn.
- Runner lifecycle can restart and rebind command channel on transient failures.
- Interaction polling handles temporary recovery states and retries safely.

## Build and Artifacts

Native components ship as source and build lazily on first use:

- `yarn build` compiles TypeScript only.
- `yarn build:ios-runner` and `yarn build:axsnapshot` compile native components
  on macOS (developer convenience; not required for consumers).
- On first iOS command, the runtime auto-builds the XCUITest runner and
  AXSnapshot binary, caching them at `~/.metamask-mobile-cli/`. Subsequent runs
  reuse the cached binaries; cache invalidates automatically when sources or
  the Xcode toolchain change.
- Override the AXSnapshot binary path with
  `METAMASK_AXSNAPSHOT_BINARY=<absolute-path>`.
- Override the XCUITest DerivedData cache path with
  `IOS_RUNNER_DERIVED_DATA_PATH=<absolute-path>` (must resolve under
  `~/.metamask-mobile-cli/`).

Runner diagnostics:

- Per-run Xcode logs are written under `test-artifacts/ios-runner-logs`.
- Startup failures include log location and stdout/stderr tails for triage.

## Related Files

- `ios-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift`
- `ios-runner/AXSnapshot/Sources/AXSnapshot/main.swift`
- `src/platform/ios/ios-driver.ts`
- `src/platform/ios/runner-lifecycle.ts`
- `src/platform/ios/ax-snapshot.ts`

## Attribution

This implementation is derived from Callstack Incubator's `agent-device` and
adapted for MetaMask Mobile MCP workflows. See `ios-runner/ATTRIBUTION.md`.
