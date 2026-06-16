# Hermes CDP Target Identity Hardening + Per-Session Metro Port

**Status:** APPROVED (Momus round 2, 2026-05-22). Ready for implementation. Revalidated 2026-05-23 after parallel-session distribution changes; line citations and assumptions still hold.

Design decisions locked in by user during analysis session. Plan went through two rounds of Momus critic review:

- **Round 1** (session `ses_1afe74534ffe3uGwOo7v6L124c`): REJECT — substantive gaps on bundle ID variants, RN/Hermes compatibility, probe latency budget, edge-case test coverage, cross-repo coordination, and coverage gate.
- **Round 2** (session `ses_1afe00165ffepeeJwx1pqDFTHa`): ACCEPT after addressing all round-1 items plus one minor follow-up (added test T26 for missing `response.result.result.value`).

Additional finding surfaced during revision (not in Momus round 1, but a real blocker): `HermesCdpInput.metroPort` is currently REQUIRED in `src/tools/types/tool-inputs.ts`; must be relaxed to optional or Decision 6 (per-session port) is silently neutered. Captured as Phase 1 change 5.

### 2026-05-23 Revalidation

A parallel session shifted iOS file distribution (now lazy-build at consumer install time; package ships `ios-runner/` source rather than prebuilt binaries). Re-verified all plan line citations against the current working tree:

- `src/platform/ios/ios-driver.ts:38,126,165` — unchanged.
- `src/tools/hermes-cdp.ts:195` (`Date.now()` id generation) — unchanged.
- `src/tools/types/tool-inputs.ts:175` (`metroPort: number` required) — unchanged.
- `src/tools/types/errors.ts:48-49` (existing `MM_HERMES_CONNECTION_FAILED`, `MM_HERMES_TARGET_NOT_FOUND`) — unchanged; 3 new codes still absent.

