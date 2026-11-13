# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.0]

### Uncategorized

- chore: use fixed coverage floors instead of autoUpdate ([#101](https://github.com/MetaMask/client-mcp-core/pull/101))
- fix: say why a browser click failed instead of only "Click timed out" ([#95](https://github.com/MetaMask/client-mcp-core/pull/95))
- fix: tie describe-screen refs to their DOM node instead of role and name ([#94](https://github.com/MetaMask/client-mcp-core/pull/94))
- fix: log the outcome of each tool call in .mm-daemon.log ([#97](https://github.com/MetaMask/client-mcp-core/pull/97))
- feat: add mm hover/unhover and mm set-viewport/reset-viewport ([#96](https://github.com/MetaMask/client-mcp-core/pull/96))
- fix: resend a CLI request only when the daemon refused the connection ([#79](https://github.com/MetaMask/client-mcp-core/pull/79))
- feat!: structured CLI errors with distinct exit codes ([#78](https://github.com/MetaMask/client-mcp-core/pull/78))
- feat: MM_TARGET_OBSCURED, click --dismiss-keyboard and screenChanged ([#77](https://github.com/MetaMask/client-mcp-core/pull/77))
- fix!: scroll_to_element reports swipes and fails unless in the viewport ([#76](https://github.com/MetaMask/client-mcp-core/pull/76))
- perf: one device snapshot per mobile tap; parallel describe_screen reads ([#74](https://github.com/MetaMask/client-mcp-core/pull/74))
- perf: start the CLI faster; load device-mcp on first mobile use ([#73](https://github.com/MetaMask/client-mcp-core/pull/73))
- feat: support mm scroll-to-element on the browser ([#87](https://github.com/MetaMask/client-mcp-core/pull/87))
- feat: report animationsSettled in observations and document mm wait-for instead of sleep ([#86](https://github.com/MetaMask/client-mcp-core/pull/86))
- feat: add mm reload ([#85](https://github.com/MetaMask/client-mcp-core/pull/85))
- feat: add mm inspect ([#84](https://github.com/MetaMask/client-mcp-core/pull/84))
- feat: let hosts set the artifacts directory via MM_ARTIFACTS_DIR ([#83](https://github.com/MetaMask/client-mcp-core/pull/83))

### Added

- feat: `scroll_to_element` (`mm scroll-to-element`) now works on the browser: it waits for the target and scrolls it into view with `locator.scrollIntoViewIfNeeded()`, with `timeoutMs` and `within` support
- feat: report `animationsSettled` in browser observations after a call that waits for animations, and document `mm wait-for` (including `--selector "text=..."`) as the replacement for `sleep`
- feat: add `mm reload` to reload the active page so the Extension fetches cached data again after a network mock changes
- feat: add `mm inspect` (attributes, disabled/read-only flags, computed styles, effective opacity); `mm type` fails fast on read-only or disabled fields
- feat: add `mm hover <target>` (Playwright `locator.hover()`, with refs, test IDs, selectors and `--within`) and `mm unhover`, which moves the pointer off the page; add `mm set-viewport <width> <height>` and `mm reset-viewport`, so agents no longer drive the pointer and the viewport with `mm cdp`. `ErrorCodes` adds `MM_HOVER_FAILED` and `MM_VIEWPORT_FAILED`
- feat: add `MM_ARTIFACTS_DIR` environment variable to let the host override the directory screenshots and other session artifacts are written to. On launch, core resolves it (falling back to the workflow context's `config.artifactsDir`) and passes it to `ISessionManager.launch()` as `artifactsDir` for session managers to forward to their launcher.

### Changed

- chore: bump @metamask/device-mcp to ^0.8.0 ([#100](https://github.com/MetaMask/client-mcp-core/pull/100)): taps are hit-tested and refuse a covered target (including the target's own container), `scrollToElement` succeeds only when the element is in the viewport, one snapshot per tap, iOS key/back/clear fixes, and an exact element match first with the elements axbridge drops on iOS 18+
- **BREAKING:** `mm` failures are structured. A failed command prints one JSON line on stdout, `{"ok":false,"error":{"code","message","hint"?,"retryable"},"meta"?}`, instead of `Error: <message>` on stderr, and exits with a code per error class: 2 usage/validation, 3 no session or daemon down/lost, 4 target not found or not actionable, 5 timeout, 6 platform/device unavailable, 1 anything else (7 is reserved for a version mismatch). The daemon's `error.code` now reaches the caller. `exitCodeForError`, `isRetryableError`, `defaultHintForError`, `CliExitCodes` and `DaemonErrorCodes` are exported, and `ErrorCodes` adds `MM_BATCH_TIMEOUT`, the `MM_CLIPBOARD_*` codes and the CLI codes `MM_DAEMON_NOT_RUNNING`, `MM_DAEMON_START_FAILED`, `MM_DAEMON_ALREADY_RUNNING`, `MM_DAEMON_CONNECTION_LOST` and `MM_REQUEST_TIMEOUT`. Click and type timeouts say "state unknown". `launch` keeps any `MM_*` code thrown by a consumer, not only known codes.
- Mobile `click` never reports a tap that hit something else: device-mcp refuses a tap when another element covers the target, and the click fails with the new `MM_TARGET_OBSCURED` (`MM_TARGET_NOT_VISIBLE` when the target is off screen). `click --dismiss-keyboard` closes a covering keyboard and taps once more (`keyboardDismissed: true`). With an observation, a mobile click result has `screenChanged`. The hit-test is provided by `@metamask/device-mcp` ^0.8.0.
- Start the CLI faster: find the project root without running `git` and do not load zod. Load `@metamask/device-mcp` only when a mobile session uses it, so browser daemons start without it.
- **BREAKING:** `scroll_to_element` `direction` is now the content direction (`down` reveals content below; it was the finger direction) and defaults to `auto`. The result adds `swipes`, `inViewport` and `bounds`; a target that is found but not brought into view fails with the new `MM_TARGET_NOT_VISIBLE`, and one never found with `MM_TARGET_NOT_FOUND`. The viewport check is provided by `@metamask/device-mcp` ^0.8.0.
- Mobile `click` and `type` tap the element that the target wait found, so a tap takes one device snapshot instead of two (`tapElement(query, { element })` in `@metamask/device-mcp` ^0.8.0). `describe_screen` reads the app state and the screen at the same time on mobile.

### Fixed

- Browser `click` says why it failed. Without an explicit `timeoutMs` (`--timeout`), a target that matches no element after 2s fails at once with `MM_TARGET_NOT_FOUND` (`Selector <selector> matched 0 elements after 2000ms`) instead of waiting for the whole 15s; with one, the click still waits that long for the target to appear. A `MM_CLICK_TIMEOUT` message ends with the last step of Playwright's call log, for example `locator resolved to hidden <input .../>` or `<div class="modal"> intercepts pointer events`, instead of only "Click timed out".
- The `.mm-daemon.log` request line has the outcome of the call, for example `POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT 15080ms`. Before, a failed tool call was logged like a success (`POST /tool/click 200 15080ms`), because the daemon answers 200 and puts the failure in the body. A `run_steps` line with failed steps adds `failed=<n>/<total>` and the first failed step's code
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

[Unreleased]: https://github.com/MetaMask/client-mcp-core/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.13.1...v0.14.0
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
