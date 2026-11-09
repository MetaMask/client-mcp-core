import type { DeviceBackend } from '@metamask/device-mcp';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runHermesCdp: vi.fn(),
  fetchDiscoveryTargets: vi.fn(),
  selectHermesTarget: vi.fn(),
  hasAmbiguousTarget: vi.fn(),
  resolve: vi.fn(),
  getPinnedHermesDeviceId: vi.fn(),
  setPinnedHermesDeviceId: vi.fn(),
  HermesSession: vi.fn(),
  HermesClient: vi.fn(),
  // device-mcp 0.7.0 has no HermesClient; only the tests that exercise the
  // persistent client enable it.
  hasHermesClient: false,
}));

// The driver loads device-mcp on first use through this module.
vi.mock('./device-mcp-runtime.js', () => ({
  loadDeviceMcp: async () => ({
    runHermesCdp: mocks.runHermesCdp,
    fetchDiscoveryTargets: mocks.fetchDiscoveryTargets,
    selectHermesTarget: mocks.selectHermesTarget,
    hasAmbiguousTarget: mocks.hasAmbiguousTarget,
    LEGACY_SYNTHETIC_TITLE:
      'React Native Experimental (Improved Chrome Reloads)',
    HermesSession: mocks.HermesSession,
    ...(mocks.hasHermesClient ? { HermesClient: mocks.HermesClient } : {}),
  }),
}));

// Imported AFTER vi.mock so the driver binds to the mocked device-mcp runtime.
const { MobilePlatformDriver } = await import('./mobile-platform-driver.js');

function createBackend(
  platform: 'ios' | 'android' = 'android',
  overrides: Partial<DeviceBackend> = {},
): DeviceBackend {
  return { platform, ...overrides } as unknown as DeviceBackend;
}

