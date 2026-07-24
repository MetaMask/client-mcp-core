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
}));

vi.mock('@metamask/device-mcp', () => ({
  runHermesCdp: mocks.runHermesCdp,
  fetchDiscoveryTargets: mocks.fetchDiscoveryTargets,
  selectHermesTarget: mocks.selectHermesTarget,
  hasAmbiguousTarget: mocks.hasAmbiguousTarget,
  LEGACY_SYNTHETIC_TITLE: 'React Native Experimental (Improved Chrome Reloads)',
  HermesSession: mocks.HermesSession,
}));

// Imported AFTER vi.mock so the driver binds to the mocked device-mcp runtime.
const { MobilePlatformDriver } = await import('./mobile-platform-driver.js');

function createBackend(platform: 'ios' | 'android' = 'android'): DeviceBackend {
  return { platform } as unknown as DeviceBackend;
}

describe('MobilePlatformDriver hermes delegation', () => {
  beforeEach(() => {
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
    it('owns an instance-scoped Hermes session instead of the process singleton', () => {
      const iosDriver = new MobilePlatformDriver(createBackend('ios'));
      const androidDriver = new MobilePlatformDriver(createBackend('android'));

      expect(iosDriver.getPlatform()).toBe('ios');
      expect(androidDriver.getPlatform()).toBe('android');
      expect(mocks.HermesSession).toHaveBeenCalledTimes(2);
      expect(mocks.HermesSession).toHaveBeenNthCalledWith(1, {
        platform: 'ios',
      });
      expect(mocks.HermesSession).toHaveBeenNthCalledWith(2, {
        platform: 'android',
      });
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
