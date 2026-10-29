import type { ISessionManager } from './session-manager.js';
import type { IPlatformDriver } from '../platform/types.js';
import { debugWarn, extractErrorMessage } from '../utils';

/**
 * Options for a {@link DriverLifecycle}.
 */
export type DriverLifecycleOptions = {
  /**
   * Called for each driver from an earlier session whose retried disposal
   * fails again. These failures never fail the current call, so use this
   * hook to make them visible (for example in the daemon log).
   */
  onStaleDisposalError?: (error: unknown) => void;
};

/**
 * Owns the drivers whose disposal failed, so a later cleanup can retry them.
 *
 * A consumer can clear its driver during cleanup before disposal fails; the
 * driver is then reachable only from here. Retention is keyed by this
 * instance, not by the session manager object, because callers can see the
 * same manager through different wrappers (for example a per-request proxy).
 * `createServer` owns one instance and uses it for the cleanup tool, forced
 * and failed launches, daemon stop and startup rollback.
 *
 * Only the current session decides whether a call fails. Drivers retained
 * from earlier sessions are retried best-effort on every call: their failures
 * are reported to `onStaleDisposalError` and never fail the current cleanup
 * or launch.
 */
export class DriverLifecycle {
  readonly #pending = new Set<IPlatformDriver>();

  readonly #onStaleDisposalError: ((error: unknown) => void) | undefined;

  /**
   * @param options - Hooks for retries of drivers from earlier sessions.
   */
  constructor(options: DriverLifecycleOptions = {}) {
    this.#onStaleDisposalError = options.onStaleDisposalError;
  }

  /**
   * @returns How many drivers still wait for a successful disposal.
   */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Close the app/session before releasing the driver resources it may still
   * use. Disposal also runs when consumer cleanup fails, including partial
   * launches. Drivers retained from earlier sessions are retried in parallel,
   * best-effort.
   *
   * @param manager - The session manager whose resources should be released.
   * @returns Whether the consumer cleaned up a session.
   * @throws The consumer cleanup error or the current driver's disposal
   * error; an `AggregateError` when both fail.
   */
  async cleanupSession(manager: ISessionManager): Promise<boolean> {
    // Read the driver first: consumers may clear it during cleanup.
    const driver = manager.getPlatformDriver?.();
    const current = driver?.dispose ? driver : undefined;
    if (current) {
      // If it is already pending from an earlier failed attempt, it is
      // treated as current and is not retried again as a stale driver.
      this.#pending.add(current);
    }

    const errors: unknown[] = [];
    let cleanedUp = false;
    try {
      cleanedUp = await manager.cleanup();
    } catch (error) {
      errors.push(error);
    }

    const stale = [...this.#pending].filter((pending) => pending !== current);
    const [currentFailure] = await Promise.all([
      current ? this.#dispose(current) : undefined,
      this.#retryStale(stale),
    ]);
    if (currentFailure) {
      errors.push(currentFailure.error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Session cleanup and driver disposal failed: ${errors
          .map(extractErrorMessage)
          .join('; ')}`,
      );
    }
    return cleanedUp;
  }

  /**
   * Dispose one driver and drop it from the pending set on success.
   *
   * @param driver - The driver to dispose.
   * @returns The failure, or undefined when disposal succeeded.
   */
  async #dispose(
    driver: IPlatformDriver,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await driver.dispose?.();
      this.#pending.delete(driver);
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  /**
   * Retry drivers from earlier sessions in parallel. Failures are logged and
   * reported, but never thrown.
   *
   * @param drivers - The retained drivers to retry.
   */
  async #retryStale(drivers: IPlatformDriver[]): Promise<void> {
    const results = await Promise.allSettled(
      drivers.map(async (driver) => driver.dispose?.()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.#pending.delete(drivers[index]);
        return;
      }
      debugWarn('driver-lifecycle.retry', result.reason);
      this.#onStaleDisposalError?.(result.reason);
    });
  }
}

// Fallback for callers without a server-owned lifecycle (for example a
// ToolContext built outside createServer).
const fallbackLifecycles = new WeakMap<ISessionManager, DriverLifecycle>();

/**
 * Clean up a session and dispose its driver. Prefer passing the server-owned
 * {@link DriverLifecycle}; without one, failed disposals are retained per
 * session manager object.
 *
 * @param manager - The session manager whose resources should be released.
 * @param lifecycle - The lifecycle that retains failed disposals.
 * @returns Whether the consumer cleaned up a session.
 */
export async function cleanupSession(
  manager: ISessionManager,
  lifecycle?: DriverLifecycle,
): Promise<boolean> {
  let owner = lifecycle ?? fallbackLifecycles.get(manager);
  if (!owner) {
    owner = new DriverLifecycle();
    fallbackLifecycles.set(manager, owner);
  }
  return owner.cleanupSession(manager);
}
