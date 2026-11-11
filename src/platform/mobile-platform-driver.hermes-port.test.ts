import type { DeviceBackend } from '@metamask/device-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runHermesCdp: vi.fn(),
  HermesClient: vi.fn(),
  hasHermesClient: true,
}));

// Uses the real `HermesSession` of device-mcp, so the port precedence is
// exercised end to end (per call > driver default > env > 8081).
vi.mock('./device-mcp-runtime.js', async () => {
  const actual = await import('@metamask/device-mcp');
  return {
    loadDeviceMcp: async () => ({
      ...actual,
      runHermesCdp: mocks.runHermesCdp,
      HermesClient: mocks.hasHermesClient ? mocks.HermesClient : undefined,
    }),
  };
});

// Imported AFTER vi.mock so the driver binds to the mocked device-mcp runtime.
const { MobilePlatformDriver } = await import('./mobile-platform-driver.js');

function createBackend(): DeviceBackend {
  return { platform: 'ios' } as unknown as DeviceBackend;
}

type HermesClientStub = {
  metroPort: number;
  appId: string;
  isConnected: boolean;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type HermesClientOptions = {
  metroPort: number;
  appId: string;
  pinnedDeviceId?: string;
  onPin?: (logicalDeviceId: string) => void;
};

const clients: HermesClientStub[] = [];

describe('MobilePlatformDriver Hermes port precedence', () => {
  beforeEach(() => {
    clients.length = 0;
    mocks.hasHermesClient = true;
    mocks.runHermesCdp.mockResolvedValue({ ok: true, result: { value: 2 } });
    mocks.HermesClient.mockImplementation(function (
      this: unknown,
      options: HermesClientOptions,
    ): HermesClientStub {
      const client: HermesClientStub = {
        metroPort: options.metroPort,
        appId: options.appId,
        isConnected: false,
        send: vi.fn().mockResolvedValue({ ok: true, result: { value: 2 } }),
        close: vi.fn(),
      };
      clients.push(client);
      return client;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { name: 'the 8081 default', expected: 8081, persistent: true },
    {
      name: 'HERMES_METRO_PORT',
      env: '8099',
      expected: 8099,
      persistent: true,
    },
    {
      name: 'the driver option over the env',
      env: '8099',
      option: 8085,
      expected: 8085,
      persistent: true,
    },
    {
      name: 'a per-call metroPort over the driver option',
      env: '8099',
      option: 8085,
      perCall: 8087,
      expected: 8087,
      persistent: false,
    },
    {
      name: 'a per-call metroPort over the env',
      env: '8099',
      perCall: 8087,
      expected: 8087,
      persistent: false,
    },
  ])(
    'uses $name',
    async ({
      env,
      option,
      perCall,
      expected,
      persistent,
    }: {
      env?: string;
      option?: number;
      perCall?: number;
      expected: number;
      persistent: boolean;
    }) => {
      if (env !== undefined) {
        vi.stubEnv('HERMES_METRO_PORT', env);
      }
      const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
        ...(option === undefined ? {} : { metroPort: option }),
      });

      await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: 30_000,
        ...(perCall === undefined ? {} : { metroPort: perCall }),
      });

      if (persistent) {
        expect(mocks.HermesClient).toHaveBeenCalledTimes(1);
        expect(mocks.HermesClient.mock.calls[0][0]).toMatchObject({
          metroPort: expected,
        });
        expect(mocks.runHermesCdp).not.toHaveBeenCalled();
      } else {
        expect(mocks.HermesClient).not.toHaveBeenCalled();
        expect(mocks.runHermesCdp.mock.calls[0][0]).toMatchObject({
          metroPort: expected,
        });
      }
    },
  );

  it('names the Metro port the call used in an error', async () => {
    mocks.runHermesCdp.mockResolvedValue({
      ok: false,
      code: 'HERMES_TARGET_NOT_FOUND',
      message: 'No Hermes debug target found',
    });
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
      metroPort: 8087,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(mocks.runHermesCdp.mock.calls[0][0]).toMatchObject({
        metroPort: 8087,
      });
      expect(outcome.message).toContain('Metro port 8087');
    }
  });

  it('keeps the device pin across calls and a recreated client', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    const first = mocks.HermesClient.mock.calls[0][0] as HermesClientOptions;
    first.onPin?.('device-1');

    driver.setHermesDefaults({ metroPort: 8086 });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.HermesClient).toHaveBeenCalledTimes(2);
    expect(mocks.HermesClient.mock.calls[1][0]).toMatchObject({
      metroPort: 8086,
      pinnedDeviceId: 'device-1',
    });
  });
});
