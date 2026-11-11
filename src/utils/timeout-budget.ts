import { normaliseStep } from '../tools/batch-step.js';
import {
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS,
  OBSERVATION_TIMEOUT_MS,
  QUEUE_SETTLE_TIMEOUT_MS,
} from '../tools/utils/constants.js';

/**
 * Extra time a layer gets for scheduling above the layers it covers.
 * Absorbs timer jitter so an inner layer always expires first.
 */
export const TIMEOUT_OVERHEAD_MS = 2_000;

/** Tools whose default action budget is the interaction timeout. */
const INTERACTION_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'get_text',
  'inspect',
  'wait_for',
  'scroll_to_element',
]);

/**
 * Options for {@link resolveActionTimeoutMs}.
 */
export type ActionTimeoutOptions = {
  /**
   * The active platform. `scroll_to_element` only has a timeout on the
   * browser: on mobile it swipes up to `maxAttempts` and has no timeout of
   * its own, so it keeps the queue default.
   */
  platform?: string;
};

/**
 * Options for {@link resolveCliHttpTimeoutMs}.
 */
export type CliTimeoutOptions = {
  /** Queue timeout the daemon uses for tools without an action budget. */
  queueDefaultMs?: number;
  /** The command's fixed timeout, used when it has no action budget. */
  commandTimeoutMs?: number;
};

/**
 * Timeout budget for a tool request across all layers (queue, HTTP, CLI).
 *
 * Each field represents the timeout for one layer of the request chain:
 *   CLI HTTP abort → queue race → tool execution + observations
 *
 * The budget is computed from a single tool timeout value so the layers
 * stay consistent automatically — no independent arithmetic per layer.
 */
export type TimeoutBudget = {
  /** Time budget the tool has for its own work (pass-through). */
  tool: number;
  /** Queue race timeout: tool + observation collection + overhead. */
  queue: number;
  /** CLI HTTP abort timeout: full queue timeout + settle wait + overhead. */
  http: number;
};

/**
 * Computes a consistent timeout budget from a tool's own timeout value.
 *
 * Inside the queue, a tool request has two phases:
 * 1. Tool execution — bounded by `toolTimeoutMs`.
 * 2. Post-tool observation collection (success path, up to OBSERVATION_TIMEOUT_MS).
 *
 * The queue timeout must cover both phases plus scheduling jitter.
 * The HTTP timeout must additionally cover the settle wait in
 * RequestQueue's finally block (QUEUE_SETTLE_TIMEOUT_MS).
 *
 * @param toolTimeoutMs - The tool's own timeout budget in milliseconds.
 * @returns Timeout values for each layer of the request chain.
 */
export function computeTimeoutBudget(toolTimeoutMs: number): TimeoutBudget {
  const queue = toolTimeoutMs + OBSERVATION_TIMEOUT_MS + TIMEOUT_OVERHEAD_MS;
  const http = queue + QUEUE_SETTLE_TIMEOUT_MS + TIMEOUT_OVERHEAD_MS;

  return { tool: toolTimeoutMs, queue, http };
}

/**
 * HTTP abort the CLI gives a tool that has no action budget. It nests above
 * the daemon queue default: the queue may use its default and then wait up to
 * QUEUE_SETTLE_TIMEOUT_MS for the task to settle before it answers.
 *
 * @param queueDefaultMs - The daemon queue default in milliseconds.
 * @returns The CLI HTTP abort timeout in milliseconds.
 */
export function fallbackHttpTimeoutMs(
  queueDefaultMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  return queueDefaultMs + QUEUE_SETTLE_TIMEOUT_MS + TIMEOUT_OVERHEAD_MS;
}

/**
 * Action budget of one run_steps step. A step whose tool has no action budget
 * (for example `navigate`) counts as the interaction default, so the batch
 * always covers its slowest possible step.
 *
 * @param tool - The step's resolved tool name.
 * @param args - The step's arguments.
 * @returns The step budget in milliseconds.
 */
function resolveStepBudgetMs(
  tool: string,
  args: Record<string, unknown>,
): number {
  return (
    resolveActionTimeoutMs(tool, args) ??
    resolveActionTimeoutMs(tool, args, { platform: 'android' }) ??
    DEFAULT_INTERACTION_TIMEOUT_MS
  );
}

/**
 * Action budget of a `run_steps` call: its batch deadline plus the slowest
 * step, because the deadline is only checked between steps. Returns undefined
 * without a `batchTimeoutMs`, so the call keeps the queue default.
 *
 * @param input - The run_steps input as parsed by the daemon or sent by the CLI.
 * @returns The action budget in milliseconds, or undefined.
 */
