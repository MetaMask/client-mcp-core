import express from 'express';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';

import { writeDaemonState, removeDaemonState } from './daemon-state.js';
import { compactObservation } from './observation-compaction.js';
import { RequestQueue } from './request-queue.js';
import pkg from '../../package.json';
import type { PortMap, WorkflowContext } from '../capabilities/context.js';
import type { ExtensionState } from '../capabilities/types.js';
import {
  KnowledgeStore,
  createDefaultObservation,
} from '../knowledge-store/knowledge-store.js';
import { toolRegistry, getToolCategory } from '../tools/registry.js';
import type { ToolCategory } from '../tools/registry.js';
import type {
  StepRecordObservation,
  StepRecordOutcome,
  StepRecordTool,
} from '../tools/types/step-record.js';
import { OBSERVATION_TESTID_LIMIT } from '../tools/utils/constants.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
} from '../tools/utils/discovery.js';
import type {
  DaemonState,
  ServerConfig,
  ToolContext,
  ToolResponse,
} from '../types/http.js';
import { extractErrorMessage } from '../utils/errors.js';
import type { ToolName } from '../validation/schemas.js';
import { toolSchemas } from '../validation/schemas.js';

/**
 * Extracts target selection fields from a tool's validated input.
 * Interaction tools (click, type, wait_for) include a11yRef, testId, or selector.
 *
 * @param input - The validated tool input.
 * @returns The target info for knowledge recording, or undefined if not applicable.
 */
export function extractTargetFromInput(
  input: unknown,
): StepRecordTool['target'] | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const obj = input as Record<string, unknown>;
  const a11yRef = typeof obj.a11yRef === 'string' ? obj.a11yRef : undefined;
  const testId = typeof obj.testId === 'string' ? obj.testId : undefined;
  const selector = typeof obj.selector === 'string' ? obj.selector : undefined;
  if (!a11yRef && !testId && !selector) {
    return undefined;
  }
  return { a11yRef, testId, selector };
}

/**
 * Extracts screenshot artifact metadata from a successful tool result.
 * Applies to `screenshot` and `describe_screen` tools.
 *
 * @param toolName - The name of the tool that produced the result.
 * @param toolResult - The raw result from the tool execution.
 * @returns Screenshot path and dimensions, or undefined if not applicable.
 */
export function extractScreenshotInfo(
  toolName: string,
  toolResult: unknown,
):
  | { path: string; dimensions?: { width: number; height: number } }
  | undefined {
  if (toolName !== 'screenshot' && toolName !== 'describe_screen') {
    return undefined;
  }
  if (typeof toolResult !== 'object' || toolResult === null) {
    return undefined;
  }
  const result = toolResult as Record<string, unknown>;
  if (
    !result.ok ||
    typeof result.result !== 'object' ||
    result.result === null
  ) {
    return undefined;
  }
  const data = result.result as Record<string, unknown>;

  if (typeof data.path === 'string') {
    return {
      path: data.path,
      ...(typeof data.width === 'number' && typeof data.height === 'number'
        ? { dimensions: { width: data.width, height: data.height } }
        : {}),
    };
  }

  if (typeof data.screenshot === 'object' && data.screenshot !== null) {
    const ss = data.screenshot as Record<string, unknown>;
    if (typeof ss.path === 'string') {
      return {
        path: ss.path,
        ...(typeof ss.width === 'number' && typeof ss.height === 'number'
          ? { dimensions: { width: ss.width, height: ss.height } }
          : {}),
      };
    }
  }

  return undefined;
}

export type ServerInstance = {
  start(): Promise<DaemonState>;
  stop(): Promise<void>;
};

/**
 * Extracts a structured outcome from a raw tool result for knowledge recording.
 *
 * @param toolResult - The raw result returned by a tool function.
 * @returns A normalized outcome with ok status and optional error details.
 */
export function extractToolOutcome(toolResult: unknown): {
  ok: boolean;
  error?: { code: string; message: string };
} {
  if (
    typeof toolResult !== 'object' ||
    toolResult === null ||
    !('ok' in toolResult)
  ) {
    return { ok: true };
  }

  const typed = toolResult as {
    ok: boolean;
    error?: { code: string; message: string };
  };
  if (typed.ok) {
    return { ok: true };
  }

  return typed.error ? { ok: false, error: typed.error } : { ok: false };
}

