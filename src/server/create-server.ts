import express from 'express';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { DriverLifecycle } from './cleanup-session.js';
import { writeDaemonState, removeDaemonState } from './daemon-state.js';
import { compactObservation } from './observation-compaction.js';
import { RefStore } from './ref-store.js';
import type { RefHandle } from './ref-store.js';
import { RequestQueue } from './request-queue.js';
import {
  RequestTimer,
  requestStartOf,
  setRequestStart,
  withMeta,
} from './response-timing.js';
import { isScreenBusy, screenSignature } from './screen-settle.js';
import type { ISessionManager } from './session-manager.js';
import pkg from '../../package.json';
import type { PortMap, WorkflowContext } from '../capabilities/context.js';
import { PlaywrightPlatformDriver } from '../platform/playwright-driver.js';
import type { IPlatformDriver, ScreenCapture } from '../platform/types.js';
import {
  toolRegistry,
  getToolCategory,
  checkPlatformGate,
} from '../tools/registry.js';
import type { ToolCategory } from '../tools/registry.js';
import type { A11yNodeTrimmed, TestIdItem } from '../tools/types/discovery.js';
import { createDefaultObservation } from '../tools/types/observation.js';
import type { StepRecordObservation } from '../tools/types/observation.js';
import type { RunStepsInput } from '../tools/types/tool-inputs.js';
import type { RunStepsResult } from '../tools/types/tool-outputs.js';
import {
  ANIMATION_SETTLE_GRACE_MS,
  ANIMATION_SETTLE_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  MAX_IDLE_CHECK_INTERVAL_MS,
  MOBILE_SETTLE_MAX_MS,
  MOBILE_SETTLE_MAX_SNAPSHOTS,
  MOBILE_SETTLE_MS,
  MOBILE_SETTLE_SLOW_CAPTURE_MS,
  MOBILE_SETTLE_UNCHANGED_RETRIES,
  OBSERVATION_TESTID_LIMIT,
  OBSERVATION_TIMEOUT_MS,
} from '../tools/utils/constants.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  waitForAnimationsToSettle,
} from '../tools/utils/discovery.js';
import type {
  DaemonState,
  ServerConfig,
  ToolContext,
  ToolResponse,
} from '../types/http.js';
import { extractErrorMessage } from '../utils/errors.js';
import { computeTimeoutBudget } from '../utils/timeout-budget.js';
import type { ObserveLevel, ToolName } from '../validation/schemas.js';
import {
  observeLevelSchema,
  omitObserve,
  toolSchemas,
} from '../validation/schemas.js';

export type ServerInstance = {
  start(): Promise<DaemonState>;
  stop(): Promise<void>;
};

type ObservedTree = {
  testIds: TestIdItem[];
  nodes: A11yNodeTrimmed[];
  refMap: Map<string, string>;
};

/**
 * Wraps the session manager so a tool's `sessionManager.setRefMap` and
 * `clearRefMap` go through the request's RefStore handle (dropped when the
 * request is stale or aborted). Every other member is read from the real session manager;
 * methods are bound to it, so `this` (and private fields) work.
 *
 * @param sessionManager - The real session manager.
 * @param refs - The request's RefStore handle.
 * @returns The wrapped session manager.
 */
