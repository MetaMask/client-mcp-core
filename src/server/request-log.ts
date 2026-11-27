import path from 'node:path';

import { redactUrl, truncateText } from '../events/redact.js';

type ToolError = { code?: unknown };

type BatchStep = { ok?: unknown; error?: ToolError };

type ResponseBody = {
  ok?: unknown;
  error?: ToolError;
  result?: {
    steps?: unknown;
    summary?: { failed?: unknown; total?: unknown };
    path?: unknown;
    screenshot?: { path?: unknown } | null;
  };
};

/**
 * Returns a ` code=<code>` suffix for an error code, or `` when it is not an
 * identifier such as `MM_CLICK_TIMEOUT`. Free text could carry user input
 * (typed text, a URL) into the log, or a newline that fakes a log line.
 *
 * @param code - The `error.code` of a response.
 * @returns The suffix, or an empty string.
 */
function codeSuffix(code: unknown): string {
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? ` code=${code}`
    : '';
}

/**
 * Describes the outcome of a JSON response body for the daemon log. The
 * daemon answers 200 for most tool failures, so the status alone does not
 * tell a failed call from a successful one.
 *
 * @param body - The JSON body sent to the client.
 * @returns For example ` ok=false code=MM_CLICK_TIMEOUT`, `` for a body
 * without an `ok` field.
 */
export function describeOutcome(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }
  const { ok, error, result } = body as ResponseBody;
  if (ok === false) {
    return ` ok=false${codeSuffix(error?.code)}`;
  }
  if (ok !== true) {
    return '';
  }

  const failed = result?.summary?.failed;
  if (typeof failed !== 'number' || failed === 0) {
    return ' ok=true';
  }
  const steps = Array.isArray(result?.steps)
    ? (result.steps as BatchStep[])
    : [];
  const code = steps.find((step) => step.ok === false)?.error?.code;
  const total = result?.summary?.total;
  return ` ok=true failed=${failed}/${
    typeof total === 'number' ? total : '?'
  }${codeSuffix(code)}`;
}

// Input fields that say what a call acted on, in log order: the field name in
// the request body and the key in the log line. An allowlist, so a field added
// later (typed text, cdp params, a secret) never reaches the log unreviewed.
// `url` is redacted with the rules of `mm network`.
const TARGET_FIELDS: readonly (readonly [string, string])[] = [
  ['a11yRef', 'ref'],
  ['testId', 'testid'],
  ['selector', 'selector'],
  ['screen', 'screen'],
  ['role', 'role'],
  ['url', 'url'],
  ['method', 'method'],
  ['button', 'button'],
  ['direction', 'direction'],
];

export const MAX_LOGGED_VALUE_LENGTH = 200;

/**
 * Makes a value one log token: cut to {@link MAX_LOGGED_VALUE_LENGTH}
 * characters, then `%`, whitespace and control characters percent-encoded.
 * `decodeURIComponent` restores the value, and a value can never split a
 * field or start a new log line.
 *
 * @param value - The value.
 * @returns The token.
 */
export function encodeLogValue(value: string): string {
  return truncateText(value, MAX_LOGGED_VALUE_LENGTH).replace(
    // eslint-disable-next-line no-control-regex
    /[%\s\u0000-\u001f\u007f]/gu,
    (char) => encodeURIComponent(char),
  );
}

// A tool name as `run_steps` accepts it in `steps[].tool`. The schema takes
// any string, so only names of this shape are logged.
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

/**
 * Lists the tool of each `run_steps` step, for example `click,wait_for`.
 * Step args are not read: their targets would each need the redaction above.
 *
 * @param steps - The `steps` field of the request body.
 * @returns The comma-separated tool names, or `` when there are none.
 */
function describeBatchTools(steps: unknown): string {
  if (!Array.isArray(steps)) {
    return '';
  }
  return steps
    .map((step) =>
      typeof step === 'object' && step !== null
        ? (step as { tool?: unknown }).tool
        : undefined,
    )
    .filter(
      (tool): tool is string =>
        typeof tool === 'string' && TOOL_NAME_PATTERN.test(tool),
    )
    .join(',');
}

/**
 * Describes what a request acted on, for the daemon log: the target element,
 * screen, tab, URL or CDP method from the request body, the tools of a
 * `run_steps` batch, and the file a screenshot was saved to. Typed text, CDP
 * params, batch step args and launch secrets are never read.
 *
 * @param input - The JSON request body.
 * @param body - The JSON response body.
 * @returns For example ` testid=confirm-btn`, or `` when there is nothing to
 * describe.
 */
export function describeTarget(input: unknown, body: unknown): string {
  let fields = '';
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const [field, key] of TARGET_FIELDS) {
      const value = record[field];
      if (typeof value === 'string' && value !== '') {
        fields += ` ${key}=${encodeLogValue(
          field === 'url' ? redactUrl(value) : value,
        )}`;
      }
    }
    const tools = describeBatchTools(record.steps);
    if (tools !== '') {
      fields += ` steps=${encodeLogValue(tools)}`;
    }
  }
  if (typeof body === 'object' && body !== null) {
    const { ok, result } = body as ResponseBody;
    const file = result?.path ?? result?.screenshot?.path;
    if (ok === true && typeof file === 'string' && file !== '') {
      fields += ` file=${encodeLogValue(path.basename(file))}`;
    }
  }
  return fields;
}

/**
 * Formats the daemon log line of a finished request.
 *
 * @param request - The request method, path, body and response status.
 * @param request.method - The HTTP method.
 * @param request.path - The request path.
 * @param request.status - The HTTP status code sent.
 * @param request.input - The JSON request body, if any.
 * @param body - The JSON body sent, if any.
 * @param durationMs - The time from arrival to the end of the response.
 * @returns For example
 * `[INFO] POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT testid=confirm-btn 15080ms`.
 */
export function formatRequestLogLine(
  request: { method: string; path: string; status: number; input?: unknown },
  body: unknown,
  durationMs: number,
): string {
  return `[INFO] ${request.method} ${request.path} ${request.status}${describeOutcome(
    body,
  )}${describeTarget(request.input, body)} ${durationMs}ms`;
}
