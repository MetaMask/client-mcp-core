import { matchesUrlFilter } from './mock-network.js';
import type { NetworkInput, NetworkRecord, NetworkResult } from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import {
  DEFAULT_EVENT_READ_LIMIT,
  parseSince,
} from '../events/read-options.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Checks whether a request is an error: HTTP status 400 or more, a
 * failure, or a JSON-RPC error.
 *
 * @param record - The request.
 * @returns True for an error.
 */
export function isErrorRequest(record: NetworkRecord): boolean {
  return (
    record.failure !== undefined ||
    (record.status !== undefined && record.status >= 400) ||
    record.rpcError !== undefined
  );
}

/**
 * Reads the HTTP(S) requests of every page and the Extension service worker
 * (`mm network`), or turns JSON-RPC error reading on or off
 * (`mm network configure`).
 *
 * An unfiltered read returns every record in start order and advances past
 * every record, pending or not. A read with `url` or `errors` returns only
 * settled requests, in settle order: a request may become a match only when
 * it ends (a 404, a failure, a `rpcError`), so it is returned by the read
 * that follows its end, once, also when it started long before the cursor.
 * An unsettled request is never returned by a filtered read, and a request
 * that never ends therefore never matches one. `settled: true` asks for the
 * same settle-order read without a filter, so a consumer can read the final
 * status of every request that ended after the cursor, including ones it
 * started earlier. `since` compares the request start time (`t`).
 *
 * @param input - Read options, or the `configure` action.
 * @param context - The tool execution context.
 * @returns A page of network records, or the new config.
 */
export async function networkTool(
  input: NetworkInput,
  context: ToolContext,
): Promise<ToolResponse<NetworkResult>> {
  const missingSession = requireActiveSession<NetworkResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const events = getSessionEvents(context.sessionManager.getContext());
  await events.ensureStarted();

  if (input.action === 'configure') {
    events.config = { ...events.config, rpcErrors: input.rpcErrors };
    return createToolSuccess({
      action: 'configure',
      config: { rpcErrors: events.config.rpcErrors },
      summary: events.buffer.summary(),
    });
  }

  const { url, errors } = input;
  const filtered = url !== undefined || errors === true;
  const page = events.buffer.read<NetworkRecord>({
    kind: 'network',
    cursor: input.cursor,
    since: parseSince(input.since),
    limit: input.limit ?? DEFAULT_EVENT_READ_LIMIT,
    settled: filtered || input.settled === true,
    filter: filtered
      ? (record): boolean =>
          (url === undefined || matchesUrlFilter(url, record.url)) &&
          (errors !== true || isErrorRequest(record))
      : undefined,
  });
  return createToolSuccess({ ...page, stats: { ...events.networkStats } });
}