Parallel-session touched files (no overlap with plan's source scope): `package.json` (`"files"` adds `ios-runner/`; new `build:axsnapshot`, `build:ios-runner`, `build:native:sanity` scripts), `scripts/prepack.sh` (runs `yarn build:native:sanity` on Darwin), `scripts/verify-pack-contents.sh` (NEW — CI verification of tarball contents), `.github/workflows/build-lint-test.yml` (runs `verify-pack-contents.sh`), `README.md` (new "iOS Prerequisites" section near top). Captured in the acceptance gate (Phase 5) and Phase 5 README work below.

## Context

**Repo:** `/Users/joaotavares/Documents/projects/consensys/client-mcp-core-mobile-support`
**Package:** `@metamask/client-mcp-core`
**Branch:** `cryptotavares/mobile-support` (uncommitted; adds iOS mobile support to the `mm` CLI / HTTP daemon)
**Trigger:** Code review (`/review-multiple-agents`) flagged the new `hermes_cdp` tool as a critical security concern.

### Original Finding

`src/tools/hermes-cdp.ts` connects to React Native Hermes via Metro's inspector proxy WebSocket. The reviewers flagged it as an "arbitrary code execution backdoor" because:

1. Method blocklist only blocks `Runtime.terminateExecution` and `Inspector.detached` — `Runtime.evaluate` (arbitrary JS exec) is allowed.
2. Target selection uses substring match: `searchable.includes('hermes') || searchable.includes('metamask')`, falling back to `targets[0]` if no match.
3. `webSocketDebuggerUrl` is accepted without host/protocol/port validation.

### Reframed Threat Model

User clarified: **this is a testing tool — `Runtime.evaluate` is intended functionality**. The actual concern is:

> Don't allow `hermes_cdp` to execute against any target other than the MetaMask app itself.

Concrete attack/error scenarios on a dev machine:

| Scenario                                             | Today's behavior                                               |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| Workspace/monorepo running MetaMask + another RN app | Substring match could pick the wrong one                       |
| Stale debug session after app reload                 | `targets[0]` fallback picks oldest, not most-recent            |
| Wrong `--metro-port` typo                            | Silently evals against a different project's Metro             |
| Synthetic legacy page (RN < 0.74)                    | `targets[0]` fallback hits the synthetic page, not the real VM |
| Spoofed `app=` registration (local attacker)         | No detection; Metro has no auth                                |

## Identity Signals (from Metro `/json` payload research)

Source: `@react-native/dev-middleware` at SHA `1632b741`. The `PageDescription` type:

```ts
{
  id: string;                    // "{deviceId}-{pageId}" — proxy counter; not stable
  title: string;                 // "{appId} ({deviceName})" — composite string
  appId: string;                 // ⚠️ iOS bundle ID / Android package — SELF-REPORTED, unauthenticated
  description: string;
  webSocketDebuggerUrl: string;  // ws://localhost:PORT/inspector/debug?device=X&page=Y
  reactNative: {
    logicalDeviceId: string;     // ✅ SHA256(apple-{IDFV}-{bundleId}-{fusebox|legacy}) — stable
    capabilities: {
      nativePageReloads?: boolean;       // ✅ true ⇒ modern Hermes target
      nativeSourceCodeFetching?: boolean;
      supportsMultipleDebuggers?: boolean;
    };
  };
}
```

### Signal Reliability Tiers

| Tier        | Signal                                                | Notes                                                        |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| 1           | `HermesInternal.getRuntimeProperties()` runtime probe | **Definitive** — only exists in Hermes; unforgeable          |
| 2           | Strict equality `appId === 'io.metamask.MetaMask'`    | Reliable absent local attacker (self-reported but practical) |
| 3           | `reactNative.logicalDeviceId` pinning across calls    | Stable; disambiguates multi-device on same Metro             |
| 4           | `reactNative.capabilities.nativePageReloads === true` | Filters synthetic legacy page                                |
| 5 (current) | Substring match on `title`/`description`              | Trivially spoofable; current behavior                        |

## Decisions Locked In

| #   | Question                                                               | Decision                            | Rationale                                                                                                                                                     |
| --- | ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auto-probe `HermesInternal` on every call?                             | **Yes (default ON)**                | Strongest safety; ~50ms latency acceptable                                                                                                                    |
| 2   | Require MetaMask-side marker (`globalThis.__METAMASK_DEBUG_MARKER__`)? | **No**                              | `HermesInternal` + strict `appId` is sufficient; avoids cross-repo coordination                                                                               |
| 3   | Action on probe failure?                                               | **Hard error**                      | Refuse user's CDP method; new code `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                            |
| 4   | Pinning scope?                                                         | **iOS session only**                | Cleared on session cleanup                                                                                                                                    |
| 5   | Source of `expectedAppId`?                                             | **`platformDriver.getAppId()`**     | Uses existing `IOSPlatformDriver.#appBundleId` (defaults to `'io.metamask.MetaMask'`; consumer MUST override for dev/QA bundle IDs — see Cross-Repo Contract) |
| 6   | Per-session Metro port?                                                | **Option β: thread through launch** | Multi-worktree use case: each daemon owns its Metro port                                                                                                      |

### Multi-Worktree / Multi-Simulator Context

User's question: "Does this support multiple simulators? Devs work on 2-3 tasks in parallel with worktrees."

**What's already multi-capable:**

- Daemon: per-worktree (`.mm-server` state file isolates by project root)
- iOS runner lifecycle: keyed by xcodebuild `destination` (multiple sims OK)
- `simctl`: per-UDID (concurrent boot OK)
- `IOSPlatformDriver`: per-session instance

**What's not:** Metro. The current `hermes_cdp` defaults `metroPort` to `8081` with no session-level coordination. Decision 6 (Option β) closes this: `LaunchInput.metroPort` plumbed through `SessionLaunchInput` → consumer's `IOSPlatformDriver` constructor → driver stores it → `hermes-cdp.ts` reads via `driver.getMetroPort()`.

**Out of scope:** Single Metro shared across multiple simulators running MetaMask. Documented as unsupported.

## RN / Hermes Compatibility & Latency Budget

### Compatibility Posture

This package has **no direct React Native dependency** (verified: `package.json` peer deps are Playwright-only). Hermes/Metro coordination happens at runtime against whatever RN version the MetaMask Mobile consumer ships. Implications:

- The `HermesInternal.getRuntimeProperties()` API is what Hermes exposes today across all RN versions MetaMask Mobile has shipped to date (≥ 0.74). It is unforgeable from non-Hermes runtimes, which is the safety property we rely on.
- If a future RN/Hermes bump renames or removes this API, the failure mode is **fail-closed**: every `hermes_cdp` call returns `MM_HERMES_TARGET_NOT_VERIFIED` until the probe expression is updated. This is intentional and safer than silent fallback to substring matching.
- The `PageDescription` shape (`appId`, `reactNative.logicalDeviceId`, `reactNative.capabilities.nativePageReloads`) was read from `@react-native/dev-middleware` SHA `1632b741`. This is research-only; the package does not import from it at runtime.

**Smoke validation requirement** (Phase 5 acceptance): manual smoke against the current MetaMask Mobile RN version must include exercising `HermesInternal.getRuntimeProperties()` once and recording the OSS Release Version it reports. If the probe fails on a known-good Hermes target, the API has shifted and Phase 3 needs a probe-expression update before merge.

### Latency Budget

Today: 2 round-trips per `hermes_cdp` call (Metro discovery `/json` + user method WS).
After this change: 3 round-trips (Metro discovery + identity probe + user method WS).

**Acceptance budget for per-call `hermes_cdp` latency on a dev machine (loaded with 1 simulator, 1 Metro):**

- p50: ≤ 80 ms
- p95: ≤ 250 ms

If manual smoke shows p95 > 250 ms on the simulator + Metro setup the consumer team uses for `run_steps` batches, open a follow-up ticket for probe-result caching (with explicit TOCTOU mitigation on app reload). Probe caching is **not** in this plan's scope.

Measurement procedure during manual smoke: time 10 consecutive `mm hermes-cdp Runtime.evaluate '{"expression":"1+1"}'` calls; report min / median / p95 in the smoke notes attached to the implementation PR.

## Implementation Plan (5 Phases)

### Phase 1 — Type & Interface Scaffolding (additive, non-breaking)

**Files:**

- `src/platform/types.ts`
- `src/server/session-manager.ts`
- `src/tools/types/tool-inputs.ts`
- `src/tools/types/errors.ts`
- `src/validation/schemas.ts` (HermesCdp schema relaxation — see change 5 below)

**Changes:**

1. `IPlatformDriver` — four new optional methods:

   ```ts
   getAppId?(): string | undefined;
   getMetroPort?(): number | undefined;
   getPinnedHermesDeviceId?(): string | undefined;
   setPinnedHermesDeviceId?(id: string): void;
   ```

2. `SessionLaunchInput.metroPort?: number` (optional, JSDoc explains consumer contract: pass to `IOSPlatformDriver` constructor).

3. `LaunchInput.metroPort?: number` (mirror).

4. `ErrorCodes` — three new:
   - `MM_HERMES_TARGET_NOT_VERIFIED`
   - `MM_HERMES_UNSAFE_TARGET`
   - `MM_HERMES_DEVICE_PIN_MISMATCH`

   Existing codes referenced by Phase 3 flow (already present in `src/tools/types/errors.ts`, no changes needed): `MM_HERMES_CONNECTION_FAILED`, `MM_HERMES_TARGET_NOT_FOUND`.

5. `HermesCdpInput.metroPort` — relax from required to optional. **Current state** (verified at `src/tools/types/tool-inputs.ts` line 175): `metroPort: number` (required). **Target state**: `metroPort?: number` plus matching Zod schema change in `src/validation/schemas.ts` (remove default OR drop `.default(8081)` so the resolution chain `input.metroPort ?? platformDriver.getMetroPort() ?? 8081` can fall through to the session-level port. Without this change, the per-call value always wins and Decision 6 (Option β) is silently neutered).

   Backward compatibility: callers that previously passed `metroPort` explicitly continue to work unchanged; callers that omit it now fall through to the session port or `8081` instead of failing Zod validation.

**Gate:** `yarn build && yarn lint` clean.

### Phase 2 — `IOSPlatformDriver` Internals

**File:** `src/platform/ios/ios-driver.ts`

1. Constructor option `metroPort?: number`.
2. New fields: `readonly #metroPort: number | undefined`, `#pinnedHermesDeviceId: string | undefined`.
3. Public methods: `getAppId()`, `getMetroPort()`, `getPinnedHermesDeviceId()`, `setPinnedHermesDeviceId(id)`.

**Tests** (`src/platform/ios/ios-driver.test.ts`):

- `getAppId()` returns configured bundle ID
- `getMetroPort()` returns configured port; `undefined` when omitted
- Pin get/set round-trips; starts `undefined`
- Fresh driver instance has clean pin (session-scoped lifetime)

**Gate:** Driver tests green.

### Phase 3 — `hermes-cdp.ts` Rewrite

**File:** `src/tools/hermes-cdp.ts` (substantive rewrite, public signature unchanged)

**New flow:**

```
1. Platform guard: platformDriver.getPlatform() === 'ios'
2. Method block guard: HERMES_BLOCKED_METHODS
3. Resolve config:
   - expectedAppId = platformDriver.getAppId()
       → if undefined: MM_HERMES_TARGET_NOT_VERIFIED ("no expected app identity")
   - metroPort = input.metroPort ?? platformDriver.getMetroPort() ?? 8081
       NOTE: `input.metroPort` is the per-call `HermesCdpInput.metroPort`
       (from `mm hermes-cdp --metro-port` or the tool body). It is NOT
       `SessionLaunchInput.metroPort`. The session-scoped port arrives
       via `platformDriver.getMetroPort()` after the consumer wires
       Phase 1 change 2 into `new IOSPlatformDriver({ metroPort })`.
   - pinnedDeviceId = platformDriver.getPinnedHermesDeviceId()
4. Discover candidates from Metro (/json, fallback /json/list):
   - Filter: webSocketDebuggerUrl present
   - Filter: title !== 'React Native Experimental (Improved Chrome Reloads)'
   - Filter: appId === expectedAppId (STRICT)
   - If pinnedDeviceId: filter reactNative.logicalDeviceId === pinnedDeviceId
   - No candidates: MM_HERMES_TARGET_NOT_FOUND (diagnostic lists seen appIds)
   - Prefer reactNative.capabilities.nativePageReloads === true
   - Tie-break: last in array (most recent — RN convention)
   - Post-tiebreak invariant: exactly one target. If filtering+tiebreak still
     yields >1 candidate (e.g., two pages with identical logicalDeviceId
     AND nativePageReloads=true), fail closed with
     MM_HERMES_TARGET_NOT_VERIFIED ("ambiguous target after pin+capability
     filtering"). Diagnostic must list the conflicting page ids.
5. Validate webSocketDebuggerUrl:
   - Parse with `new URL(...)` inside try/catch. On throw: MM_HERMES_UNSAFE_TARGET.
   - protocol === 'ws:'
   - hostname ∈ {localhost, 127.0.0.1, ::1, [::1]}
   - port === metroPort
   - Else MM_HERMES_UNSAFE_TARGET
6. Open WebSocket. CDP id strategy: **per-WebSocket monotonic counter** starting
   at 1, incremented for each outgoing CDP message on this connection (probe
   gets id=1; user method gets id=2). Because each `hermes_cdp` call opens
   its own WebSocket and closes it before returning, IDs only need to be unique
   within that connection. This eliminates the current `Date.now()` collision
   risk without requiring a global counter.
7. Identity probe: Runtime.evaluate(IDENTITY_PROBE_EXPR), await response.
   - Apply the same `timeoutMs` budget that bounds the user method
     (use Promise.race against a timer, NOT an unbounded await).
   - On socket close before response: MM_HERMES_CONNECTION_FAILED.
   - On CDP-level error (response.error set, or response.result.subtype === 'error',
     or missing response.result.result.value): MM_HERMES_TARGET_NOT_VERIFIED.
   - Parse response.result.result.value as JSON inside try/catch.
     On parse failure: MM_HERMES_TARGET_NOT_VERIFIED ("probe returned non-JSON").
   - Require parsed.isHermes === true.
     Else MM_HERMES_TARGET_NOT_VERIFIED.
8. If !pinnedDeviceId: driver.setPinnedHermesDeviceId(target.reactNative.logicalDeviceId)
   If mismatch: MM_HERMES_DEVICE_PIN_MISMATCH (defensive — filter step 4 should prevent)
9. Send user's method; await response.
   - On socket close after probe but before user-method response:
     MM_HERMES_CONNECTION_FAILED (do NOT retry — caller decides).
10. Close WebSocket (in finally so it runs even on error). Return result.
```

**Identity probe expression** (sent as `Runtime.evaluate` params.expression, `returnByValue: true`):

```js
(function () {
  try {
    var hi = typeof HermesInternal !== 'undefined' ? HermesInternal : null;
    var p =
      hi && typeof hi.getRuntimeProperties === 'function'
        ? hi.getRuntimeProperties()
        : null;
    return JSON.stringify({
      isHermes: !!hi,
      ossVersion: p ? p['OSS Release Version'] : null,
      debuggerEnabled: p ? p['Debugger Enabled'] : null,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})();
```

**Removed:**

- Substring match in `discoverHermesTarget`
- `targets[0]` fallback
- `Date.now()` id generation

**Tests** (`src/tools/hermes-cdp.test.ts` — overhaul existing + add new):

| #   | Test                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Strict appId match — multi-target, only `io.metamask.MetaMask` selected                                                                                                                                                                                   |
| T2  | Rejects spoofed title (`title: 'metamask copycat'`, `appId: 'io.evil.app'`)                                                                                                                                                                               |
| T3  | Rejects synthetic legacy page                                                                                                                                                                                                                             |
| T4  | Rejects mismatched device pin → `MM_HERMES_DEVICE_PIN_MISMATCH`                                                                                                                                                                                           |
| T5  | Most-recent tiebreak — last in array selected                                                                                                                                                                                                             |
| T6  | Identity probe happy path                                                                                                                                                                                                                                 |
| T7  | Probe `isHermes: false` → `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                                                                                                                                 |
| T8  | Probe throws → `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                                                                                                                                            |
| T9  | WS URL `wss://evil.com/...` → `MM_HERMES_UNSAFE_TARGET`                                                                                                                                                                                                   |
| T10 | WS URL port mismatch → `MM_HERMES_UNSAFE_TARGET`                                                                                                                                                                                                          |
| T11 | Pin set on first success — `setPinnedHermesDeviceId` called                                                                                                                                                                                               |
| T12 | Pin persists — second call uses pin to filter                                                                                                                                                                                                             |
| T13 | `metroPort` priority — input > session > 8081 (with `metroPort` omitted from `HermesCdpInput`, session port wins; with `metroPort` provided, input wins)                                                                                                  |
| T14 | Per-WebSocket monotonic IDs — probe id=1, user method id=2; second tool call also restarts at id=1                                                                                                                                                        |
| T15 | Empty target list — diagnostic message                                                                                                                                                                                                                    |
| T16 | `getAppId()` returns undefined → `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                                                                                                                          |
| T17 | Bundle ID variants — driver configured with `io.metamask.MetaMask.dev` rejects target advertising `io.metamask.MetaMask`; accepts target advertising `io.metamask.MetaMask.dev`. Repeat for `.qa`.                                                        |
| T18 | Malformed `webSocketDebuggerUrl` — non-URL string causes `new URL(...)` to throw → `MM_HERMES_UNSAFE_TARGET`                                                                                                                                              |
| T19 | Probe returns CDP-level error (`response.error.message` set) → `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                                                                                            |
| T20 | Probe returns `result.subtype === 'error'` (Hermes threw inside the probe expression) → `MM_HERMES_TARGET_NOT_VERIFIED`                                                                                                                                   |
| T21 | Probe returns success but `result.value` is non-JSON (`'undefined'`, `'[object Object]'`, garbled) → `MM_HERMES_TARGET_NOT_VERIFIED` with diagnostic                                                                                                      |
| T22 | Probe times out (Promise.race against `timeoutMs`) → `MM_HERMES_TARGET_NOT_VERIFIED` (NOT indefinite hang)                                                                                                                                                |
| T23 | WebSocket closes after probe success but before user-method response → `MM_HERMES_CONNECTION_FAILED`                                                                                                                                                      |
| T24 | Two candidates remain after appId + pin + capability filtering → `MM_HERMES_TARGET_NOT_VERIFIED` (ambiguous; diagnostic lists conflicting page ids)                                                                                                       |
| T25 | `finally` block closes WebSocket even when user method rejects (no socket leak)                                                                                                                                                                           |
| T26 | Probe response is well-formed but `response.result.result.value` is missing (no `value` field, `value: undefined`, or `value: null`) → `MM_HERMES_TARGET_NOT_VERIFIED` (covers the "missing result value" branch of step 7's CDP-error family in Phase 3) |

**Gate:** All tests green; coverage for `hermes-cdp.ts` ≥ 95% lines, ≥ 90% branches.

### Phase 4 — CLI + Launch Plumbing

**Files:**

- `src/cli/mm.ts`
- `src/validation/schemas.ts`

**Changes:**

1. `parseLaunchArgs` accepts `--metro-port`:

   ```ts
   } else if (arg === '--metro-port') {
     i += 1;
     const port = parseInt(args[i] ?? '', 10);
     if (!Number.isInteger(port) || port < 1 || port > 65535) {
       process.stderr.write('Error: --metro-port requires a valid port (1-65535)\n');
       process.exit(1);
     }
     result.metroPort = port;
   }
   ```

   Add to `knownFlags`.

2. Help text appended to Mobile section:

   ```
   mm launch --platform ios --device <udid> --app-bundle <path> [--metro-port <port>]
   ```

3. `launchInputSchema` extended:
   ```ts
   metroPort: z.number().int().min(1).max(65535).optional()
     .describe('Metro inspector proxy port (iOS Hermes CDP, default 8081)'),
   ```

**Tests** (`src/cli/mm.test.ts`):

- `parseLaunchArgs(['--metro-port', '8082'])` → `{ metroPort: 8082 }`
- Invalid port (0, 65536, `'abc'`, missing) → `process.exit` + stderr
- Launch command routes `metroPort` to daemon body
- Help text includes `--metro-port`

**Gate:** CLI tests green.

### Phase 5 — Documentation + Coverage

**Files:** `README.md`, `vitest.config.mts`

1. README — extend Mobile section (located in the CLI Reference area, BELOW the existing "iOS Prerequisites" section added by the parallel-session distribution work). Do not duplicate Xcode/Swift prerequisites or env vars like `METAMASK_AXSNAPSHOT_BINARY`, `IOS_RUNNER_DERIVED_DATA_PATH` — link/cross-reference the existing iOS Prerequisites section where relevant. New content for this plan:
   - Per-worktree pattern: `RCT_METRO_PORT=<port>` + `mm launch --metro-port <port>`.
   - Note Hermes CDP refuses targets whose `appId` ≠ session's bound bundle ID; verified by `HermesInternal` probe every call.
   - Document that consumers must pass `appBundleId` to `IOSPlatformDriver` for dev/QA builds (default is the prod bundle ID `'io.metamask.MetaMask'`).
   - Single-Metro-multi-simulator unsupported and why.

2. Coverage — handle in two parts:

   **a. Baseline status (record before Phase 1):** Run `CI=true yarn test --coverage` once on the current `cryptotavares/mobile-support` branch tip BEFORE starting Phase 1. The local `autoUpdate: !process.env.CI` flag in `vitest.config.mts` is currently masking thresholds (recent local: ~86% lines, ~80% branches; recent CI baseline: ~95% lines, ~89% branches). Capture the actual `CI=true` numbers in the implementation PR description so the gate is verifiable.

   **b. Restoration scope (this plan):** The new tests for `hermes-cdp.ts` (T1–T25), `ios-driver.ts` (Phase 2 tests), and `mm.ts` (Phase 4 tests) MUST get the touched files to ≥ 95% lines / ≥ 90% branches. Full restoration of unrelated files (`ax-snapshot.ts`, `runner-build.ts`, etc.) remains out of scope.

   **c. Gate adjustment if baseline already failing:** If the captured `CI=true` baseline (step a) is below the thresholds committed in `vitest.config.mts`, EITHER (i) lower the global thresholds in `vitest.config.mts` to match the post-this-plan numbers and note "restoration tracked in follow-up", OR (ii) raise enough coverage in unrelated files to clear the existing threshold. Choose (i) by default; choose (ii) only if `CI=true yarn test --coverage` after Phase 4 still fails by a small margin.

**Gate:** README renders; `CI=true yarn test --coverage` passes against whichever threshold was committed per (2c).

## Blockers / Tradeoffs

### Cross-Repo Contract

`@metamask/client-mcp-core` defines the interfaces. The consumer (MetaMask Mobile repo, separate codebase) implements `ISessionManager.launch()` and is responsible for:

- Receiving `input.metroPort` from `SessionLaunchInput` and passing it to `new IOSPlatformDriver({ metroPort })`.
- **Passing the actual installed bundle ID** as `appBundleId` to the `IOSPlatformDriver` constructor — including dev (`io.metamask.MetaMask.dev`), QA (`io.metamask.MetaMask.qa`), or any other variant the consumer ships. The driver currently defaults to `'io.metamask.MetaMask'` if `appBundleId` is omitted (`src/platform/ios/ios-driver.ts` line 38, `DEFAULT_APP_BUNDLE_ID`); for any non-prod build this default is wrong and will cause `MM_HERMES_TARGET_NOT_FOUND` because the strict `appId === expectedAppId` filter in Phase 3 will reject the real target.

**This plan does not modify the consumer.** A follow-up task in the MetaMask Mobile repo is needed to fully exercise Option β end-to-end. JSDoc on `SessionLaunchInput.metroPort` AND a new JSDoc note on `IOSPlatformDriver.appBundleId` constructor option will document the contract.

**Tracked follow-up:** MetaMask Mobile repo task TBD — file once this plan lands. The follow-up scope is:

1. Read `input.metroPort` from `SessionLaunchInput` and pass to `new IOSPlatformDriver({ metroPort })`.
2. Resolve the correct `appBundleId` per launched build (dev/QA/prod) and pass it to the same constructor.
3. Smoke-test `mm launch --metro-port <port>` + `mm hermes-cdp Runtime.evaluate ...` against a dev build.

**Graceful path if consumer is slow to land the follow-up:** `mm hermes-cdp --metro-port <port>` (per-call) already works without consumer changes because `HermesCdpInput.metroPort` (per-call) takes priority over the session port in the resolution chain. The only thing that breaks until the consumer lands the follow-up is `mm launch --metro-port` (CLI flag is parsed and sent to the daemon, but the consumer's `launch()` impl ignores it). This is degraded DX, not a correctness regression.

### Probe Latency

~50 ms per `hermes_cdp` call is an estimate (one round-trip Metro discovery + one round-trip identity probe + one round-trip user method = 3 RTTs vs. 2 today). Real numbers must be measured during Phase 5 manual smoke — see "RN / Hermes Compatibility & Latency Budget" above for the explicit p50 ≤ 80 ms / p95 ≤ 250 ms acceptance budget.

Could be amortized with probe caching, but caching introduces TOCTOU risk if app reloads mid-session. Out of scope for this plan; revisit if measured p95 exceeds budget OR if `run_steps` batching shows latency hot spots.

### Driver Optional Methods

`IPlatformDriver.getAppId?()` is optional. If a consumer's iOS driver doesn't implement it, `hermes-cdp.ts` fails closed (`MM_HERMES_TARGET_NOT_VERIFIED`). This is by design but worth documenting.

## What It Would Take

Phase order is strict — each depends on the previous:

```
Phase 1 (types) ─→ Phase 2 (driver) ─→ Phase 3 (tool) ─→ Phase 4 (CLI) ─→ Phase 5 (docs)
   build/lint        unit tests          unit tests        unit tests       coverage
```

**Final acceptance gate:**

- `yarn build && yarn lint` clean.
- `CI=true yarn test --coverage` passes against the threshold committed in Phase 5 step 2c (NOT the local auto-updated value).
- `bash scripts/verify-pack-contents.sh` passes (added by the parallel-session distribution work; verifies the tarball includes the iOS source paths the lazy-build runtime needs and excludes build artifacts). This plan touches no `ios-runner/` files, so this should remain green — run it once after Phase 5 as a final check before merge.
- Manual smoke (requires real simulator + Metro), positive cases:
  - `mm launch --platform ios --device <udid> --app-bundle <path> --metro-port 8081` succeeds.
  - `mm hermes-cdp Runtime.evaluate '{"expression":"1+1","returnByValue":true}'` returns expected value.
  - Latency measurement: 10 consecutive `mm hermes-cdp Runtime.evaluate '{"expression":"1+1"}'` calls, report min / median / p95. p95 ≤ 250 ms (see Latency Budget section). Attach numbers to the implementation PR description.
  - `HermesInternal.getRuntimeProperties()` OSS Release Version is captured in the smoke notes (compatibility evidence — see Compatibility Posture).
- Manual smoke, negative cases:
  - `--metro-port 9999` (no Metro listening) → clean `MM_HERMES_CONNECTION_FAILED`.
  - Wrong Metro on configured port → clean `MM_HERMES_TARGET_NOT_FOUND` with diagnostic listing the wrong app's `appId`.
  - Spoofed target (e.g., RN sample app with title `'MetaMask copycat'` but `appId: 'io.evil.app'`) → `MM_HERMES_TARGET_NOT_FOUND` (strict appId filter rejects it).

## Decision

Implement all 5 phases as scoped. Decisions 1–6 above are locked. Revisions made in this version address Momus round-1 feedback (bundle-ID variants, RN compat note, latency budget, edge-case tests T17–T25, cross-repo follow-up tracking, coverage gate clarification, `HermesCdpInput.metroPort` optionality).

**Revisit conditions:**

- If Momus round 2 surfaces additional material issues → address before Phase 1.
- If measured probe latency p95 exceeds 250 ms on the consumer's dev hardware → introduce caching (separate ticket; TOCTOU mitigation required).
- If MetaMask Mobile (consumer) declines or delays plumbing `input.metroPort` / `appBundleId` → graceful path documented in Cross-Repo Contract (per-call `--metro-port` works without consumer changes; `mm launch --metro-port` is the only thing degraded).
- If a multi-simulator-shared-Metro use case becomes real → reopen with a different design (likely requires app-side cooperation to expose the IDFV-derived `logicalDeviceId` mapping).
- If a future RN/Hermes version renames `HermesInternal.getRuntimeProperties()` → update the probe expression in `hermes-cdp.ts` (failure mode in the interim is fail-closed, which is acceptable).
