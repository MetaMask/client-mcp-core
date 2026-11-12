type ToolError = { code?: unknown };

type BatchStep = { ok?: unknown; error?: ToolError };

type ResponseBody = {
  ok?: unknown;
  error?: ToolError;
  result?: {
    steps?: unknown;
    summary?: { failed?: unknown; total?: unknown };
  };
};

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
    return typeof error?.code === 'string'
      ? ` ok=false code=${error.code}`
      : ' ok=false';
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
  return ` ok=true failed=${failed}/${String(result?.summary?.total)}${
    typeof code === 'string' ? ` code=${code}` : ''
  }`;
}

/**
 * Formats the daemon log line of a finished request.
 *
 * @param request - The request method, path and response status.
 * @param request.method - The HTTP method.
 * @param request.path - The request path.
 * @param request.status - The HTTP status code sent.
 * @param body - The JSON body sent, if any.
 * @param durationMs - The time from arrival to the end of the response.
 * @returns For example `[INFO] POST /tool/click 200 ok=false code=MM_CLICK_TIMEOUT 15080ms`.
 */
export function formatRequestLogLine(
  request: { method: string; path: string; status: number },
  body: unknown,
  durationMs: number,
): string {
  return `[INFO] ${request.method} ${request.path} ${request.status}${describeOutcome(
    body,
  )} ${durationMs}ms`;
}
