# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- feat: `MobilePlatformDriver` options `metroPort`, `deviceId` and `appId` keep the session's Metro port, device and Hermes app id on the driver, and `IPlatformDriver.setHermesDefaults` lets the launch apply `--metro-port` / `--device-id` after a successful mobile launch; `mm hermes-targets` now reports `sessionMetroPort`, `pinnedDeviceId`, `connected` and `deviceId`.
- feat: `mm cdp --target sw` sends CDP commands to the browser Extension's background service worker, and browser CDP sessions are now persistent per target (active page, service worker) instead of one-shot, so enabled domains and listeners survive across calls; a dead session (page or service-worker restart) is re-attached on the next call. New `mm cdp --fresh` keeps the old one-shot session, detached after the command. Browser and mobile reject the other platform's `--target` values with `MM_INVALID_INPUT`.
- feat: an observation that exceeds `OBSERVATION_TIMEOUT_MS` (8 s) no longer costs the call. The action response stays `ok` and carries `observations: { timedOut: true }` with no tree, and the timed-out observation does not replace the diff baseline, so the agent knows the screen was not read
- feat: add `MM_QUEUE_TIMEOUT`. When the daemon's request queue expires it now returns a normal `{ok:false,error}` tool response (not HTTP 500 `TOOL_EXECUTION_FAILED`), mapped to exit 5, not retryable, with the state-unknown hint; `RequestQueue` rejects a dedicated `QueueTimeoutError`
- feat: `scroll_to_element` (`mm scroll-to-element`) now works on the browser: it waits for the target and scrolls it into view with `locator.scrollIntoViewIfNeeded()`, with `timeoutMs` and `within` support
- feat: report `animationsSettled` in browser observations after a call that waits for animations, and document `mm wait-for` (including `--selector "text=..."`) as the replacement for `sleep`
- feat: add `mm reload` to reload the active page so the Extension fetches cached data again after a network mock changes
- feat: add `mm inspect` (attributes, disabled/read-only flags, computed styles, effective opacity); `mm type` fails fast on read-only or disabled fields
- feat: add `MM_ARTIFACTS_DIR` environment variable to let the host override the directory screenshots and other session artifacts are written to. On launch, core resolves it (falling back to the workflow context's `config.artifactsDir`) and passes it to `ISessionManager.launch()` as `artifactsDir` for session managers to forward to their launcher.

### Changed

- Mobile `mm cdp` keeps one persistent Hermes connection per session (Metro port and app id) and reuses it across calls instead of opening one WebSocket per call; a per-call `--metro-port` / `--app-id` that differs from the session's uses a one-shot connection, and the device pin still persists per session. Needs a device-mcp release with `HermesClient`; with device-mcp 0.7.0 each call opens its own connection.
- One timeout budget end to end. A shared `resolveActionTimeoutMs()`, `resolveBatchActionTimeoutMs()` and `computeTimeoutBudget()` give every layer a nesting budget (`http > queue > action + observation`): the CLI derives its HTTP abort from the same action budget as the daemon queue, and from the daemon queue default for tools with no action budget. The daemon publishes that default in `.mm-server` (`requestTimeoutMs`, absent in older state files) and the CLI nests above it, so it no longer aborts before the daemon answers. `run_steps` also budgets for its slowest step, because it checks its deadline only between steps. Timeout defaults after this change (daemon queue default 30 s, or 180 s when the host sets `requestTimeoutMs` as the Mobile workflow does); none is shorter than the time the daemon may take:
  - `click`, `type`, `get_text`, `inspect`, `wait_for`: the daemon queue already derived from the zod default (25 s) before this change; the CLI abort goes from the flat 30 s to 32 s.
  - `cdp`: CLI 35 s → 47 s (queue 40 s, unchanged). `wait_for_notification`: CLI 30 s → 32 s (queue 25 s, unchanged).
  - `run_steps` with `batchTimeoutMs`: the daemon queue is the batch deadline plus the slowest step's own timeout plus the observation, and never less than its queue default; the CLI adds the settle wait and a margin. Before, both used 30 s (180 s on Mobile), so a step slower than the batch deadline hit `MM_QUEUE_TIMEOUT` and the partial results were lost.
  - `run_steps` without `batchTimeoutMs`: CLI 30 s → 37 s (187 s with a 180 s daemon queue); the queue is unchanged. `run_steps` now ignores a top-level `timeoutMs`, which the daemon schema strips anyway.
  - `navigate`, `describe_screen`, `screenshot` and the other tools without an action budget: CLI 30 s → 37 s (187 s on Mobile), so the abort nests above the queue default plus its settle wait. `launch` is `max(120 s, 37 s)` = 120 s (187 s on Mobile); `cleanup` 30 s → 37 s (187 s on Mobile).
  - Browser `scroll_to_element`: daemon queue 30 s → 25 s (action 15 s + observation 8 s + 2 s margin), so it still covers the action and its observation; the CLI is 37 s (32 s before) and takes the larger value because mobile keeps the queue default.
  - An explicit `--timeout` on an interaction command keeps the same derived abort as before (19 s for `--timeout 2000`). For `cdp` and `wait-for-notification` the CLI abort now derives from the action budget too: `cdp --timeout 1000` 35 s → 18 s, `wait-for-notification --timeout 1000` 30 s → 18 s; both still nest above the daemon queue.
- **BREAKING:** `mm` failures are structured. A failed command prints one JSON line on stdout, `{"ok":false,"error":{"code","message","hint"?,"retryable"},"meta"?}`, instead of `Error: <message>` on stderr, and exits with a code per error class: 2 usage/validation, 3 no session or daemon down/lost, 4 target not found or not actionable, 5 timeout, 6 platform/device unavailable, 1 anything else (7 is reserved for a version mismatch). The daemon's `error.code` now reaches the caller. `exitCodeForError`, `isRetryableError`, `defaultHintForError`, `CliExitCodes` and `DaemonErrorCodes` are exported, and `ErrorCodes` adds `MM_BATCH_TIMEOUT`, the `MM_CLIPBOARD_*` codes and the CLI codes `MM_DAEMON_NOT_RUNNING`, `MM_DAEMON_START_FAILED`, `MM_DAEMON_ALREADY_RUNNING`, `MM_DAEMON_CONNECTION_LOST` and `MM_REQUEST_TIMEOUT`. Click and type timeouts say "state unknown". `launch` keeps any `MM_*` code thrown by a consumer, not only known codes.
- Mobile `click` never reports a tap that hit something else: device-mcp refuses a tap when another element covers the target, and the click fails with the new `MM_TARGET_OBSCURED` (`MM_TARGET_NOT_VISIBLE` when the target is off screen). `click --dismiss-keyboard` closes a covering keyboard and taps once more (`keyboardDismissed: true`). With an observation, a mobile click result has `screenChanged`. The hit-test needs a device-mcp release with MetaMask/device-mcp#51.
- Start the CLI faster: find the project root without running `git` and do not load zod. Load `@metamask/device-mcp` only when a mobile session uses it, so browser daemons start without it.
- **BREAKING:** `scroll_to_element` `direction` is now the content direction (`down` reveals content below; it was the finger direction) and defaults to `auto`. The result adds `swipes`, `inViewport` and `bounds`; a target that is found but not brought into view fails with the new `MM_TARGET_NOT_VISIBLE`, and one never found with `MM_TARGET_NOT_FOUND`. The viewport check needs a device-mcp release with MetaMask/device-mcp#50; with device-mcp 0.7.0 only `bounds` is returned.
- Mobile `click` and `type` tap the element that the target wait found, so a tap takes one device snapshot instead of two (needs a device-mcp release with `tapElement(query, { element })`; older releases ignore the option). `describe_screen` reads the app state and the screen at the same time on mobile.

### Fixed

- Mobile `mm cdp` and `mm hermes-targets` keep the `--metro-port` given at launch. Before, a later command without `--metro-port` fell back to `HERMES_METRO_PORT` or 8081, so it could not connect when Metro ran on another port. A per-call `--metro-port` still wins, and a CDP connection failure now names the Metro port it tried.
- Mobile observations retry a screen that is still tearing down after a navigating tap (Android: the old screen, half removed, still carried the previous screen's test IDs). One extra snapshot is allowed when the new tree lost a large part of its nodes but kept the last screen's test IDs; a tap that does not change the screen still costs the same single retry, and the diff stays empty.
- `mm` resends a request only when the daemon refused the connection (`ECONNREFUSED`, read from Node's `error.cause.code`). It no longer resends after a reset, broken pipe or socket error, which can come after the daemon got the request (a resent `click` could tap twice); those fail at once with `MM_DAEMON_CONNECTION_LOST` (exit 3). Before, every network failure matched `fetch failed` and was resent up to 3 times.

## [0.13.1]

### Fixed

- ci: pin Node.js to 24.22.1 in .nvmrc ([#81](https://github.com/MetaMask/client-mcp-core/pull/81))

## [0.13.0]

### Added

- chore: bump @metamask/device-mcp to ^0.7.0 ([#72](https://github.com/MetaMask/client-mcp-core/pull/72))
- feat: dispose session-owned platform drivers on teardown ([#70](https://github.com/MetaMask/client-mcp-core/pull/70))
- chore: bump @metamask/device-mcp to ^0.6.0 ([#69](https://github.com/MetaMask/client-mcp-core/pull/69))
- feat: print one-line JSON by default; add --pretty ([#68](https://github.com/MetaMask/client-mcp-core/pull/68))
- feat: flat mobile a11y tree without layout-only nodes ([#44](https://github.com/MetaMask/client-mcp-core/pull/44))
- feat: filter mobile status/nav bars and dev overlay; viewport from snapshot ([#67](https://github.com/MetaMask/client-mcp-core/pull/67))
- perf: settle only on visible finite animations; collect testIds in one call ([#65](https://github.com/MetaMask/client-mcp-core/pull/65))
- feat: cancel timed-out tasks; late ref writes cannot overwrite newer refs ([#64](https://github.com/MetaMask/client-mcp-core/pull/64))
- feat: per-call observe level; no state in observations ([#62](https://github.com/MetaMask/client-mcp-core/pull/62))
- feat: collect observations only for mutating and batch tools ([#61](https://github.com/MetaMask/client-mcp-core/pull/61))
- feat: remove the knowledge store ([#60](https://github.com/MetaMask/client-mcp-core/pull/60))
- feat: drop priorKnowledge from describe_screen ([#59](https://github.com/MetaMask/client-mcp-core/pull/59))
- feat: add meta.timing to every daemon response ([#57](https://github.com/MetaMask/client-mcp-core/pull/57))

### Fixed

- fix: review follow-ups: off-screen animations, no late clicks, batchTimeoutMs cap ([#71](https://github.com/MetaMask/client-mcp-core/pull/71))
- fix: make each Extension ref resolve to exactly one element ([#66](https://github.com/MetaMask/client-mcp-core/pull/66))

## [0.12.0]

### Added

- feat: accept a vault password for self-onboarding ([#55](https://github.com/MetaMask/client-mcp-core/pull/55))

### Fixed

- fix: redact clipboard and CDP secrets in recorded steps (AIENG-228) ([#52](https://github.com/MetaMask/client-mcp-core/pull/52))
- fix: flaky test due to clock assertion ([#53](https://github.com/MetaMask/client-mcp-core/pull/53))

## [0.11.0]

### Added

- feat: add support for self onboarding ([#51](https://github.com/MetaMask/client-mcp-core/pull/51))

## [0.10.0]

### Fixed

- fix(cli): support Windows project daemon launches ([#48](https://github.com/MetaMask/client-mcp-core/pull/48))
- Support only runtime: 'tsx' and runtime: 'node'; reject unsupported runtime configuration with a clear error ([#48](https://github.com/MetaMask/client-mcp-core/pull/48))

## [0.9.0]

### Added

- chore: add android cdp ([#46](https://github.com/MetaMask/client-mcp-core/pull/46))

### Fixed

- fix: report mobile element geometry and viewport visibility ([#45](https://github.com/MetaMask/client-mcp-core/pull/45))

## [0.8.0]

### Added

- feat: forward mobile launch options and preserve consumer error codes ([#42](https://github.com/MetaMask/client-mcp-core/pull/42))
- Mobile launch options on `launch`: `appBundlePath`, `metroPort`, `reinstall`, `resetAppData`, and `allowFoxCodeMismatch`, exposed as `--app-bundle`, `--metro-port`, `--reinstall`, `--reset-app-data`, and `--allow-fox-code-mismatch`. The core validates and forwards them to the consumer's `ISessionManager.launch()`; consumers own the install/reset behavior.

### Changed

- `launch` now preserves a consumer-thrown error `code` when it is a known `ErrorCode`, instead of collapsing every failure into `MM_LAUNCH_FAILED`. This lets consumers surface precise device and prerequisite failures to agents.
- `launchInputSchema.platform` now defaults to `'browser'` instead of being left `undefined`, so consumers no longer need to infer the default themselves.

## [0.7.0]

### Added

- chore: add mobile-only device tools and cli commands

## [0.6.0]

### Added

- feat: add mobile Hermes CDP support and hermes_targets tool ([#37](https://github.com/MetaMask/client-mcp-core/pull/37))
- chore: add mobile platform driver ([#36](https://github.com/MetaMask/client-mcp-core/pull/36))
- ci: migrate npm publishing to OIDC trusted publishing ([#38](https://github.com/MetaMask/client-mcp-core/pull/38))
- chore: add platform and tool orchestrator ([#31](https://github.com/MetaMask/client-mcp-core/pull/31))
- chore: format readme ([#34](https://github.com/MetaMask/client-mcp-core/pull/34))

## [0.5.0]

### Added

- feat: add mock-network tool for intercepting and stubbing browser requests ([#32](https://github.com/MetaMask/client-mcp-core/pull/32))

## [0.4.0]

### Added

- feat: expose raw CDP command as escape-hatch tool ([#28](https://github.com/MetaMask/client-mcp-core/pull/28))

### Fixed

- feat: deadline-based timeout budgets ([#29](https://github.com/MetaMask/client-mcp-core/pull/29))

## [0.3.0]

### Added

- feat: add `mm stop` command and extract `daemonFetch` transport helper ([#23](https://github.com/MetaMask/client-mcp-core/pull/23))

### Changed

- feat: replace playwright area snapshot with cdp ax tree ([#24](https://github.com/MetaMask/client-mcp-core/pull/24))

## [0.2.0]

### Changed

- feat: move from mcp to cli ([#20](https://github.com/MetaMask/client-mcp-core/pull/20))

## [0.1.1]

### Uncategorized

- chore: extension decoupling ([#11](https://github.com/MetaMask/client-mcp-core/pull/11))

## [0.1.0]

### Added

- feat: initial release

[Unreleased]: https://github.com/MetaMask/client-mcp-core/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/MetaMask/client-mcp-core/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MetaMask/client-mcp-core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MetaMask/client-mcp-core/releases/tag/v0.1.0
