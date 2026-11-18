import { redactUrl } from './redact.js';
import type { CdpEventTarget } from '../platform/cdp-manager.js';
import type { EventRecordTarget } from '../tools/types/events.js';

/** Records a read returns when it gives no `limit`. */
export const DEFAULT_EVENT_READ_LIMIT = 500;

/** The largest `limit` a read accepts. */
export const MAX_EVENT_READ_LIMIT = 2000;

/**
 * Parses a `since` value: epoch milliseconds (number or digits) or an ISO
 * date.
 *
 * @param since - The value from the input.
 * @returns Epoch milliseconds, or undefined when absent or not a date.
 */
export function parseSince(
  since: number | string | undefined,
): number | undefined {
  if (since === undefined) {
    return undefined;
  }
  if (typeof since === 'number') {
    return since;
  }
  if (/^\d+$/u.test(since)) {
    return Number(since);
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Converts the target of a CDP event to the target of a record, with its
 * URL redacted.
 *
 * @param target - The CDP event target.
 * @returns The record target.
 */
export function toRecordTarget(target: CdpEventTarget): EventRecordTarget {
  return { kind: target.kind, id: target.targetId, url: redactUrl(target.url) };
}