describe('MobilePlatformDriver hermes delegation', () => {
  beforeEach(() => {
    mocks.hasHermesClient = false;
    mocks.HermesSession.mockImplementation(() => ({
      resolve: mocks.resolve,
      getPinnedHermesDeviceId: mocks.getPinnedHermesDeviceId,
      setPinnedHermesDeviceId: mocks.setPinnedHermesDeviceId,
    }));
    mocks.resolve.mockReturnValue({
      metroPort: 8081,
      appId: 'io.metamask',
      pinnedDeviceId: undefined,
    });
    mocks.getPinnedHermesDeviceId.mockReturnValue(undefined);
  });

  describe('session scoping', () => {
    it('owns an instance-scoped Hermes session instead of the process singleton', async () => {
      mocks.runHermesCdp.mockResolvedValue({ ok: true, result: {} });
      const iosDriver = new MobilePlatformDriver(createBackend('ios'));
      const androidDriver = new MobilePlatformDriver(createBackend('android'));

      expect(iosDriver.getPlatform()).toBe('ios');
      expect(androidDriver.getPlatform()).toBe('android');
      // Created on first use (device-mcp is loaded lazily), once per driver.
      expect(mocks.HermesSession).not.toHaveBeenCalled();

      await iosDriver.cdp({ method: 'Runtime.evaluate', timeoutMs: 1000 });
      await iosDriver.cdp({ method: 'Runtime.evaluate', timeoutMs: 1000 });
      await androidDriver.cdp({ method: 'Runtime.evaluate', timeoutMs: 1000 });

      expect(mocks.HermesSession).toHaveBeenCalledTimes(2);
      expect(mocks.HermesSession).toHaveBeenNthCalledWith(1, {
        platform: 'ios',
      });
      expect(mocks.HermesSession).toHaveBeenNthCalledWith(2, {
        platform: 'android',
      });
    });

    it('creates one session when first calls run concurrently', async () => {
      mocks.runHermesCdp.mockResolvedValue({ ok: true, result: {} });
      const driver = new MobilePlatformDriver(createBackend('ios'));

      await Promise.all([
        driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 1000 }),
        driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 1000 }),
      ]);

      expect(mocks.HermesSession).toHaveBeenCalledTimes(1);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('cdp', () => {
    it('resolves with the backend platform and delegates to runHermesCdp', async () => {
      mocks.runHermesCdp.mockResolvedValue({ ok: true, result: { value: 2 } });
      const driver = new MobilePlatformDriver(createBackend('android'));

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        timeoutMs: 30_000,
      });

      expect(mocks.resolve).toHaveBeenCalledWith({
        metroPort: undefined,
        appId: undefined,
        platform: 'android',
      });
      expect(mocks.runHermesCdp).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'Runtime.evaluate',
          params: { expression: '1+1' },
          timeoutMs: 30_000,
          metroPort: 8081,
          appId: 'io.metamask',
          pinnedDeviceId: undefined,
        }),
      );
      expect(outcome).toStrictEqual({ ok: true, result: { value: 2 } });
    });

    it('persists the device pin via onPin when none is set', async () => {
      mocks.runHermesCdp.mockImplementation(async (input) => {
        input.onPin?.('device-42');
        return { ok: true, result: null };
      });
      const driver = new MobilePlatformDriver(createBackend());

      await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

      expect(mocks.setPinnedHermesDeviceId).toHaveBeenCalledWith('device-42');
    });

    it('does not overwrite an existing device pin', async () => {
      mocks.getPinnedHermesDeviceId.mockReturnValue('device-existing');
      mocks.runHermesCdp.mockImplementation(async (input) => {
        input.onPin?.('device-new');
        return { ok: true, result: null };
      });
      const driver = new MobilePlatformDriver(createBackend());

      await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

      expect(mocks.setPinnedHermesDeviceId).not.toHaveBeenCalled();
    });

    it('maps the Hermes blocked-method code to MM_CDP_BLOCKED', async () => {
      mocks.runHermesCdp.mockResolvedValue({
        ok: false,
        code: 'HERMES_BLOCKED_METHOD',
        message:
          'CDP method "Runtime.terminateExecution" is blocked for safety.',
      });
      const driver = new MobilePlatformDriver(createBackend());

      const outcome = await driver.cdp({
        method: 'Runtime.terminateExecution',
        timeoutMs: 30_000,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_CDP_BLOCKED');
        expect(outcome.message).toContain('HERMES_BLOCKED_METHOD');
      }
    });

    it('maps other Hermes failures to MM_CDP_FAILED and preserves the HERMES_* code', async () => {
      mocks.runHermesCdp.mockResolvedValue({
        ok: false,
        code: 'HERMES_TARGET_NOT_FOUND',
        message: 'No Hermes debug target found for appId io.metamask',
      });
      const driver = new MobilePlatformDriver(createBackend());

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: 30_000,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_CDP_FAILED');
        expect(outcome.message).toContain('HERMES_TARGET_NOT_FOUND');
      }
    });
  });

  describe('hermesTargets', () => {
    it('reports the chosen target on successful selection', async () => {
      const target = {
        id: 'page-1',
        title: 'MetaMask',
        appId: 'io.metamask',
        webSocketDebuggerUrl: 'ws://localhost:8081/x',
        reactNative: {
          logicalDeviceId: 'dev-1',
          capabilities: { nativePageReloads: true },
        },
      };
      mocks.fetchDiscoveryTargets.mockResolvedValue([target]);
      mocks.selectHermesTarget.mockReturnValue({ ok: true, target });
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({});

      expect(result.metroDown).toBe(false);
      expect(result.targetsDiscovered).toBe(1);
      expect(result.candidates).toStrictEqual([
        {
          id: 'page-1',
          title: 'MetaMask',
          appId: 'io.metamask',
          logicalDeviceId: 'dev-1',
          nativePageReloads: true,
          webSocketDebuggerUrl: 'ws://localhost:8081/x',
        },
      ]);
      expect(result.chosen).toStrictEqual({
        id: 'page-1',
        logicalDeviceId: 'dev-1',
      });
    });

    it('returns metroDown when discovery fails with a connection error', async () => {
      mocks.fetchDiscoveryTargets.mockRejectedValue(
        new Error('fetch failed: ECONNREFUSED'),
      );
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({});

      expect(result.metroDown).toBe(true);
      expect(result.targetsDiscovered).toBe(0);
      expect(result.candidates).toStrictEqual([]);
    });

    it('rethrows non-connection discovery errors', async () => {
      mocks.fetchDiscoveryTargets.mockRejectedValue(new Error('boom'));
      const driver = new MobilePlatformDriver(createBackend());

      await expect(driver.hermesTargets({})).rejects.toThrowError('boom');
    });

    it('reports ambiguity when selection fails with HERMES_MULTIPLE_DEVICES', async () => {
      const targets = [
        {
          appId: 'io.metamask',
          webSocketDebuggerUrl: 'ws://localhost:8081/a',
          reactNative: { logicalDeviceId: 'dev-1' },
        },
        {
          appId: 'io.metamask',
          webSocketDebuggerUrl: 'ws://localhost:8081/b',
          reactNative: { logicalDeviceId: 'dev-2' },
        },
      ];
      mocks.fetchDiscoveryTargets.mockResolvedValue(targets);
      mocks.selectHermesTarget.mockReturnValue({
        ok: false,
        code: 'HERMES_MULTIPLE_DEVICES',
        message: 'Ambiguous Hermes target',
      });
      mocks.hasAmbiguousTarget.mockReturnValue(true);
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({});

      expect(result.ambiguous).toBe('Ambiguous Hermes target');
      expect(result.chosen).toBeUndefined();
    });

    it('reports noTargetReason for other selection failures', async () => {
      mocks.fetchDiscoveryTargets.mockResolvedValue([]);
      mocks.selectHermesTarget.mockReturnValue({
        ok: false,
        code: 'HERMES_TARGET_NOT_FOUND',
        message: 'No Hermes debug target found',
      });
      mocks.hasAmbiguousTarget.mockReturnValue(false);
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({});

      expect(result.noTargetReason).toStrictEqual({
        code: 'HERMES_TARGET_NOT_FOUND',
        message: 'No Hermes debug target found',
      });
    });

    it('bypasses the appId filter when all is set', async () => {
      const targets = [
        { appId: 'other.app', webSocketDebuggerUrl: 'ws://localhost:8081/a' },
      ];
      mocks.fetchDiscoveryTargets.mockResolvedValue(targets);
      mocks.selectHermesTarget.mockReturnValue({
        ok: false,
        code: 'HERMES_TARGET_NOT_FOUND',
        message: 'No Hermes debug target found',
      });
      mocks.hasAmbiguousTarget.mockReturnValue(false);
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({ all: true });

      expect(result.filterBypassed).toBe(true);
      expect(result.candidates).toHaveLength(1);
    });

    it('uses appId-filtered candidates for ambiguity when all targets are displayed', async () => {
      const matchingTargets = [
        {
          id: 'page-1',
          title: 'MetaMask',
          appId: 'io.metamask',
          webSocketDebuggerUrl: 'ws://localhost:8081/a',
          reactNative: { logicalDeviceId: 'dev-1' },
        },
        {
          id: 'page-2',
          title: 'MetaMask',
          appId: 'io.metamask',
          webSocketDebuggerUrl: 'ws://localhost:8081/b',
          reactNative: { logicalDeviceId: 'dev-2' },
        },
      ];
      const otherAppTarget = {
        id: 'page-3',
        title: 'Other App',
        appId: 'other.app',
        webSocketDebuggerUrl: 'ws://localhost:8081/c',
        reactNative: { logicalDeviceId: 'dev-3' },
      };
      const targets = [...matchingTargets, otherAppTarget];
      mocks.fetchDiscoveryTargets.mockResolvedValue(targets);
      mocks.selectHermesTarget.mockReturnValue({
        ok: false,
        code: 'HERMES_MULTIPLE_DEVICES',
        message: 'Ambiguous Hermes target',
      });
      mocks.hasAmbiguousTarget.mockImplementation(
        (candidates) =>
          candidates.length === 2 &&
          candidates.every((target) => target.appId === 'io.metamask'),
      );
      const driver = new MobilePlatformDriver(createBackend());

      const result = await driver.hermesTargets({ all: true });

      expect(result.candidates.map(({ appId }) => appId)).toStrictEqual([
        'io.metamask',
        'io.metamask',
        'other.app',
      ]);
      expect(result.ambiguous).toBe('Ambiguous Hermes target');
      expect(mocks.selectHermesTarget).toHaveBeenCalledWith(
        targets,
        'io.metamask',
        undefined,
      );
      expect(mocks.hasAmbiguousTarget).toHaveBeenCalledWith(matchingTargets);
    });
  });
});

