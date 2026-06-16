# Attribution

This iOS automation stack is derived from
[agent-device](https://github.com/callstackincubator/agent-device)
by [Callstack Incubator](https://github.com/callstackincubator).

## License

MIT License - Copyright (c) 2024-2025 Callstack, Inc.

Original upstream sources:

- `AgentDeviceRunner`:
  https://github.com/callstackincubator/agent-device/tree/main/ios-runner/AgentDeviceRunner
- `AXSnapshot`:
  https://github.com/callstackincubator/agent-device/tree/main/ios-runner/AXSnapshot

## Modifications

This repository includes substantial modifications relative to upstream,
to support stable MCP-driven MetaMask Mobile automation.

- Extracted and packaged as a standalone dependency for `@metamask/client-mcp-core`.
- Added Objective-C exception bridge (`ObjCExceptionCatcher`) and Swift integration
  for safer XCTest command execution.
- Extended runner command protocol with MetaMask-specific reliability commands:
  `ping`, `bind`, `tapElement`, and `fill`.
- Added state-aware app switching to avoid unnecessary re-activation and reduce
  app relaunch/flicker behavior.
- Added snapshot hardening and diagnostics logging in runner output to support
  root-cause debugging of XCTest accessibility failures.
- Added AXSnapshot binary integration and upstream-style root selection heuristics
  for discovery fallback when XCUITest snapshots degrade after UI transitions.
- Added Node-side build, packaging, and runtime wiring so AX snapshot fallback is
  available through the iOS platform driver and MCP discovery tools.
