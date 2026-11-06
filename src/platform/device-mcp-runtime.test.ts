import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadDeviceMcp,
  resetDeviceMcpForTesting,
} from './device-mcp-runtime.js';

const loaded = vi.hoisted(() => ({ deviceMcp: false }));

// Runs only if some module imports device-mcp at load time.
vi.mock('@metamask/device-mcp', async (importOriginal) => {
  loaded.deviceMcp = true;
  return importOriginal();
});

describe('device-mcp runtime loading', () => {
  beforeEach(() => {
    resetDeviceMcpForTesting();
  });

  it('does not load device-mcp when the package entry point is imported', async () => {
    const core = await import('..');

    expect(core.MobilePlatformDriver).toBeDefined();
    expect(core.PlaywrightPlatformDriver).toBeDefined();
    expect(loaded.deviceMcp).toBe(false);
  });

  it('loads device-mcp once, on first use', async () => {
    const cjsRequire = vi.fn(require) as unknown as NodeJS.Require;

    const first = await loadDeviceMcp(cjsRequire);
    const second = await loadDeviceMcp(cjsRequire);

    expect(first).toBe(second);
    expect(cjsRequire).toHaveBeenCalledTimes(1);
    expect(cjsRequire).toHaveBeenCalledWith('@metamask/device-mcp');
    expect(typeof first.HermesSession).toBe('function');
    expect(typeof first.generateLocators).toBe('function');
  });

  it('uses the module require by default (CommonJS build)', async () => {
    const runtime = await loadDeviceMcp();

    expect(typeof runtime.HermesSession).toBe('function');
  });

  it('uses import() when there is no CommonJS require (ESM build)', async () => {
    const runtime = await loadDeviceMcp(null);

    expect(typeof runtime.HermesSession).toBe('function');
  });
});
