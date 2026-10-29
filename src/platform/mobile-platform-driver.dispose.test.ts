import type { DeviceBackend } from '@metamask/device-mcp';
import { describe, expect, it, vi } from 'vitest';

import { MobilePlatformDriver } from './mobile-platform-driver.js';

describe('MobilePlatformDriver disposal', () => {
  it('disposes only its own backend once across concurrent and repeated calls', async () => {
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    const a = new MobilePlatformDriver({
      platform: 'ios',
      dispose: disposeA,
    } as unknown as DeviceBackend);
    const b = new MobilePlatformDriver({
      platform: 'ios',
      dispose: disposeB,
    } as unknown as DeviceBackend);
    await Promise.all([a.dispose(), a.dispose()]);
    await a.dispose();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
    await b.dispose();
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it('completes for backends without a disposal hook', async () => {
    const driver = new MobilePlatformDriver({
      platform: 'ios',
    } as DeviceBackend);
    expect(await driver.dispose()).toBeUndefined();
  });

  it('allows a retry after failed disposal', async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue(undefined);
    const driver = new MobilePlatformDriver({
      platform: 'ios',
      dispose,
    } as unknown as DeviceBackend);
    await expect(driver.dispose()).rejects.toThrowError('failed');
    await driver.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
