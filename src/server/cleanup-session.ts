import type { ISessionManager } from './session-manager.js';
import type { IPlatformDriver } from '../platform/types.js';

// A consumer can clear its driver during cleanup before disposal fails. Retain
// that driver for a subsequent cleanup attempt rather than leaking its resources.
const pendingDrivers = new WeakMap<ISessionManager, Set<IPlatformDriver>>();

/**
 * Close the app/session before releasing the driver resources it may still use.
 * Disposal also runs when consumer cleanup fails, including partial launches.
 *
 * @param manager - The session manager whose resources should be released.
 * @returns Whether the consumer cleaned up a session.
 */
export async function cleanupSession(
  manager: ISessionManager,
): Promise<boolean> {
  const drivers = pendingDrivers.get(manager) ?? new Set<IPlatformDriver>();
  const driver = manager.getPlatformDriver?.();
  if (driver?.dispose) {
    drivers.add(driver);
  }
  pendingDrivers.set(manager, drivers);

  const errors: unknown[] = [];
  let cleanedUp = false;
  try {
    cleanedUp = await manager.cleanup();
  } catch (error) {
    errors.push(error);
  }
  for (const pending of drivers) {
    try {
      await pending.dispose?.();
      drivers.delete(pending);
    } catch (error) {
      errors.push(error);
    }
  }
  if (drivers.size === 0) {
    pendingDrivers.delete(manager);
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
