import { describe, expect, it, vi } from 'vitest';

import { cleanupSession } from './cleanup-session.js';
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

  it('does not dispose another session manager’s driver', async () => {
    const a = createMockSessionManager();
    const b = createMockSessionManager();
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    a.getPlatformDriver = () =>
      ({ dispose: disposeA }) as unknown as IPlatformDriver;
    b.getPlatformDriver = () =>
      ({ dispose: disposeB }) as unknown as IPlatformDriver;

    await cleanupSession(a);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
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
      errors: [
        expect.objectContaining({ message: 'session failed' }),
        expect.objectContaining({ message: 'dispose failed' }),
      ],
    });
  });
});
