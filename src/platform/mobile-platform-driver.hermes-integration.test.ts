import type { DeviceBackend } from '@metamask/device-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobilePlatformDriver } from './mobile-platform-driver.js';

const mocks = vi.hoisted(() => ({
  fetchDiscoveryTargets: vi.fn(),
  selectHermesTarget: vi.fn(),
  hasAmbiguousTarget: vi.fn(),
  resolve: vi.fn(),
  getPinnedHermesDeviceId: vi.fn(),
  HermesSession: vi.fn(),
}));

vi.mock('@metamask/device-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@metamask/device-mcp')>();
  mocks.selectHermesTarget.mockImplementation(actual.selectHermesTarget);
  mocks.hasAmbiguousTarget.mockImplementation(actual.hasAmbiguousTarget);

  return {
    ...actual,
    fetchDiscoveryTargets: mocks.fetchDiscoveryTargets,
    selectHermesTarget: mocks.selectHermesTarget,
    hasAmbiguousTarget: mocks.hasAmbiguousTarget,
    HermesSession: mocks.HermesSession,
  };
});

describe('MobilePlatformDriver Hermes target selection integration', () => {
  beforeEach(() => {
    mocks.HermesSession.mockImplementation(() => ({
      resolve: mocks.resolve,
      getPinnedHermesDeviceId: mocks.getPinnedHermesDeviceId,
    }));
    mocks.resolve.mockReturnValue({
      metroPort: 8081,
      appId: 'io.metamask',
      pinnedDeviceId: undefined,
    });
    mocks.getPinnedHermesDeviceId.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('displays all appIds while evaluating ambiguity within the expected appId', async () => {
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
    const targets = [
      ...matchingTargets,
      {
        id: 'page-3',
        title: 'Other App',
        appId: 'other.app',
        webSocketDebuggerUrl: 'ws://localhost:8081/c',
        reactNative: { logicalDeviceId: 'dev-3' },
      },
    ];
    mocks.fetchDiscoveryTargets.mockResolvedValue(targets);
    const driver = new MobilePlatformDriver({
      platform: 'android',
    } as DeviceBackend);

    const result = await driver.hermesTargets({ all: true });

    expect(result.candidates.map(({ appId }) => appId)).toStrictEqual([
      'io.metamask',
      'io.metamask',
      'other.app',
    ]);
    expect(result.ambiguous).toContain('Ambiguous Hermes target');
    expect(mocks.selectHermesTarget).toHaveBeenCalledWith(
      targets,
      'io.metamask',
      undefined,
    );
    expect(mocks.hasAmbiguousTarget).toHaveBeenLastCalledWith(matchingTargets);
  });
});
