import {
  DEFAULT_CDP_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
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
 * Returns the action budget of a tool request: the `timeoutMs` in the input,
 * else the default the tool itself applies. Returns undefined for tools with
 * no timeout concept, which keep the RequestQueue (daemon) or command (CLI)
 * default instead.
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
  const record =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : undefined;
  const requested = record?.timeoutMs;
  if (typeof requested === 'number' && requested > 0) {
    return requested;
  }
  if (toolName === 'run_steps') {
    // A batch covers many steps: the budget is the batch deadline.
    const batch = record?.batchTimeoutMs;
    return typeof batch === 'number' && batch > 0 ? batch : undefined;
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
