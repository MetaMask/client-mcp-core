/**
 * HTTP Server Type Definitions
 *
 * Types for standalone tool functions and HTTP response shapes.
 */

import type { Page } from '@playwright/test';

import type { WorkflowContext } from '../capabilities/context.js';
import type { KnowledgeStore } from '../knowledge-store/knowledge-store.js';
import type { ISessionManager } from '../server/session-manager.js';

/**
 * Context passed to standalone tool functions.
 *
 * This context provides access to the session manager, current page,
 * accessibility reference map, workflow capabilities, and knowledge store.
 */
export type ToolContext = {
  /** Session manager for browser session control */
  sessionManager: ISessionManager;
  /** Current active Playwright page (lazy — throws if no session) */
  get page(): Page;
  /** Accessibility reference map (lazy — returns empty map if no session) */
  get refMap(): Map<string, string>;
  /** Workflow context with capabilities and environment config */
  workflowContext: WorkflowContext;
  /** Knowledge store for session history and prior knowledge */
  knowledgeStore: KnowledgeStore;
  /** Tool registry for batch execution (run_steps) */
  toolRegistry: Map<string, ToolFunction<unknown, unknown>>;
};

/**
 * Result shape for tool responses.
 *
 * @template T The type of the successful result
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type ToolResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Standalone tool function signature.
 *
 * Tool functions receive parameters and a context, and return a ToolResponse.
 *
 * @template TParams The type of parameters the tool accepts
 * @template TResult The type of the successful result
 */
export type ToolFunction<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: ToolContext,
) => Promise<ToolResponse<TResult>>;

/**
 * Port configuration passed to contextFactory at runtime.
 *
 * These ports are used to configure test infrastructure (Anvil, fixture server, mock server).
 */
export type ContextFactoryOptions = {
  /** Port configuration for test services */
  ports: {
    /** Anvil local chain port */
    anvil: number;
    /** Fixture server port */
    fixture: number;
    /** Mock server port */
    mock: number;
  };
};

/**
 * Configuration for createServer().
 *
 * This configuration is used to initialize the HTTP server with
 * session management, context factory, and optional settings.
 */
export type ServerConfig = {
  /** Session manager instance */
  sessionManager: ISessionManager;
  /** Factory function to create workflow context */
  contextFactory: (options: ContextFactoryOptions) => WorkflowContext;
  /** Idle timeout for daemon auto-shutdown in milliseconds (default: 1_800_000 = 30 min) */
  idleShutdownMs?: number;
  /** Per-request execution timeout in milliseconds (default: 30_000) */
  requestTimeoutMs?: number;
  /** Path to log file (optional) */
  logFilePath?: string;
};

/**
 * Shape of the .mm-server daemon state file.
 *
 * This file is created when the daemon starts and contains
 * the port, PID, and port configuration for the running server.
 */
export type DaemonState = {
  /** HTTP server port */
  port: number;
  /** Process ID of the daemon */
  pid: number;
  /** ISO 8601 timestamp when daemon started */
  startedAt: string;
  /** Nonce for daemon identification */
  nonce: string;
  /** Package version of the daemon process (absent in state files written before version tracking) */
  version?: string;
  /** Port configuration for test services */
  subPorts: {
    /** Anvil local chain port */
    anvil: number;
    /** Fixture server port */
    fixture: number;
    /** Mock server port */
    mock: number;
  };
};
