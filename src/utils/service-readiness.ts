import { fetchWithTimeout } from './fetch.js';

/**
 * Options for waitForServiceReady
 */
export type WaitForServiceReadyOptions = {
  /**
   * Maximum number of attempts to check service readiness
   *
   * @default 10
   */
  maxAttempts?: number;

  /**
   * Delay in milliseconds between attempts
   *
   * @default 500
   */
  delayMs?: number;

  /**
   * Custom fetch function (useful for testing or custom timeout behavior)
   *
   * @default fetchWithTimeout
   */
  fetchFn?: typeof fetch;

  /**
   * Timeout in milliseconds for each fetch attempt
   *
   * @default 3000
   */
  timeoutMs?: number;
};

/**
 * Wait for a service to become ready by polling an endpoint
 *
 * Repeatedly attempts to fetch from the given URL until either:
 * - The service responds with a successful status (2xx or 503)
 * - Maximum attempts are reached (throws error)
 *
 * @param url - The URL to poll for service readiness
 * @param options - Configuration options
 * @throws Error if service doesn't become ready within maxAttempts
 *
 * @example
 * ```typescript
 * // Wait for fixture server to be ready
 * await waitForServiceReady('http://localhost:12345/state.json', {
 *   maxAttempts: 10,
 *   delayMs: 500,
 *   timeoutMs: 3000,
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With custom fetch function
 * await waitForServiceReady('http://localhost:8545', {
 *   fetchFn: customFetch,
 *   maxAttempts: 5,
 * });
 * ```
 */
export async function waitForServiceReady(
  url: string,
  options: WaitForServiceReadyOptions = {},
): Promise<void> {
  const {
    maxAttempts = 10,
    delayMs = 500,
    fetchFn = fetchWithTimeout,
    timeoutMs = 3000,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchFn(url, {}, timeoutMs);

      // Service is ready if it responds with 2xx or 503 (service unavailable but responding)
      if (response.ok || response.status === 503) {
        return;
      }
    } catch (error) {
      const caughtError = error as Error;

      // Connection refused - service not yet started, retry
      if (
        caughtError.cause &&
        JSON.stringify(caughtError.cause).includes('ECONNREFUSED')
      ) {
        await delay(delayMs);
        continue;
      }

      // Timeout - service slow to respond, retry
      if (caughtError.name === 'AbortError') {
        await delay(delayMs);
        continue;
      }

      // Other errors (e.g., self-signed cert accepted) - consider service ready
      return;
    }

    // Response received but not ok/503 - retry
    await delay(delayMs);
  }

  throw new Error(
    `Service at ${url} failed to become ready after ${maxAttempts} attempts`,
  );
}

/**
 * Delay helper function.
 *
 * @param ms - The delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
