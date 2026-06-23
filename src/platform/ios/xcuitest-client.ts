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

const RETRYABLE_COMMANDS = new Set(['ping', 'bind', 'snapshot', 'shutdown']);

/**
 * HTTP client for the XCUITest runner server (agent-device).
 *
 * Communicates via POST JSON to the runner's `/command` endpoint.
 *
 * Retry contract: only read-only / idempotent commands (`ping`, `bind`, `snapshot`,
 * `shutdown`) are retried at the HTTP layer on transient connection errors.
 * Mutating commands (`tap`, `type`, `fill`, etc.) fail fast to avoid duplicate side
 * effects. Recovery is the driver's responsibility via runner re-creation.
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

  async tap(x: number, y: number, options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('tap', { x, y }, options);
  }

  async ping(options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('ping', undefined, options);
  }

  async tapElement(text: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('tapElement', { text }, options);
  }

  async type(text: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('type', { text }, options);
  }

  async fill(x: number, y: number, text: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('fill', { x, y, text }, options);
  }

  async bind(appBundleId: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('bind', { appBundleId }, options);
  }

  async swipe(
    direction: SwipeDirection,
    options?: { x?: number; y?: number; signal?: AbortSignal },
  ): Promise<void> {
    const { x, y, signal } = options ?? {};
    await this.sendCommand('swipe', { direction, x, y }, { signal });
  }

  async snapshot(options?: {
    interactiveOnly?: boolean;
    compact?: boolean;
    depth?: number;
    scope?: string;
    signal?: AbortSignal;
  }): Promise<SnapshotNode[]> {
    const { signal, ...params } = options ?? {};
    const result = await this.sendCommand<SnapshotDataPayload>(
      'snapshot',
      params,
      { signal },
    );
    return result?.nodes ?? [];
  }

  async back(options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('back', undefined, options);
  }

  async home(options?: { signal?: AbortSignal }): Promise<void> {
    await this.sendCommand('home', undefined, options);
  }

  /**
   * Poll the runner until it accepts a snapshot command, or timeout.
   * Used to detect runner readiness (Swift runner has no healthcheck command).
   */
  async waitForRunner(timeoutMs: number = 15_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.sendCommand('ping');
        return true;
      } catch {
        await this.sleep(100);
      }
    }
    return false;
  }

  async shutdown(options?: { signal?: AbortSignal }): Promise<void> {
    try {
      await this.sendCommand('shutdown', undefined, options);
    } catch {
      // ignored — runner may already be gone
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const reason = signal.reason;
      const error = new Error(
        reason instanceof Error ? reason.message : String(reason),
      );
      error.name = 'AbortError';
      throw error;
    }
  }

  private async sendCommand<T = unknown>(
    command: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    this.throwIfAborted(options?.signal);

    const url = `http://${this.host}:${this.port}/command`;
    const body = JSON.stringify({ ...params, command });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.throwIfAborted(options?.signal);

      try {
        const signals: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)];
        if (options?.signal) {
          signals.push(options.signal);
        }
        const signal =
          signals.length > 1 ? AbortSignal.any(signals) : signals[0];

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal,
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

        this.throwIfAborted(options?.signal);

        if (!this.isRetryable(lastError, command) || attempt === this.maxRetries) {
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

  private isRetryable(error: Error, command: string): boolean {
    if (!RETRYABLE_COMMANDS.has(command)) {
      return false;
    }

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
