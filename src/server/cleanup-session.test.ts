import { describe, expect, it, vi } from 'vitest';

import { cleanupSession, DriverLifecycle } from './cleanup-session.js';
import type { IPlatformDriver } from '../platform/types.js';
import { createMockSessionManager } from '../tools/test-utils/mock-factories.js';

describe('cleanupSession', () => {
  it('captures the driver before consumer cleanup clears it and disposes afterward', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    let driver = { dispose } as unknown as IPlatformDriver | undefined;
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () => driver;
    vi.spyOn(manager, 'cleanup').mockImplementation(async () => {
      expect(dispose).not.toHaveBeenCalled();
      driver = undefined;
      return true;
    });

    expect(await cleanupSession(manager)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the driver even when consumer cleanup fails', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () =>
      ({ dispose }) as unknown as IPlatformDriver;
    vi.spyOn(manager, 'cleanup').mockRejectedValue(
      new Error('app close failed'),
    );

    await expect(cleanupSession(manager)).rejects.toThrowError(
      'app close failed',
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retries failed disposal even after the consumer has cleared the driver', async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error('dispose failed'))
      .mockResolvedValue(undefined);
    let driver = { dispose } as unknown as IPlatformDriver | undefined;
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () => driver;
    vi.spyOn(manager, 'cleanup').mockImplementation(async () => {
      driver = undefined;
      return true;
    });

    await expect(cleanupSession(manager)).rejects.toThrowError(
      'dispose failed',
    );
    expect(await cleanupSession(manager)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('does not dispose another session manager’s live driver through a shared lifecycle', async () => {
    const lifecycle = new DriverLifecycle();
    const a = createMockSessionManager();
    const b = createMockSessionManager();
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    a.getPlatformDriver = () =>
      ({ dispose: disposeA }) as unknown as IPlatformDriver;
    b.getPlatformDriver = () =>
      ({ dispose: disposeB }) as unknown as IPlatformDriver;

    expect(await lifecycle.cleanupSession(a)).toBe(true);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
    expect(b.cleanup).not.toHaveBeenCalled();

    expect(await lifecycle.cleanupSession(b)).toBe(true);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it('supports managers and drivers without disposal hooks', async () => {
    const manager = createMockSessionManager();
    manager.getPlatformDriver = undefined;
    expect(await cleanupSession(manager)).toBe(true);
  });

  it('reports both failures while still attempting every pending disposal', async () => {
    const dispose = vi.fn().mockRejectedValue(new Error('dispose failed'));
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () =>
      ({ dispose }) as unknown as IPlatformDriver;
    vi.spyOn(manager, 'cleanup').mockRejectedValue(new Error('session failed'));
    await expect(cleanupSession(manager)).rejects.toMatchObject({
      message:
        'Session cleanup and driver disposal failed: session failed; dispose failed',
      errors: [
        expect.objectContaining({ message: 'session failed' }),
        expect.objectContaining({ message: 'dispose failed' }),
      ],
    });
  });

  describe('drivers retained from earlier sessions', () => {
    /**
     * Build a manager whose driver is replaced by each test, and whose
     * cleanup clears the driver like a real consumer does.
     *
     * @returns The manager and a setter for its current driver.
     */
    function sessionWithSwappableDriver(): {
      manager: ReturnType<typeof createMockSessionManager>;
      setDriver: (dispose: () => Promise<void>) => void;
    } {
      let driver: IPlatformDriver | undefined;
      const manager = createMockSessionManager();
      manager.getPlatformDriver = () => driver;
      vi.spyOn(manager, 'cleanup').mockImplementation(async () => {
        driver = undefined;
        return true;
      });
      return {
        manager,
        setDriver: (dispose) => {
          driver = { dispose } as unknown as IPlatformDriver;
        },
      };
    }

    it('retries a stuck older driver without failing later cleanups', async () => {
      const onStaleDisposalError = vi.fn();
      const lifecycle = new DriverLifecycle({ onStaleDisposalError });
      const { manager, setDriver } = sessionWithSwappableDriver();
      const stuck = vi.fn().mockRejectedValue(new Error('stuck companion'));
      setDriver(stuck);

      // The session that owns the stuck driver still reports its failure.
      await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
        'stuck companion',
      );
      expect(lifecycle.pendingCount).toBe(1);
      expect(onStaleDisposalError).not.toHaveBeenCalled();

      for (let attempt = 1; attempt <= 2; attempt++) {
        const healthy = vi.fn().mockResolvedValue(undefined);
        setDriver(healthy);
        expect(await lifecycle.cleanupSession(manager)).toBe(true);
        expect(healthy).toHaveBeenCalledTimes(1);
        expect(stuck).toHaveBeenCalledTimes(1 + attempt);
        expect(onStaleDisposalError).toHaveBeenCalledTimes(attempt);
        expect(lifecycle.pendingCount).toBe(1);
      }
      expect(onStaleDisposalError).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: 'stuck companion' }),
      );
    });

    it('drops an older driver from pending once its retry succeeds', async () => {
      const lifecycle = new DriverLifecycle();
      const { manager, setDriver } = sessionWithSwappableDriver();
      const flaky = vi
        .fn()
        .mockRejectedValueOnce(new Error('stuck companion'))
        .mockResolvedValue(undefined);
      setDriver(flaky);
      await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
        'stuck companion',
      );

      setDriver(vi.fn().mockResolvedValue(undefined));
      expect(await lifecycle.cleanupSession(manager)).toBe(true);
      expect(flaky).toHaveBeenCalledTimes(2);
      expect(lifecycle.pendingCount).toBe(0);

      expect(await lifecycle.cleanupSession(manager)).toBe(true);
      expect(flaky).toHaveBeenCalledTimes(2);
    });

    it('still fails the call for the current driver when an older driver is stuck', async () => {
      const lifecycle = new DriverLifecycle();
      const { manager, setDriver } = sessionWithSwappableDriver();
      setDriver(vi.fn().mockRejectedValue(new Error('stuck companion')));
      await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
        'stuck companion',
      );

      setDriver(vi.fn().mockRejectedValue(new Error('current dispose failed')));
      await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
        new Error('current dispose failed'),
      );
      expect(lifecycle.pendingCount).toBe(2);
    });

    it('disposes a current driver that is also pending only once per call', async () => {
      const lifecycle = new DriverLifecycle();
      const dispose = vi
        .fn()
        .mockRejectedValueOnce(new Error('dispose failed'))
        .mockResolvedValue(undefined);
      const driver = { dispose } as unknown as IPlatformDriver;
      const manager = createMockSessionManager();
      // The consumer keeps exposing the same driver after a failed attempt.
      manager.getPlatformDriver = () => driver;

      await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
        'dispose failed',
      );
      expect(await lifecycle.cleanupSession(manager)).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(lifecycle.pendingCount).toBe(0);
    });

    it('retries older drivers in parallel', async () => {
      const lifecycle = new DriverLifecycle();
      const { manager, setDriver } = sessionWithSwappableDriver();
      const resolvers: (() => void)[] = [];
      let deferRetries = false;
      const olderDisposals = [1, 2].map(() =>
        vi.fn(async () => {
          if (!deferRetries) {
            throw new Error('stuck companion');
          }
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        }),
      );
      for (const dispose of olderDisposals) {
        setDriver(dispose);
        await expect(lifecycle.cleanupSession(manager)).rejects.toThrowError(
          'stuck companion',
        );
      }
      expect(lifecycle.pendingCount).toBe(2);
      olderDisposals.forEach((dispose) => dispose.mockClear());

      deferRetries = true;
      setDriver(vi.fn().mockResolvedValue(undefined));
      const pending = lifecycle.cleanupSession(manager);
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      // Both retries started before either one settled.
      for (const dispose of olderDisposals) {
        expect(dispose).toHaveBeenCalledTimes(1);
      }
      resolvers.forEach((resolve) => resolve());
      expect(await pending).toBe(true);
      expect(lifecycle.pendingCount).toBe(0);
    });
  });

  it('retains failed disposals across per-request wrappers of one manager', async () => {
    // The daemon hands each request a new wrapper (a Proxy on the stack) of
    // the same session manager. Retention must not depend on that identity.
    const lifecycle = new DriverLifecycle();
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error('dispose failed'))
      .mockResolvedValue(undefined);
    let driver = { dispose } as unknown as IPlatformDriver | undefined;
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () => driver;
    vi.spyOn(manager, 'cleanup').mockImplementation(async () => {
      driver = undefined;
      return true;
    });
    const wrap = (): typeof manager => new Proxy(manager, {});

    await expect(lifecycle.cleanupSession(wrap())).rejects.toThrowError(
      'dispose failed',
    );
    expect(lifecycle.pendingCount).toBe(1);
    expect(await lifecycle.cleanupSession(wrap())).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(lifecycle.pendingCount).toBe(0);
  });

  it('uses the given lifecycle instead of the per-manager fallback', async () => {
    const lifecycle = new DriverLifecycle();
    const dispose = vi.fn().mockRejectedValueOnce(new Error('dispose failed'));
    const manager = createMockSessionManager();
    manager.getPlatformDriver = () =>
      ({ dispose }) as unknown as IPlatformDriver;

    await expect(cleanupSession(manager, lifecycle)).rejects.toThrowError(
      'dispose failed',
    );
    expect(lifecycle.pendingCount).toBe(1);
  });
});
