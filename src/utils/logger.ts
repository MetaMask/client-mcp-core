import { extractErrorMessage } from './errors.js';

/**
 * Debug logging for server operations.
 * Enabled via DEBUG=true environment variable.
 *
 * By default, logging is disabled to avoid noise in HTTP daemon logs.
 */

const DEBUG = process.env.DEBUG === 'true';

/**
 * Log a debug warning message. Only outputs when DEBUG=true.
 * Use this for caught errors that are intentionally suppressed.
 *
 * @param context - A short identifier for where the warning occurred (e.g., "discovery.collectTestIds")
 * @param error - The caught error or message
 */
export function debugWarn(context: string, error: unknown): void {
  if (DEBUG) {
    const message = extractErrorMessage(error);
    console.warn(`[Server:${context}] ${message}`);
  }
}