/**
 * Merges a tool result with observation data into the HTTP response body.
 *
 * @param toolResult - The raw result returned by a tool function.
 * @param observations - Optional observation snapshot to attach.
 * @returns The response body suitable for res.json().
 */
export function buildResponseBody(
  toolResult: unknown,
  observations: StepRecordObservation | undefined,
): unknown {
  if (typeof toolResult !== 'object' || toolResult === null) {
    return toolResult;
  }

  if (!observations) {
    return toolResult;
  }

  return { ...(toolResult as Record<string, unknown>), observations };
}

/**
 * Whether to run Playwright observation collection for this tool invocation.
 *
 * Observations are always collected for the knowledge store, regardless of
 * whether they appear in the HTTP response. The only exception is batch
 * with `'none'` policy, which skips collection entirely for best performance.
 *
 * @param category - The tool category to check.
 * @param validatedInput - The validated input payload (checked for batch policy).
 * @returns True if observations should be collected.
 */
export function shouldCollectObservations(
  category: ToolCategory,
  validatedInput?: Record<string, unknown>,
): boolean {
  if (category === 'batch') {
    const policy =
      (validatedInput as { includeObservations?: string })
        ?.includeObservations ?? 'all';
    return policy !== 'none';
  }
  return true;
}

/**
 * Whether to include observations in the HTTP response.
 *
 * @param category - The tool category.
 * @param toolResult - The result returned by the tool.
 * @param validatedInput - The validated input payload (used for batch policy).
 * @returns True if observations should be included in the response.
 */
export function shouldIncludeObservationsInResponse(
  category: ToolCategory,
  toolResult: ToolResponse,
  validatedInput?: Record<string, unknown>,
): boolean {
  if (category === 'mutating') {
    return true;
  }
  if (category === 'batch') {
    const policy =
      (validatedInput as { includeObservations?: string })
        ?.includeObservations ?? 'all';
    if (policy === 'none') {
      return false;
    }
    if (policy === 'failures') {
      if (!toolResult.ok) {
        return true;
      }
      const result = toolResult.result as Record<string, unknown>;
      const summary = result?.summary as Record<string, unknown> | undefined;
      return summary !== undefined && !summary.ok;
    }
    return true; // 'all'
  }
  return false; // readonly, discovery
}

/**
 * Creates an HTTP daemon server for agent-driven browser testing.
 *
 * @param config - The server configuration options.
 * @returns The server instance with start and stop methods.
 */
