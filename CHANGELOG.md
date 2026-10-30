# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add optional platform-driver disposal and forward mobile disposal to lifecycle-capable device-mcp backends.

### Changed

- Start the CLI faster: find the project root without running `git` and do not load zod. Load `@metamask/device-mcp` only when a mobile session uses it, so browser daemons start without it.
- **BREAKING:** `scroll_to_element` `direction` is now the content direction (`down` reveals content below; it was the finger direction) and defaults to `auto`. The result adds `swipes`, `inViewport` and `bounds`; a target that is found but not brought into view fails with the new `MM_TARGET_NOT_VISIBLE`, and one never found with `MM_TARGET_NOT_FOUND`. The viewport check needs a device-mcp release with MetaMask/device-mcp#50; with device-mcp 0.7.0 only `bounds` is returned.
- Mobile `click` and `type` tap the element that the target wait found, so a tap takes one device snapshot instead of two (needs a device-mcp release with `tapElement(query, { element })`; older releases ignore the option). `describe_screen` reads the app state and the screen at the same time on mobile.

### Fixed

- Dispose session-owned drivers after consumer cleanup, including cleanup errors, forced relaunch, failed launch, daemon shutdown, and server startup rollback. Retain failed disposals in one server-owned lifecycle, so the next cleanup or daemon stop retries them.

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

[Unreleased]: https://github.com/MetaMask/client-mcp-core/compare/v0.12.0...HEAD
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
