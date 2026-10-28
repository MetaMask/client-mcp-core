import type { ISessionManager } from './session-manager.js';
import type { IPlatformDriver } from '../platform/types.js';

/**
 * Owns the drivers whose disposal failed, so a later cleanup can retry them.
 *
 * A consumer can clear its driver during cleanup before disposal fails; the
 * driver is then reachable only from here. Retention is keyed by this
 * instance, not by the session manager object, because callers can see the
 * same manager through different wrappers (for example a per-request proxy).
 * `createServer` owns one instance and uses it for the cleanup tool, forced
 * and failed launches, daemon stop and startup rollback.
 */
export class DriverLifecycle {
  readonly #pending = new Set<IPlatformDriver>();

  /**
   * @returns How many drivers still wait for a successful disposal.
   */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Close the app/session before releasing the driver resources it may still
   * use. Disposal also runs when consumer cleanup fails, including partial
   * launches. Previously failed disposals are retried.
   *
   * @param manager - The session manager whose resources should be released.
   * @returns Whether the consumer cleaned up a session.
   */
  async cleanupSession(manager: ISessionManager): Promise<boolean> {
    const driver = manager.getPlatformDriver?.();
    if (driver?.dispose) {
      this.#pending.add(driver);
    }

    const errors: unknown[] = [];
    let cleanedUp = false;
    try {
      cleanedUp = await manager.cleanup();
    } catch (error) {
      errors.push(error);
    }
    for (const pending of [...this.#pending]) {
      try {
        await pending.dispose?.();
        this.#pending.delete(pending);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Session cleanup and driver disposal failed',
      );
    }
    return cleanedUp;
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