describe('MobilePlatformDriver webview cdp routing', () => {
  beforeEach(() => {
    mocks.hasHermesClient = false;
    mocks.HermesSession.mockImplementation(() => ({
      resolve: mocks.resolve,
      getPinnedHermesDeviceId: mocks.getPinnedHermesDeviceId,
      setPinnedHermesDeviceId: mocks.setPinnedHermesDeviceId,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes target "android-webview" to backend.webviewCdp and NOT Hermes', async () => {
    const webviewCdp = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { value: 'clicked' } });
    const driver = new MobilePlatformDriver(
      createBackend('android', { webviewCdp }),
    );

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      params: { expression: "document.querySelector('#x').click()" },
      timeoutMs: 30_000,
      target: 'android-webview',
      urlFilter: 'test-dapp',
    });

    expect(outcome).toStrictEqual({ ok: true, result: { value: 'clicked' } });
    expect(webviewCdp).toHaveBeenCalledWith({
      method: 'Runtime.evaluate',
      params: { expression: "document.querySelector('#x').click()" },
      timeoutMs: 30_000,
      urlFilter: 'test-dapp',
    });
    expect(mocks.runHermesCdp).not.toHaveBeenCalled();
  });

  it('defaults to the Hermes path when target is omitted', async () => {
    mocks.resolve.mockReturnValue({
      metroPort: 8081,
      appId: 'io.metamask',
      pinnedDeviceId: undefined,
    });
    mocks.getPinnedHermesDeviceId.mockReturnValue(undefined);
    mocks.runHermesCdp.mockResolvedValue({ ok: true, result: { value: 2 } });
    const webviewCdp = vi.fn();
    const driver = new MobilePlatformDriver(
      createBackend('android', { webviewCdp }),
    );

    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(mocks.runHermesCdp).toHaveBeenCalledTimes(1);
    expect(webviewCdp).not.toHaveBeenCalled();
  });

  it.each(['page', 'sw'] as const)(
    'rejects the browser-only target %s with MM_INVALID_INPUT',
    async (target) => {
      const webviewCdp = vi.fn();
      const driver = new MobilePlatformDriver(
        createBackend('android', { webviewCdp }),
      );

      const outcome = await driver.cdp({
        method: 'Runtime.evaluate',
        timeoutMs: 30_000,
        target,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('MM_INVALID_INPUT');
        expect(outcome.message).toContain(target);
        expect(outcome.message).toContain(
          'Mobile targets: hermes, android-webview',
        );
      }
      expect(webviewCdp).not.toHaveBeenCalled();
      expect(mocks.runHermesCdp).not.toHaveBeenCalled();
    },
  );

  it('maps the WebView blocked-method code to MM_CDP_BLOCKED', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({
      ok: false,
      code: 'WEBVIEW_BLOCKED_METHOD',
      message: 'blocked',
    });
    const driver = new MobilePlatformDriver(
      createBackend('android', { webviewCdp }),
    );

    const outcome = await driver.cdp({
      method: 'Browser.close',
      timeoutMs: 30_000,
      target: 'android-webview',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('MM_CDP_BLOCKED');
      expect(outcome.message).toContain('WEBVIEW_BLOCKED_METHOD');
    }
  });

  it('maps other WebView failures to MM_CDP_FAILED', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({
      ok: false,
      code: 'WEBVIEW_TARGET_NOT_FOUND',
      message: 'no page',
    });
    const driver = new MobilePlatformDriver(
      createBackend('android', { webviewCdp }),
    );

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
      target: 'android-webview',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('MM_CDP_FAILED');
      expect(outcome.message).toContain('WEBVIEW_TARGET_NOT_FOUND');
    }
  });

  it('returns MM_CDP_FAILED when the backend lacks webviewCdp support', async () => {
    const driver = new MobilePlatformDriver(createBackend('android'));

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
      target: 'android-webview',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('MM_CDP_FAILED');
      expect(outcome.message).toContain('WebView CDP is not available');
    }
  });
});

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

