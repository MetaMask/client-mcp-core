import type { EventsInput, EventsResult } from './types';
import { createToolSuccess, requireActiveSession } from './utils.js';
import { getSessionEvents } from '../events/session-events.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Bookmarks or clears the session event buffer (`mm events mark|clear`).
 *
 * `mark` returns the current cursor: pass it to `mm logs` and `mm network`
 * later to read only what happened after it. `clear` empties one kind or
 * every kind without resetting the cursor.
 *
 * @param input - The action.
 * @param context - The tool execution context.
 * @returns The cursor (mark) or the cleared kinds, with the buffer summary.
 */
export async function eventsTool(
  input: EventsInput,
  context: ToolContext,
): Promise<ToolResponse<EventsResult>> {
  const missingSession = requireActiveSession<EventsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const events = getSessionEvents(context.sessionManager.getContext());
  await events.ensureStarted();
  const { buffer } = events;

  if (input.action === 'clear') {
    const cleared = buffer.clear(input.kind);
    return createToolSuccess({
      action: 'clear',
      cleared,
      summary: buffer.summary(),
    });
  }

  return createToolSuccess({
    action: 'mark',
    cursor: buffer.seq,
    summary: buffer.summary(),
  });
}