function routeSetRefMap(
  sessionManager: ISessionManager,
  refs: RefHandle,
): ISessionManager {
  const setRefMap = (map: Map<string, string>): void => {
    refs.set(map);
  };
  const clearRefMap = (): void => {
    refs.set(new Map());
  };
  return new Proxy(sessionManager, {
    get(target, property): unknown {
      if (property === 'setRefMap') {
        return setRefMap;
      }
      if (property === 'clearRefMap') {
        return clearRefMap;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Returns the a11y tree the agent holds after a response: the delivered
 * observation's tree, else the tree a discovery tool returned. Launch and
 * cleanup start or end a session, so nothing is held after them. Only called
 * for delivered responses: a request that timed out never updates it.
 *
 * @param toolName - The tool name.
 * @param toolResult - The tool response.
 * @param observations - The delivered observation, if any.
 * @param previous - The tree held before this response.
 * @param rootSelector - The `rootSelector` of an `accessibility_snapshot`.
 * @returns The tree held now, or null.
 */
export function screenAfterResponse(
  toolName: string,
  toolResult: ToolResponse,
  observations: StepRecordObservation | undefined,
  previous: A11yNodeTrimmed[] | null,
  rootSelector?: unknown,
): A11yNodeTrimmed[] | null {
  if (toolName === 'launch' || toolName === 'cleanup') {
    return null;
  }
  if (observations) {
    // The observation is the last tree in the response.
    return observations.a11y.nodes;
  }
  if (toolResult.ok) {
    const result = toolResult.result as
      | { nodes?: unknown; a11y?: { nodes?: unknown } }
      | undefined;
    let nodes: unknown;
    if (toolName === 'accessibility_snapshot') {
      // A rootSelector snapshot is a subtree, not the screen.
      nodes = rootSelector === undefined ? result?.nodes : undefined;
    } else if (toolName === 'describe_screen') {
      nodes = result?.a11y?.nodes;
    }
    if (Array.isArray(nodes)) {
      return nodes as A11yNodeTrimmed[];
    }
  }
  return previous;
}

/**
 * Adds `screenChanged` to a successful mobile `click` result when an
 * observation was collected: whether the observed screen differs (refs
 * ignored) from the last screen the agent received before the click. Not
 * added without an observation or without an earlier screen to compare.
 *
 * @param toolName - The tool name.
 * @param result - The tool response.
 * @param observations - The observation collected after the tool, if any.
 * @param screenBefore - The last screen the agent received before the tool.
 * @param driver - The platform driver of the request.
 * @returns The response, with `screenChanged` when it applies.
 */
export function withScreenChanged(
  toolName: string,
  result: ToolResponse,
  observations: StepRecordObservation | undefined,
  screenBefore: A11yNodeTrimmed[] | null,
  driver: IPlatformDriver | undefined,
): ToolResponse {
  if (
    toolName !== 'click' ||
    !result.ok ||
    !observations ||
    !screenBefore ||
    !driver ||
    driver.getPlatform() === 'browser' ||
    typeof result.result !== 'object' ||
    result.result === null
  ) {
    return result;
  }
  return {
    ok: true,
    result: {
      ...(result.result as Record<string, unknown>),
      screenChanged:
        screenSignature(observations.a11y.nodes) !==
        screenSignature(screenBefore),
    },
  };
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
 * Reads a valid `observe` level from an input payload.
 *
 * @param input - The input payload.
 * @returns The level, or undefined when absent or invalid.
 */
function readObserveLevel(input: unknown): ObserveLevel | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const parsed = observeLevelSchema.safeParse(
    (input as { observe?: unknown }).observe,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Finds the `observe` level of the last step that `run_steps` executed.
 * Steps skipped by `batchTimeoutMs` do not count.
 *
 * @param validatedInput - The validated `run_steps` input.
 * @param toolResult - The `run_steps` result.
 * @returns The last executed step's level, or undefined when it has none.
 */
function lastExecutedStepObserveLevel(
  validatedInput: Record<string, unknown> | undefined,
  toolResult: ToolResponse | undefined,
): ObserveLevel | undefined {
  if (!toolResult?.ok) {
    return undefined;
  }
  const steps = (validatedInput as Partial<RunStepsInput> | undefined)?.steps;
  const results = (toolResult.result as Partial<RunStepsResult> | undefined)
    ?.steps;
  if (!Array.isArray(steps) || !Array.isArray(results)) {
    return undefined;
  }
  const executed = results.filter((step) => step.meta?.skipped !== true);
  return readObserveLevel(steps[executed.length - 1]?.args);
}

/**
 * Resolves the observation level for a tool call. An explicit `observe` in
 * the input wins. Otherwise:
 *
 * - `mutating`: `'diff'`.
 * - `batch` (`run_steps`): the `observe` of the last executed step, else
 * `'diff'`. Other per-step `observe` values are ignored.
 * - `readonly`, `discovery`, `cdp`: `'none'`.
 *
 * @param category - The tool category.
 * @param validatedInput - The validated input payload.
 * @param toolResult - The tool result (used by `run_steps` to find the last
 * executed step).
 * @returns The observation level.
 */
export function resolveObserveLevel(
  category: ToolCategory,
  validatedInput?: Record<string, unknown>,
  toolResult?: ToolResponse,
): ObserveLevel {
  const explicit = readObserveLevel(validatedInput);
  if (explicit) {
    return explicit;
  }
  if (category === 'mutating') {
    return 'diff';
  }
  if (category === 'batch') {
    return lastExecutedStepObserveLevel(validatedInput, toolResult) ?? 'diff';
  }
  return 'none';
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
  const refStore = new RefStore(config.sessionManager);
  const nonce = randomUUID();
  // One owner for driver disposal retries across tools, stop() and rollback.
  // Keyed by this server, not by the session manager object a caller sees.
  // Retries of drivers from earlier sessions never fail the current call, so
  // log them here to keep repeated failures visible.
  const driverLifecycle = new DriverLifecycle({
    onStaleDisposalError: (error): void =>
      appendLog(
        config.logFilePath,
        `[WARN] Retained driver disposal failed again: ${extractErrorMessage(error)}`,
      ),
  });

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
  // The last a11y tree the agent received (from an observation or from
  // describe_screen / accessibility_snapshot). The mobile settle compares
  // against it to tell whether the screen changed yet.
  let lastScreen: A11yNodeTrimmed[] | null = null;

  // Registered before the body parser so `meta.timing.totalMs` includes body
  // parsing, and so malformed-JSON errors still have a start time.
  app.use((_req, res, next) => {
    setRequestStart(res, performance.now());
    next();
  });

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
   * `refMap` reads the session manager on each access; writes from older or
   * aborted requests never reach it (see RefStore), so it always holds the
   * refs of this request or of the last request that completed.
   * `sessionManager.setRefMap` writes through the request's RefStore handle.
   *
   * @param wfCtx - The current workflow context to embed in the tool context.
   * @param signal - The request's abort signal.
   * @param refs - The request's RefStore handle.
   * @returns A ToolContext with lazy page and refMap accessors.
   */
  function buildToolContext(
    wfCtx: WorkflowContext,
    signal: AbortSignal,
    refs: RefHandle,
  ): ToolContext {
    const driver = config.sessionManager.hasActiveSession()
      ? (config.sessionManager.getPlatformDriver?.() ??
        new PlaywrightPlatformDriver(
          () => config.sessionManager.getPage(),
          config.sessionManager,
        ))
      : undefined;

    return {
      sessionManager: routeSetRefMap(config.sessionManager, refs),
      get page(): ReturnType<typeof config.sessionManager.getPage> {
        return config.sessionManager.getPage();
      },
      get refMap(): Map<string, string> {
        return config.sessionManager.hasActiveSession()
          ? config.sessionManager.getRefMap()
          : new Map<string, string>();
      },
      workflowContext: wfCtx,
      toolRegistry,
      driver,
      signal,
      cleanupSession: async () =>
        driverLifecycle.cleanupSession(config.sessionManager),
    };
  }

  /**
   * Takes one mobile snapshot: one device snapshot when the driver has
   * `captureScreen` (`MobilePlatformDriver`), else the tree and the test IDs
   * separately (two device snapshots).
   *
   * @param driver - The mobile platform driver.
   * @returns The tree and a test ID reader.
   */
  async function captureMobile(
    driver: IPlatformDriver,
  ): Promise<ScreenCapture> {
    if (driver.captureScreen) {
      return driver.captureScreen();
    }
    const tree = await driver.getAccessibilityTree();
    return { ...tree, getTestIds: async (limit) => driver.getTestIds(limit) };
  }

  /**
   * Takes the mobile accessibility tree and test IDs.
   *
   * After a mutating or batch tool (`settle`), the screen may not have
   * changed yet, or may show work in progress (for example a "busy" button
   * while the wallet unlocks). Limits:
   *
   * - Busy (see `isScreenBusy`): wait `MOBILE_SETTLE_MS` and take the
   * snapshot again, while the screen stays busy.
   * - Unchanged (equals the last screen the agent received, ignoring refs)
   * and not busy: retry at most `MOBILE_SETTLE_UNCHANGED_RETRIES` time(s).
   * Many taps leave the screen as it is (for example tapping the tab that is
   * already open), so more retries would only add device snapshots. This
   * applies to Android too: the mobile driver removes the status bar
   * (clock, signal), so it does not make every snapshot differ. No unchanged
   * retry when the first snapshot took `MOBILE_SETTLE_SLOW_CAPTURE_MS` or
   * more: the UI already had that time to change.
   * - In total: at most `MOBILE_SETTLE_MAX_SNAPSHOTS` extra snapshots, and no
   * wait that would end later than `MOBILE_SETTLE_MAX_MS` after the first
   * snapshot started (the snapshots count, so a slow Android capture leaves
   * less time). A spinner that never stops costs at most these limits.
   *
   * The test IDs come from the final snapshot, so they describe the same
   * screen as the tree.
   *
   * @param driver - The mobile platform driver.
   * @param settle - Whether to settle (see above).
   * @param signal - Aborted when the request or the observation times out.
   * @returns The test IDs, nodes and refMap.
   */
  async function snapshotMobile(
    driver: IPlatformDriver,
    settle: boolean,
    signal: AbortSignal,
  ): Promise<ObservedTree> {
    const settleStartedAt = Date.now();
    let screen = await captureMobile(driver);
    if (settle) {
      const slowCapture =
        Date.now() - settleStartedAt >= MOBILE_SETTLE_SLOW_CAPTURE_MS;
      const previous = lastScreen ? screenSignature(lastScreen) : null;
      let unchangedRetries = 0;
      const shouldRetry = (nodes: A11yNodeTrimmed[]): boolean => {
        if (isScreenBusy(nodes)) {
          return true;
        }
        if (
          previous === null ||
          slowCapture ||
          unchangedRetries >= MOBILE_SETTLE_UNCHANGED_RETRIES ||
          screenSignature(nodes) !== previous
        ) {
          return false;
        }
        unchangedRetries += 1;
        return true;
      };
      for (
        let extra = 0;
        extra < MOBILE_SETTLE_MAX_SNAPSHOTS &&
        Date.now() - settleStartedAt + MOBILE_SETTLE_MS <=
          MOBILE_SETTLE_MAX_MS &&
        shouldRetry(screen.nodes);
        extra++
      ) {
        await delay(MOBILE_SETTLE_MS, undefined, { signal });
        screen = await captureMobile(driver);
      }
    }
    signal.throwIfAborted();
    const testIds = await screen.getTestIds(OBSERVATION_TESTID_LIMIT);
    return { testIds, nodes: screen.nodes, refMap: screen.refMap };
  }

  /**
   * Takes the browser test IDs and accessibility tree. Tools that may change
   * the screen (mutating, batch, and a cdp call that asked for an
   * observation) wait for the page to settle first.
   *
   * @param category - The tool category.
   * @param signal - Aborted when the request or the observation times out.
   * @returns The test IDs, nodes and refMap.
   */
  async function snapshotBrowser(
    category: ToolCategory,
    signal: AbortSignal,
  ): Promise<ObservedTree> {
    const page = config.sessionManager.getPage();
    if (category !== 'readonly' && category !== 'discovery') {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      signal.throwIfAborted();
      // Waits only for running, finite animations of elements (infinite
      // spinners are ignored), checked once per frame, capped at 1 s.
      await waitForAnimationsToSettle(
        page,
        ANIMATION_SETTLE_TIMEOUT_MS,
        ANIMATION_SETTLE_GRACE_MS,
      );
      signal.throwIfAborted();
    }
    const testIds = await collectTestIds(page, OBSERVATION_TESTID_LIMIT);
    signal.throwIfAborted();
    const tree = await collectTrimmedA11ySnapshot(page);
    return { testIds, ...tree };
  }

  /**
   * Collects the post-tool observation. Its refMap is applied through the
   * request's RefStore handle, which drops the write when the request is
   * stale or aborted. The observation is the last tree in the response, so
   * its refs replace any refs the tool set: every ref the agent receives
   * last resolves.
   *
   * @param context - The tool context of the request.
   * @param toolName - The tool name.
   * @param category - The tool category.
   * @param refs - The request's RefStore handle.
   * @param signal - Aborted when the request or the observation times out.
   * @returns The observation.
   */
  async function collectObservation(
    context: ToolContext,
    toolName: string,
    category: ToolCategory,
    refs: RefHandle,
    signal: AbortSignal,
  ): Promise<StepRecordObservation> {
    // Re-read the driver from the session manager rather than using
    // context.driver, which was captured before the tool ran. The launch
    // tool creates the session (and sets the platform driver) during
    // execution, so the context snapshot would still be undefined then.
    const driver =
      config.sessionManager.getPlatformDriver?.() ?? context.driver;
    const mobile = driver !== undefined && driver.getPlatform() !== 'browser';
    // No settle when a (non-batch) tool set refs: it just read the screen.
    // run_steps: a later step may have changed the screen after a step read
    // it, so it still settles.
    const settle =
      (category === 'mutating' || category === 'batch') &&
      toolName !== 'launch' &&
      toolName !== 'cleanup' &&
      !(refs.toolSetRefs && category !== 'batch');
    const tree = mobile
      ? await snapshotMobile(driver, settle, signal)
      : await snapshotBrowser(category, signal);
    signal.throwIfAborted();

    refs.set(tree.refMap, 'observation');
    return createDefaultObservation(tree.testIds, tree.nodes);
  }

  /**
   * Runs collectObservation bounded by `OBSERVATION_TIMEOUT_MS`. On timeout
   * or request abort the collection is aborted, so it stops at the next
   * checkpoint and cannot set refs later.
   *
   * @param context - The tool context of the request.
   * @param toolName - The tool name.
   * @param category - The tool category.
   * @param refs - The request's RefStore handle.
   * @param requestSignal - The request's abort signal.
   * @returns The observation, or undefined on failure or timeout.
   */
  async function observeWithTimeout(
    context: ToolContext,
    toolName: string,
    category: ToolCategory,
    refs: RefHandle,
    requestSignal: AbortSignal,
  ): Promise<StepRecordObservation | undefined> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(requestSignal.reason);
    requestSignal.addEventListener('abort', forwardAbort, { once: true });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        collectObservation(
          context,
          toolName,
          category,
          refs,
          controller.signal,
        ),
        new Promise<undefined>((resolve) => {
          timeoutId = setTimeout(() => {
            controller.abort(new Error('Observation timed out'));
            resolve(undefined);
          }, OBSERVATION_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // non-fatal: observation failure must not block the tool response
      return undefined;
    } finally {
      clearTimeout(timeoutId);
      requestSignal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * Shared tool executor — validates input, runs through the queue,
   * and collects observations.
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
    const timer = new RequestTimer(requestStartOf(res));
    // Only names registered in the tool registry may be dispatched.
    const tool = toolRegistry.has(toolName)
      ? toolRegistry.get(toolName)
      : undefined;
    if (typeof tool !== 'function') {
      res.status(404).json(
        withMeta(
          {
            ok: false,
            error: {
              code: 'TOOL_NOT_FOUND',
              message: `Unknown tool: ${toolName}`,
            },
          },
          timer.meta(),
        ),
      );
      return;
    }

    if (!workflowContext) {
      res.status(503).json(
        withMeta(
          {
            ok: false,
            error: {
              code: 'SERVER_NOT_STARTED',
              message: 'Server has not been started yet.',
            },
          },
          timer.meta(),
        ),
      );
      return;
    }

    const schema =
      toolName in toolSchemas ? toolSchemas[toolName as ToolName] : undefined;
    let validatedInput = rawInput;

    if (schema) {
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) {
        res.status(400).json(
          withMeta(
            {
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
            },
            timer.meta(),
          ),
        );
        return;
      }
      validatedInput = parsed.data;
    }

    const currentWorkflowContext = workflowContext;

    const category = getToolCategory(toolName);

    const gateError = checkPlatformGate(
      toolName,
      config.sessionManager.getPlatformDriver?.()?.getPlatform(),
    );
    if (gateError) {
      res.json(withMeta({ ok: false, error: gateError }, timer.meta()));
      return;
    }

    const inputRecord = validatedInput as Record<string, unknown>;
    const toolTimeoutMs = inputRecord?.timeoutMs;
    const queueTimeoutMs =
      typeof toolTimeoutMs === 'number' && toolTimeoutMs > 0
        ? computeTimeoutBudget(toolTimeoutMs).queue
        : undefined;

    try {
      timer.markEnqueued();
      const { toolResult, observeLevel, observations } = await queue.enqueue(
        async (signal) => {
          timer.markTaskStart();
          const refs = refStore.begin(signal);
          const context = buildToolContext(
            currentWorkflowContext,
            signal,
            refs,
          );
          const result = await tool(omitObserve(validatedInput), context);
          timer.markToolEnd();

          const level = resolveObserveLevel(category, inputRecord, result);
          // Captured now: the observation below must compare with the
          // screen the agent had before this click.
          const screenBefore = lastScreen;
          let obs: StepRecordObservation | undefined;
          if (
            level !== 'none' &&
            !signal.aborted &&
            config.sessionManager.hasActiveSession()
          ) {
            timer.markObservationStart();
            obs = await observeWithTimeout(
              context,
              toolName,
              category,
              refs,
              signal,
            );
            timer.markObservationEnd();
          }

          return {
            toolResult: withScreenChanged(
              toolName,
              result,
              obs,
              screenBefore,
              context.driver,
            ),
            observeLevel: level,
            observations: obs,
          };
        },
        queueTimeoutMs ? { timeoutMs: queueTimeoutMs } : undefined,
      );

      // 'full' skips the diff but is still option-collapsed, like the first
      // observation of a session.
      const responseObservations = observations
        ? compactObservation(
            observations,
            observeLevel === 'full' ? null : lastObservation,
          )
        : undefined;
      res.json(
        withMeta(
          buildResponseBody(toolResult, responseObservations),
          timer.meta(),
        ),
      );

      if (
        toolName === 'describe_screen' ||
        toolName === 'accessibility_snapshot' ||
        toolName === 'launch' ||
        toolName === 'cleanup'
      ) {
        lastObservation = null;
      } else if (observations) {
        lastObservation = observations;
      }
      // Updated after the response, like lastObservation: only for responses
      // the agent received.
      lastScreen = screenAfterResponse(
        toolName,
        toolResult,
        observations,
        lastScreen,
        inputRecord?.rootSelector,
      );
    } catch (error) {
      res.status(500).json(
        withMeta(
          {
            ok: false,
            error: {
              code: 'TOOL_EXECUTION_FAILED',
              message: extractErrorMessage(error),
            },
          },
          timer.meta(),
        ),
      );
    }
  }

  app.post('/launch', async (req, res) => {
    await executeTool('launch', req.body, res);
  });

  app.post('/cleanup', async (req, res) => {
    // Only `observe` is read from the body; other fields are ignored.
    const observe = (req.body as { observe?: unknown } | undefined)?.observe;
    await executeTool('cleanup', observe === undefined ? {} : { observe }, res);
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
      res.status(500).json(
        withMeta(
          {
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: error.message,
            },
          },
          new RequestTimer(requestStartOf(res)).meta(),
        ),
      );
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
          const checkMs = Math.min(
            idleShutdownMs / 10,
            MAX_IDLE_CHECK_INTERVAL_MS,
          );
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
          await driverLifecycle.cleanupSession(config.sessionManager);
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
        }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

        httpServer.close(() => {
          clearTimeout(forceClose);
          httpServer = null;
          resolve();
        });
      });

      // 4. Clean up session
      try {
        await driverLifecycle.cleanupSession(config.sessionManager);
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
