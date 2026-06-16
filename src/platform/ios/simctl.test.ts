import { execFile } from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  listDevices,
  bootDevice,
  isBooted,
  launchApp,
  terminateApp,
  takeScreenshot,
} from './simctl.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

const mockExecFile = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;

const SIMCTL_DEVICES_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
      {
        name: 'iPhone 15 Pro',
        udid: 'AAA-111',
        state: 'Booted',
        isAvailable: true,
      },
      {
        name: 'iPhone 15',
        udid: 'BBB-222',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [
      {
        name: 'iPhone 14',
        udid: 'CCC-333',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
  },
});

describe('simctl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listDevices', () => {
    it('parses simctl JSON and flattens devices across runtimes', async () => {
      mockExecFile.mockResolvedValue({
        stdout: SIMCTL_DEVICES_JSON,
        stderr: '',
      });

      const devices = await listDevices();

      expect(devices).toHaveLength(3);
      expect(devices[0]).toStrictEqual({
        name: 'iPhone 15 Pro',
        udid: 'AAA-111',
        state: 'Booted',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
      });
      expect(devices[2]).toStrictEqual({
        name: 'iPhone 14',
        udid: 'CCC-333',
        state: 'Shutdown',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4',
      });
    });

    it('calls xcrun simctl list devices -j', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ devices: {} }),
        stderr: '',
      });

      await listDevices();

      expect(mockExecFile).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'list', 'devices', '-j'],
        { timeout: 30_000 },
      );
    });

    it('returns empty array when no devices exist', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ devices: {} }),
        stderr: '',
      });

      const devices = await listDevices();

      expect(devices).toStrictEqual([]);
    });

    it('propagates execFile errors', async () => {
      mockExecFile.mockRejectedValue(new Error('xcrun not found'));

      await expect(listDevices()).rejects.toThrowError('xcrun not found');
    });
  });

  describe('bootDevice', () => {
    it('calls xcrun simctl boot with udid', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await bootDevice('AAA-111');

      expect(mockExecFile).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'boot', 'AAA-111'],
        { timeout: 30_000 },
      );
    });

    it('propagates errors when boot fails', async () => {
      mockExecFile.mockRejectedValue(new Error('Unable to boot device'));

      await expect(bootDevice('bad-udid')).rejects.toThrowError(
        'Unable to boot device',
      );
    });
  });

  describe('isBooted', () => {
    it('returns true when device is booted', async () => {
      mockExecFile.mockResolvedValue({
        stdout: SIMCTL_DEVICES_JSON,
        stderr: '',
      });

      const result = await isBooted('AAA-111');

      expect(result).toBe(true);
    });

    it('returns false when device is shutdown', async () => {
      mockExecFile.mockResolvedValue({
        stdout: SIMCTL_DEVICES_JSON,
        stderr: '',
      });

      const result = await isBooted('BBB-222');

      expect(result).toBe(false);
    });

    it('returns false when device does not exist', async () => {
      mockExecFile.mockResolvedValue({
        stdout: SIMCTL_DEVICES_JSON,
        stderr: '',
      });

      const result = await isBooted('NONEXISTENT');

      expect(result).toBe(false);
    });
  });

  describe('launchApp', () => {
    it('calls xcrun simctl launch with udid and bundleId', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await launchApp('AAA-111', 'io.metamask.MetaMask');

      expect(mockExecFile).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'launch', 'AAA-111', 'io.metamask.MetaMask'],
        { timeout: 30_000 },
      );
    });
  });

  describe('terminateApp', () => {
    it('calls xcrun simctl terminate with udid and bundleId', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await terminateApp('AAA-111', 'io.metamask.MetaMask');

      expect(mockExecFile).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'terminate', 'AAA-111', 'io.metamask.MetaMask'],
        { timeout: 30_000 },
      );
    });

    it('silently ignores errors', async () => {
      mockExecFile.mockRejectedValue(new Error('App not running'));

      const result = await terminateApp('AAA-111', 'io.metamask.MetaMask');

      expect(result).toBeUndefined();
    });
  });

  describe('takeScreenshot', () => {
    it('calls xcrun simctl io screenshot with udid and path', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      await takeScreenshot('AAA-111', '/tmp/screenshot.png');

      expect(mockExecFile).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'io', 'AAA-111', 'screenshot', '/tmp/screenshot.png'],
        { timeout: 30_000 },
      );
    });

    it('propagates errors when screenshot fails', async () => {
      mockExecFile.mockRejectedValue(new Error('Device not booted'));

      await expect(
        takeScreenshot('AAA-111', '/tmp/screenshot.png'),
      ).rejects.toThrowError('Device not booted');
    });
  });
});
