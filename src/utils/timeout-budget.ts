import {
  DIAGNOSTICS_BUFFER_MS,
  OBSERVATION_TIMEOUT_MS,
  QUEUE_SETTLE_TIMEOUT_MS,
} from '../tools/utils/constants.js';

/**
 * Timeout budget for a tool request across all layers (queue, HTTP, CLI).
 *
 * Each field represents the timeout for one layer of the request chain:
 *   CLI HTTP abort → queue race → tool execution + observations/diagnostics
 *
 * The budget is computed from a single tool timeout value so the layers
 * stay consistent automatically — no independent arithmetic per layer.
 */
export type TimeoutBudget = {
  /** Time budget the tool has for its own work (pass-through). */
  tool: number;
  /** Queue race timeout: tool + post-tool phase (observations or diagnostics) + overhead. */
  queue: number;
  /** CLI HTTP abort timeout: full queue timeout + settle wait + overhead. */
  http: number;
};

/**
 * Computes a consistent timeout budget from a tool's own timeout value.
 *
 * Inside the queue, a tool request has two phases:
 * 1. Tool execution — bounded by `toolTimeoutMs`.
 * 2. Post-tool work — either observation collection (success path, up to
 *    OBSERVATION_TIMEOUT_MS) or diagnostics (timeout path, up to
 *    DIAGNOSTICS_BUFFER_MS).  We budget for the larger of the two.
 *
 * The queue timeout must cover both phases plus scheduling jitter.
 * The HTTP timeout must additionally cover the settle wait in
 * RequestQueue's finally block (QUEUE_SETTLE_TIMEOUT_MS).
 *
 * @param toolTimeoutMs - The tool's own timeout budget in milliseconds.
 * @returns Timeout values for each layer of the request chain.
 */
export function computeTimeoutBudget(toolTimeoutMs: number): TimeoutBudget {
  const SCHEDULING_OVERHEAD_MS = 2_000;

  const postToolBudget = Math.max(
    OBSERVATION_TIMEOUT_MS,
    DIAGNOSTICS_BUFFER_MS,
  );

  const queue = toolTimeoutMs + postToolBudget + SCHEDULING_OVERHEAD_MS;
  const http = queue + QUEUE_SETTLE_TIMEOUT_MS + SCHEDULING_OVERHEAD_MS;

  return { tool: toolTimeoutMs, queue, http };
}