describe('MobilePlatformDriver persistent Hermes client', () => {
  const clients: HermesClientStub[] = [];

  beforeEach(() => {
    clients.length = 0;
    mocks.hasHermesClient = true;
    mocks.HermesSession.mockImplementation(() => ({
      resolve: mocks.resolve,
      getPinnedHermesDeviceId: mocks.getPinnedHermesDeviceId,
      setPinnedHermesDeviceId: mocks.setPinnedHermesDeviceId,
    }));
    mocks.resolve.mockImplementation(
      ({ metroPort, appId }: { metroPort?: number; appId?: string }) => ({
        metroPort: metroPort ?? 8081,
        appId: appId ?? 'io.metamask',
        pinnedDeviceId: mocks.getPinnedHermesDeviceId(),
      }),
    );
    mocks.getPinnedHermesDeviceId.mockReturnValue(undefined);
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
    mocks.hasHermesClient = false;
  });

  it('creates one client for the session port and reuses it across calls', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    await driver.cdp({
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      timeoutMs: 30_000,
    });
    await driver.cdp({
      method: 'Runtime.evaluate',
      params: { expression: '2+2' },
      timeoutMs: 30_000,
    });

    expect(mocks.HermesClient).toHaveBeenCalledTimes(1);
    expect(mocks.HermesClient).toHaveBeenCalledWith({
      metroPort: 8085,
      appId: 'io.metamask',
      pinnedDeviceId: undefined,
      onPin: expect.any(Function),
    });
    expect(clients[0].send).toHaveBeenCalledTimes(2);
    expect(mocks.runHermesCdp).not.toHaveBeenCalled();
  });

  it('uses a one-shot call for a per-call metroPort and keeps the session client', async () => {
    mocks.runHermesCdp.mockResolvedValue({ ok: true, result: { value: 2 } });
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
      metroPort: 8087,
    });

    expect(mocks.HermesClient).not.toHaveBeenCalled();
    expect(mocks.runHermesCdp).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8087, appId: 'io.metamask' }),
    );

    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(mocks.HermesClient).toHaveBeenCalledTimes(1);
    expect(mocks.HermesClient).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8085 }),
    );
    expect(mocks.runHermesCdp).toHaveBeenCalledTimes(1);
  });

  it('uses a one-shot call for a per-call appId and keeps the session client', async () => {
    mocks.runHermesCdp.mockResolvedValue({ ok: true, result: null });
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
      appId: 'app.session',
    });

    await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
      appId: 'app.other',
    });

    expect(mocks.HermesClient).not.toHaveBeenCalled();
    expect(mocks.runHermesCdp).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8085, appId: 'app.other' }),
    );

    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(mocks.HermesClient).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8085, appId: 'app.session' }),
    );
  });

  it('persists the pin the client resolved on its first probe', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    const options = mocks.HermesClient.mock.calls[0][0] as HermesClientOptions;
    options.onPin?.('device-9');

    expect(mocks.setPinnedHermesDeviceId).toHaveBeenCalledWith('device-9');
  });

  it('creates the client with the pin the session already keeps', async () => {
    mocks.getPinnedHermesDeviceId.mockReturnValue('device-7');
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(mocks.HermesClient).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedDeviceId: 'device-7' }),
    );
  });

  it('does not overwrite an existing pin from the client probe', async () => {
    mocks.getPinnedHermesDeviceId.mockReturnValue('device-existing');
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    const options = mocks.HermesClient.mock.calls[0][0] as HermesClientOptions;
    options.onPin?.('device-new');

    expect(mocks.setPinnedHermesDeviceId).not.toHaveBeenCalled();
  });

  it('applies the launch defaults set after the driver is created', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    driver.setHermesDefaults({ metroPort: 8086, deviceId: 'device-launch' });

    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(mocks.HermesClient).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8086 }),
    );
  });

  it('drops the client when setHermesDefaults changes the session target', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    driver.setHermesDefaults({ metroPort: 8086 });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.HermesClient).toHaveBeenCalledTimes(2);
    expect(mocks.HermesClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ metroPort: 8086 }),
    );
  });

  it('keeps the client when setHermesDefaults only reports the device', async () => {
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    driver.setHermesDefaults({ deviceId: 'device-launch' });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    expect(clients[0].close).not.toHaveBeenCalled();
    expect(mocks.HermesClient).toHaveBeenCalledTimes(1);
  });

  it('closes the client on dispose', async () => {
    const disposeBackend = vi.fn().mockResolvedValue(undefined);
    const driver = new MobilePlatformDriver(
      createBackend('ios', { dispose: disposeBackend }),
      'io.metamask',
      { metroPort: 8085 },
    );
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });

    await driver.dispose();
    await driver.dispose();

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(disposeBackend).toHaveBeenCalledTimes(1);
  });

  it('names the Metro port in a failure', async () => {
    mocks.HermesClient.mockImplementation(function (
      this: unknown,
      options: HermesClientOptions,
    ): HermesClientStub {
      const client: HermesClientStub = {
        metroPort: options.metroPort,
        appId: options.appId,
        isConnected: false,
        send: vi.fn().mockResolvedValue({
          ok: false,
          code: 'HERMES_TARGET_NOT_FOUND',
          message: 'No Hermes debug target found',
        }),
        close: vi.fn(),
      };
      clients.push(client);
      return client;
    });
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('MM_CDP_FAILED');
      expect(outcome.message).toContain('HERMES_TARGET_NOT_FOUND');
      expect(outcome.message).toContain('Metro port 8085');
    }
  });

  it('falls back to the one-shot path when device-mcp has no HermesClient', async () => {
    mocks.hasHermesClient = false;
    mocks.runHermesCdp.mockResolvedValue({ ok: true, result: { value: 2 } });
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    const outcome = await driver.cdp({
      method: 'Runtime.evaluate',
      timeoutMs: 30_000,
    });

    expect(outcome).toStrictEqual({ ok: true, result: { value: 2 } });
    expect(mocks.HermesClient).not.toHaveBeenCalled();
    expect(mocks.runHermesCdp).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8085 }),
    );
  });

  it('reports the session port, pin, connection and device in hermes-targets', async () => {
    const target = {
      id: 'page-1',
      title: 'MetaMask',
      appId: 'io.metamask',
      webSocketDebuggerUrl: 'ws://localhost:8085/x',
      reactNative: { logicalDeviceId: 'dev-1' },
    };
    mocks.fetchDiscoveryTargets.mockResolvedValue([target]);
    mocks.selectHermesTarget.mockReturnValue({ ok: true, target });
    mocks.getPinnedHermesDeviceId.mockReturnValue('dev-1');
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
      deviceId: 'device-launch',
    });
    await driver.cdp({ method: 'Runtime.evaluate', timeoutMs: 30_000 });
    clients[0].isConnected = true;

    const result = await driver.hermesTargets({});

    expect(result).toMatchObject({
      metroPort: 8085,
      sessionMetroPort: 8085,
      pinnedDeviceId: 'dev-1',
      connected: true,
      deviceId: 'device-launch',
    });
    expect(mocks.fetchDiscoveryTargets).toHaveBeenCalledWith(
      8085,
      expect.any(Number),
    );
  });

  it('reports the session port when a per-call metroPort overrides the report', async () => {
    mocks.fetchDiscoveryTargets.mockRejectedValue(new Error('fetch failed'));
    const driver = new MobilePlatformDriver(createBackend(), 'io.metamask', {
      metroPort: 8085,
    });

    const result = await driver.hermesTargets({ metroPort: 8087 });

    expect(result.metroPort).toBe(8087);
    expect(result.sessionMetroPort).toBe(8085);
    expect(result.metroDown).toBe(true);
    expect(result.connected).toBe(false);
  });
});
