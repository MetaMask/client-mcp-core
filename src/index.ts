// Capabilities
export type * from './capabilities/types.js';
export * from './capabilities/context.js';

// Platform
export type {
  PlatformType,
  IPlatformDriver,
  ClickActionResult,
  TypeActionResult,
  GetTextActionResult,
  PlatformScreenshotOptions,
} from './platform/index.js';
export { PlaywrightPlatformDriver } from './platform/index.js';

// Session Manager Interface (transport-agnostic)
export type {
  ISessionManager,
  TrackedPage,
  SessionLaunchInput,
  SessionLaunchResult,
  SessionScreenshotOptions,
} from './server/session-manager.js';

// Core Components
export * from './knowledge-store/knowledge-store.js';
export * from './tools/utils/discovery.js';
export * from './validation/schemas.js';
export * from './knowledge-store/tokenization.js';

// Types
export * from './tools/types';

// HTTP Server Types
export type * from './types/http.js';
export type { MmClientCliConfig } from './cli/mm.js';
export * from './tools/registry.js';

// Server utilities
export * from './server/request-queue.js';
export * from './server/port-allocator.js';
export * from './server/daemon-state.js';
export * from './server/create-server.js';

// Utils
export * from './utils';

// Launcher utilities
export * from './launcher/extension-id-resolver.js';
export * from './launcher/extension-readiness.js';
export * from './launcher/console-error-buffer.js';
export * from './launcher/retry.js';

// Error classification
export * from './tools/error-classification.js';