export function createServer(config: ServerConfig): ServerInstance {
  const app = express();
  const queue = new RequestQueue(config.requestTimeoutMs);
  const nonce = randomUUID();
  const knowledgeStore = config.knowledgeStore ?? new KnowledgeStore();

  let httpServer: http.Server | null = null;
  let worktreeRoot = '';
  let startedAt = '';
  let daemonPort = 0;
  let workflowContext: WorkflowContext | null = null;
  let subPorts: PortMap = {};
  let shuttingDown = false;
  let shutdownHandler: (() => void) | null = null;
  let lastRequestTime = Date.now();
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  let lastObservation: StepRecordObservation | null = null;

  // eslint-disable-next-line import-x/no-named-as-default-member
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    lastRequestTime = Date.now();
    const requestStartedAt = lastRequestTime;
    res.on('finish', () => {
      const duration = Date.now() - requestStartedAt;
      appendLog(
        config.logFilePath,
        `[INFO] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`,
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', nonce });
  });

  app.get('/status', (_req, res) => {
    res.json({
      daemon: {
        pid: process.pid,
        port: daemonPort,
        uptime: process.uptime(),
        startedAt,
      },
      ports: subPorts,
    });
  });

  /**
   * Builds a lazy ToolContext where `page` and `refMap` are only accessed
   * when a tool actually reads them, avoiding throws for non-session tools.
   *
   * @param wfCtx - The current workflow context to embed in the tool context.
   * @returns A ToolContext with lazy page and refMap accessors.
   */
  function buildToolContext(wfCtx: WorkflowContext): ToolContext {
    return {
      sessionManager: config.sessionManager,
      get page(): ReturnType<typeof config.sessionManager.getPage> {
        return config.sessionManager.getPage();
      },
      get refMap(): Map<string, string> {
        return config.sessionManager.hasActiveSession()
          ? config.sessionManager.getRefMap()
          : new Map<string, string>();
      },
      workflowContext: wfCtx,
      knowledgeStore,
      toolRegistry,
    };
  }

  /**
   * Records a tool execution step to the knowledge store.
   * Failures are silently caught — recording must never block tool responses.
   *
   * @param toolName - The registered tool name.
   * @param validatedInput - The validated input payload.
   * @param outcome - The tool execution outcome.
   * @param observation - The post-execution observation snapshot.
   * @param toolResult - The raw tool result (for screenshot extraction).
   * @param startTime - The epoch timestamp when execution started.
   */
  async function recordToolStep(
    toolName: string,
    validatedInput: unknown,
    outcome: StepRecordOutcome,
    observation: StepRecordObservation | undefined,
    toolResult: unknown,
    startTime: number,
  ): Promise<void> {
    try {
      const sessionId = config.sessionManager.getSessionId();
      if (!sessionId) {
        return;
      }

      const target = extractTargetFromInput(validatedInput);
      const screenshotInfo = extractScreenshotInfo(toolName, toolResult);

      let executionContext: 'e2e' | 'prod' | undefined;
      try {
        executionContext = config.sessionManager.getEnvironmentMode();
      } catch {
        // session manager may not support environment mode
      }

      await knowledgeStore.recordStep({
        sessionId,
        toolName,
        input: validatedInput as Record<string, unknown>,
        target,
        outcome,
        observation:
          observation ?? createDefaultObservation({} as ExtensionState),
        durationMs: Date.now() - startTime,
        ...(screenshotInfo ? { screenshotPath: screenshotInfo.path } : {}),
        ...(screenshotInfo?.dimensions
          ? { screenshotDimensions: screenshotInfo.dimensions }
          : {}),
        context: executionContext,
      });
    } catch {
      // non-fatal: recording failure must not block tool responses
    }
  }

  /**
   * Shared tool executor — validates input, runs through the queue,
   * records knowledge steps, and collects observations.
   *
   * @param toolName - The registered tool name to execute.
   * @param rawInput - The unvalidated input payload from the request body.
   * @param res - The Express response object to write the result to.
   */
  async function executeTool(
    toolName: string,
    rawInput: unknown,
    res: express.Response,
  ): Promise<void> {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      res.status(404).json({
        ok: false,
        error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${toolName}` },
      });
      return;
    }

    if (!workflowContext) {
      res.status(503).json({
        ok: false,
        error: {
          code: 'SERVER_NOT_STARTED',
          message: 'Server has not been started yet.',
        },
      });
      return;
    }

    const schema =
      toolName in toolSchemas ? toolSchemas[toolName as ToolName] : undefined;
    let validatedInput = rawInput;

    if (schema) {
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues
              .map((i) =>
                i.path.length > 0
                  ? `${i.path.join('.')}: ${i.message}`
                  : i.message,
              )
              .join('; '),
          },
        });
        return;
      }
      validatedInput = parsed.data;
    }

    const startTime = Date.now();
    const currentWorkflowContext = workflowContext;

    const category = getToolCategory(toolName);

    try {
      const { toolResult, observations } = await queue.enqueue(async () => {
        const context = buildToolContext(currentWorkflowContext);
        const result = await tool(validatedInput, context);

        let obs: StepRecordObservation | undefined;
        if (
          shouldCollectObservations(
            category,
            validatedInput as Record<string, unknown>,
          ) &&
          config.sessionManager.hasActiveSession()
        ) {
          try {
            const page = config.sessionManager.getPage();

            if (category === 'mutating') {
              await page
                .waitForLoadState('domcontentloaded')
                .catch(() => undefined);
              await page
                .waitForFunction(
                  async () =>
                    new Promise<boolean>((resolve) => {
                      requestAnimationFrame(() => {
                        const allSettled = document
                          .getAnimations()
                          .every((a: Animation) => a.playState !== 'running');
                        resolve(allSettled);
                      });
                    }),
                  { timeout: 3000 },
                )
                .catch(() => undefined);
            }
            let state = await config.sessionManager.getExtensionState();

            // Post-mutation recheck: if currentScreen is 'unknown' after a mutation,
            // the extension's internal router may not have updated yet. Poll briefly.
            if (category === 'mutating' && state.currentScreen === 'unknown') {
              const RECHECK_DEADLINE_MS = 500;
              const RECHECK_INTERVAL_MS = 100;
              const deadline = Date.now() + RECHECK_DEADLINE_MS;

              while (Date.now() < deadline) {
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, RECHECK_INTERVAL_MS),
                );
                const rechecked =
                  await config.sessionManager.getExtensionState();
                if (rechecked.currentScreen !== 'unknown') {
                  state = rechecked;
                  break;
                }
              }
            }
            const testIds = await collectTestIds(
              page,
              OBSERVATION_TESTID_LIMIT,
            );
            const { nodes, refMap: newRefMap } =
              await collectTrimmedA11ySnapshot(page);
            config.sessionManager.setRefMap(newRefMap);
            obs = createDefaultObservation(state, testIds, nodes);
          } catch {
            // non-fatal: observation failure must not block the tool response
          }
        }

        return { toolResult: result, observations: obs };
      });

      await recordToolStep(
        toolName,
        validatedInput,
        extractToolOutcome(toolResult),
        observations,
        toolResult,
        startTime,
      );

      const includeInResponse = shouldIncludeObservationsInResponse(
        category,
        toolResult,
        validatedInput as Record<string, unknown>,
      );
      const responseObservations =
        includeInResponse && observations
          ? compactObservation(observations, lastObservation)
          : undefined;
      res.json(buildResponseBody(toolResult, responseObservations));

      if (
        toolName === 'describe_screen' ||
        toolName === 'launch' ||
        toolName === 'cleanup'
      ) {
        lastObservation = null;
      } else if (observations) {
        lastObservation = observations;
      }
    } catch (error) {
      await recordToolStep(
        toolName,
        validatedInput,
        {
          ok: false,
          error: {
            code: 'TOOL_EXECUTION_FAILED',
            message: extractErrorMessage(error),
          },
        },
        undefined,
        undefined,
        startTime,
      );

      res.status(500).json({
        ok: false,
        error: {
          code: 'TOOL_EXECUTION_FAILED',
          message: extractErrorMessage(error),
        },
      });
    }
  }

  app.post('/launch', async (req, res) => {
    await executeTool('launch', req.body, res);
  });

  app.post('/cleanup', async (_req, res) => {
    await executeTool('cleanup', {}, res);
  });

  app.post(
    '/tool/:name',
    async (req: express.Request<{ name: string }>, res) => {
      await executeTool(req.params.name, req.body, res);
    },
  );

  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      appendLog(config.logFilePath, `[ERROR] ${error.message}`);
      res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message,
        },
      });
    },
  );

  const instance: ServerInstance = {
    async start(): Promise<DaemonState> {
      worktreeRoot = execSync('git rev-parse --show-toplevel', {
        cwd: process.cwd(),
      })
        .toString()
        .trim();

      try {
        workflowContext = await config.contextFactory();
      } catch (error) {
        throw new Error(
          `contextFactory failed during server startup: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (
        !workflowContext ||
        typeof workflowContext !== 'object' ||
        !workflowContext.config ||
        typeof workflowContext.config.environment !== 'string'
      ) {
        throw new Error(
          'contextFactory must return an object with a valid config.environment field',
        );
      }

      const rawPorts = workflowContext.allocatedPorts;
      if (rawPorts !== undefined) {
        if (typeof rawPorts !== 'object' || rawPorts === null) {
          throw new Error('allocatedPorts must be a plain object');
        }
        for (const [key, val] of Object.entries(rawPorts)) {
          if (typeof val !== 'number' || !Number.isFinite(val)) {
            throw new Error(
              `allocatedPorts["${key}"] must be a finite number, got ${String(val)}`,
            );
          }
        }
      }

      subPorts = workflowContext.allocatedPorts ?? {};
      config.sessionManager.setWorkflowContext(workflowContext);
      startedAt = new Date().toISOString();

      // Everything after setWorkflowContext may have side-effects the
      // consumer expects to be cleaned up.  Wrap in try/catch so a
      // listen() or writeDaemonState() failure still runs cleanup.
      try {
        // Bind daemon directly to port 0 to eliminate TOCTOU race —
        // the OS assigns the port atomically at listen time.
        httpServer = await new Promise<http.Server>((resolve, reject) => {
          const srv = http.createServer(app);
          srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr !== 'string') {
              daemonPort = addr.port;
            }
            resolve(srv);
          });
          srv.on('error', reject);
        });

        const state: DaemonState = {
          port: daemonPort,
          pid: process.pid,
          startedAt,
          nonce,
          version: pkg.version,
          subPorts,
        };

        await writeDaemonState(worktreeRoot, state);
        appendLog(
          config.logFilePath,
          `[INFO] Daemon started on port ${daemonPort} (pid ${process.pid})`,
        );

        shutdownHandler = (): void => {
          instance
            .stop()
            .then(() => process.exit(0))
            .catch((error: Error) => {
              appendLog(
                config.logFilePath,
                `[ERROR] Daemon failed to shut down: ${error.message}`,
              );
              process.exit(1);
            });
        };

        process.on('SIGTERM', shutdownHandler);
        process.on('SIGINT', shutdownHandler);

        const { idleShutdownMs } = config;
        if (idleShutdownMs && idleShutdownMs > 0) {
          const checkMs = Math.min(idleShutdownMs / 10, 60_000);
          idleCheckInterval = setInterval(() => {
            if (Date.now() - lastRequestTime > idleShutdownMs) {
              appendLog(
                config.logFilePath,
                '[INFO] Idle timeout reached, shutting down',
              );
              if (idleCheckInterval) {
                clearInterval(idleCheckInterval);
                idleCheckInterval = null;
              }
              shutdownHandler?.();
            }
          }, checkMs);
          idleCheckInterval.unref();
        }

        return state;
      } catch (startupError) {
        // Best-effort rollback: close the HTTP server if it was created,
        // then let the session manager clean up any resources the
        // contextFactory may have started.
        const serverToClose = httpServer;
        if (serverToClose) {
          await new Promise<void>((resolve) => {
            serverToClose.close(() => {
              httpServer = null;
              resolve();
            });
          });
        }
        try {
          await config.sessionManager.cleanup();
        } catch {
          // Swallow — we're already propagating startupError.
        }
        workflowContext = null; // eslint-disable-line require-atomic-updates
        subPorts = {};
        throw startupError;
      }
    },

    async stop(): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      appendLog(config.logFilePath, '[INFO] Daemon shutting down');

      // 1. Remove signal handlers
      if (shutdownHandler) {
        process.removeListener('SIGTERM', shutdownHandler);
        process.removeListener('SIGINT', shutdownHandler);
        shutdownHandler = null;
      }

      // 2. Clear idle check interval
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
      }

      // 3. Stop accepting new connections, wait for in-flight (max 10s)
      await new Promise<void>((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }

        const forceClose = setTimeout(() => {
          httpServer?.closeAllConnections();
          resolve();
        }, 10_000);

        httpServer.close(() => {
          clearTimeout(forceClose);
          httpServer = null;
          resolve();
        });
      });

      // 4. Clean up session
      try {
        await config.sessionManager.cleanup();
      } catch (error) {
        appendLog(
          config.logFilePath,
          `[ERROR] Cleanup failed: ${extractErrorMessage(error)}`,
          true,
        );
      }

      // 5. Remove .mm-server file
      if (worktreeRoot) {
        await removeDaemonState(worktreeRoot);
      }

      appendLog(config.logFilePath, '[INFO] Daemon stopped');
    },
  };

  return instance;
}

/**
 * Appends a timestamped line to the daemon log file.
 *
 * @param logFilePath - Path to the log file, or undefined to skip file logging.
 * @param message - The log message to append.
 * @param fatal - Whether to also write to stderr.
 */
function appendLog(
  logFilePath: string | undefined,
  message: string,
  fatal = false,
): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (fatal) {
    process.stderr.write(line);
  }
  if (logFilePath) {
    fs.appendFile(logFilePath, line, 'utf-8').catch((error) => {
      process.stderr.write(`Failed to write log: ${error.message}\n`);
    });
  }
}
