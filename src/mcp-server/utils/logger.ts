import { extractErrorMessage } from './errors.js';

/**
 * Debug logging for MCP server operations.
 * Enabled via MCP_DEBUG=true environment variable.
 *
 * By default, logging is disabled to avoid polluting MCP protocol stdout.
 */

const DEBUG = process.env.MCP_DEBUG === 'true';

/**
 * Log a debug warning message. Only outputs when MCP_DEBUG=true.
 * Use this for caught errors that are intentionally suppressed.
 *
 * @param context - A short identifier for where the warning occurred (e.g., "discovery.collectTestIds")
 * @param error - The caught error or message
 */
export function debugWarn(context: string, error: unknown): void {
  if (DEBUG) {
    const message = extractErrorMessage(error);
    console.warn(`[MCP:${context}] ${message}`);
  }
}
