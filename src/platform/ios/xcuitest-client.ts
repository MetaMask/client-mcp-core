/* eslint-disable -- fetch and Response are stable APIs since Node 20.18+ (LTS), see https://nodejs.org/docs/latest-v20.x/api/globals.html#fetch */

import type {
  XCUITestClientConfig,
  RunnerResponse,
  SnapshotNode,
  SwipeDirection,
} from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * HTTP client for the XCUITest runner server (agent-device).
 *
 * Communicates via POST JSON to the runner's `/command` endpoint.
 * Implements retry logic for transient connection failures.
 */
export class XCUITestClient {
  private readonly host: string;

  private readonly port: number;

  private readonly timeoutMs: number;

  private readonly maxRetries: number;

  private readonly retryDelayMs: number;

  constructor(config: XCUITestClientConfig) {
    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.sendCommand('tap', { x, y });
  }

  async type(text: string): Promise<void> {
    await this.sendCommand('type', { text });
  }

  async swipe(
    direction: SwipeDirection,
    x?: number,
    y?: number,
  ): Promise<void> {
    await this.sendCommand('swipe', { direction, x, y });
  }

  async snapshot(options?: {
    interactiveOnly?: boolean;
    compact?: boolean;
  }): Promise<SnapshotNode[]> {
    return await this.sendCommand<SnapshotNode[]>('snapshot', options);
  }

  async back(): Promise<void> {
    await this.sendCommand('back');
  }

  async home(): Promise<void> {
    await this.sendCommand('home');
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.sendCommand('healthcheck');
      return true;
    } catch {
      return false;
    }
  }

  private async sendCommand<T = unknown>(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = `http://${this.host}:${this.port}/command`;
    const body = JSON.stringify({ command, ...params });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const json = (await response.json()) as RunnerResponse<T>;

        if (!json.ok) {
          throw new Error(
            `Runner command '${command}' failed: ${json.error ?? 'unknown error'}`,
          );
        }

        return json.data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(lastError) || attempt === this.maxRetries) {
          throw lastError;
        }

        const delay = this.retryDelayMs * (attempt + 1);
        await this.sleep(delay);
      }
    }

    throw (
      lastError ?? new Error(`Runner command '${command}' failed after retries`)
    );
  }

  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase();
    const causeCode =
      error.cause &&
      typeof error.cause === 'object' &&
      'code' in error.cause &&
      typeof error.cause.code === 'string'
        ? error.cause.code
        : '';

    if (causeCode === 'ECONNREFUSED') {
      return true;
    }

    if (
      message.includes('econnrefused') ||
      message.includes('fetch failed') ||
      message.includes('socket hang up')
    ) {
      return true;
    }

    if (error.name === 'TimeoutError' || message.includes('timed out')) {
      return true;
    }

    return false;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
