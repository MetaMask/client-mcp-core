/* eslint-disable -- fetch and Response are stable APIs since Node 20.18+ (LTS), see https://nodejs.org/docs/latest-v20.x/api/globals.html#fetch */

import type {
  XCUITestClientConfig,
  RunnerResponse,
  SnapshotDataPayload,
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
    depth?: number;
    scope?: string;
  }): Promise<SnapshotNode[]> {
    const result = await this.sendCommand<SnapshotDataPayload>(
      'snapshot',
      options,
    );
    return result?.nodes ?? [];
  }

  async back(): Promise<void> {
    await this.sendCommand('back');
  }

  async home(): Promise<void> {
    await this.sendCommand('home');
  }

  /**
   * Poll the runner until it accepts a snapshot command, or timeout.
   * Used to detect runner readiness (Swift runner has no healthcheck command).
   */
  async waitForRunner(timeoutMs: number = 15_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.sendCommand<SnapshotDataPayload>('snapshot');
        return true;
      } catch {
        await this.sleep(100);
      }
    }
    return false;
  }

  async shutdown(): Promise<void> {
    try {
      await this.sendCommand('shutdown');
    } catch {
      // ignored — runner may already be gone
    }
  }

  private async sendCommand<T = unknown>(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = `http://${this.host}:${this.port}/command`;
    const body = JSON.stringify({ ...params, command });

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
          const errorMessage = json.error?.message ?? 'unknown error';
          throw new Error(
            `Runner command '${command}' failed: ${errorMessage}`,
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
      return false;
    }

    return false;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
