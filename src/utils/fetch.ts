/**
 * Fetch with configurable timeout using AbortController
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch options (method, headers, body, etc.)
 * @param timeoutMs - Timeout in milliseconds (default: 5000ms)
 * @returns Promise resolving to the fetch Response
 * @throws Error if the request times out or fails
 *
 * @example
 * ```typescript
 * const response = await fetchWithTimeout(
 *   'http://localhost:8545',
 *   { method: 'GET' },
 *   3000
 * );
 * ```
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
