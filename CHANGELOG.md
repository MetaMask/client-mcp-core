# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- fix: report mobile element geometry and viewport visibility instead of assuming every element is visible

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

[Unreleased]: https://github.com/MetaMask/client-mcp-core/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MetaMask/client-mcp-core/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MetaMask/client-mcp-core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MetaMask/client-mcp-core/releases/tag/v0.1.0