export function resolveBatchActionTimeoutMs(
  input?: unknown,
): number | undefined {
  const record =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : undefined;
  const batch = record?.batchTimeoutMs;
  if (!(typeof batch === 'number' && batch > 0) || record === undefined) {
    return undefined;
  }

  const steps = Array.isArray(record.steps) ? record.steps : [];
  let slowestStepMs = 0;
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) {
      continue;
    }
    const { tool, args } = step as { tool?: unknown; args?: unknown };
    if (typeof tool !== 'string') {
      continue;
    }
    const argsRecord =
      typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>)
        : {};
    const normalised = normaliseStep(tool, argsRecord);
    slowestStepMs = Math.max(
      slowestStepMs,
      resolveStepBudgetMs(normalised.tool, normalised.args),
    );
  }
  if (slowestStepMs === 0) {
    // No usable step (an invalid body): assume one slow step rather than
    // under-budget the request.
    slowestStepMs = DEFAULT_INTERACTION_TIMEOUT_MS;
  }

  return batch + slowestStepMs;
}

/**
 * Returns the action budget of a tool request: the `timeoutMs` in the input,
 * else the default the tool itself applies. `run_steps` ignores `timeoutMs`
 * and uses `batchTimeoutMs` plus its slowest step. Returns undefined for tools
 * with no timeout concept, which keep the RequestQueue (daemon) or command
 * (CLI) default instead.
 *
 * @param toolName - The tool name (for example `click` or `run_steps`).
 * @param input - The request input, already validated by the daemon and as
 * sent by the CLI.
 * @param options - Optional context for the default.
 * @returns The action budget in milliseconds, or undefined.
 */
export function resolveActionTimeoutMs(
  toolName: string,
  input?: unknown,
  options?: ActionTimeoutOptions,
): number | undefined {
  if (toolName === 'run_steps') {
    // The daemon strips any top-level timeoutMs, so the CLI must ignore it
    // too: the batch deadline is the only action budget run_steps has.
    return resolveBatchActionTimeoutMs(input);
  }
  const record =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : undefined;
  const requested = record?.timeoutMs;
  if (typeof requested === 'number' && requested > 0) {
    return requested;
  }
  if (toolName === 'cdp') {
    return DEFAULT_CDP_TIMEOUT_MS;
  }
  if (toolName === 'wait_for_notification') {
    return DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS;
  }
  if (INTERACTION_TOOLS.has(toolName)) {
    if (
      toolName === 'scroll_to_element' &&
      options?.platform !== undefined &&
      options.platform !== 'browser'
    ) {
      return undefined;
    }
    return DEFAULT_INTERACTION_TIMEOUT_MS;
  }
  return undefined;
}

/**
 * HTTP abort the CLI gives a command. It nests above the daemon queue for every
 * tool: the queue derives its timeout from the same action budget, or keeps its
 * default for tools without one.
 *
 * For a tool whose action budget depends on the platform (`scroll_to_element`)
 * the CLI does not know the daemon's platform, so it takes the larger of the
 * two possible values: the browser budget or the mobile queue fallback.
 *
 * @param commandName - The command (the last path segment of the request).
 * @param input - The request body.
 * @param options - The daemon queue default and the command's fixed timeout.
 * @returns The CLI HTTP abort timeout in milliseconds.
 */
export function resolveCliHttpTimeoutMs(
  commandName: string,
  input?: unknown,
  options?: CliTimeoutOptions,
): number {
  const queueDefaultMs = options?.queueDefaultMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fallback = fallbackHttpTimeoutMs(queueDefaultMs);
  const perPlatform = [
    resolveActionTimeoutMs(commandName, input),
    resolveActionTimeoutMs(commandName, input, { platform: 'android' }),
  ];
  const derived = perPlatform
    .filter((timeoutMs): timeoutMs is number => timeoutMs !== undefined)
    .map((timeoutMs) => computeTimeoutBudget(timeoutMs).http);

  if (derived.length > 0) {
    const missingOnAPlatform = perPlatform.some(
      (timeoutMs) => timeoutMs === undefined,
    );
    // A platform-dependent tool keeps the daemon queue default on mobile; the
    // daemon never gives run_steps less than its own queue default.
    if (commandName === 'run_steps' || missingOnAPlatform) {
      derived.push(fallback);
    }
    return Math.max(...derived);
  }

  return Math.max(options?.commandTimeoutMs ?? 0, fallback);
}
