/**
 * Wrapper around `xcrun simctl` for managing iOS Simulator devices.
 *
 * Provides device listing, boot, app launch/terminate, and screenshot
 * capabilities via the simctl CLI. All functions shell out to `xcrun simctl`.
 *
 * This module contains NO Playwright imports.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Represents a single iOS Simulator device.
 */
export type SimulatorDevice = {
  name: string;
  udid: string;
  state: string;
  runtime: string;
};

/**
 * Raw JSON shape returned by `xcrun simctl list devices -j`.
 */
type SimctlDeviceListJson = {
  devices: Record<
    string,
    {
      name: string;
      udid: string;
      state: string;
      isAvailable?: boolean;
    }[]
  >;
};

/**
 * List all available simulator devices.
 *
 * Parses the JSON output of `xcrun simctl list devices -j` and
 * flattens the runtime-keyed structure into a flat array.
 *
 * @returns Promise resolving to a flat array of simulator devices.
 */
export async function listDevices(): Promise<SimulatorDevice[]> {
  const { stdout } = await execFile('xcrun', [
    'simctl',
    'list',
    'devices',
    '-j',
  ]);
  const data = JSON.parse(stdout) as SimctlDeviceListJson;
  const result: SimulatorDevice[] = [];

  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const device of devices) {
      result.push({
        name: device.name,
        udid: device.udid,
        state: device.state,
        runtime,
      });
    }
  }

  return result;
}

/**
 * Boot a simulator device by UDID.
 *
 * @param udid - Simulator device UDID.
 * @returns Promise that resolves when the device has been booted.
 */
export async function bootDevice(udid: string): Promise<void> {
  await execFile('xcrun', ['simctl', 'boot', udid]);
}

/**
 * Check if a simulator device is currently booted.
 *
 * @param udid - Simulator device UDID.
 * @returns Promise resolving to true if device is booted.
 */
export async function isBooted(udid: string): Promise<boolean> {
  const devices = await listDevices();
  return devices.some(
    (device) => device.udid === udid && device.state === 'Booted',
  );
}

/**
 * Launch an app on a simulator device by bundle ID.
 *
 * @param udid - Simulator device UDID.
 * @param bundleId - App bundle identifier.
 * @returns Promise that resolves when the app is launched.
 */
export async function launchApp(udid: string, bundleId: string): Promise<void> {
  await execFile('xcrun', ['simctl', 'launch', udid, bundleId]);
}

/**
 * Terminate an app on a simulator device by bundle ID.
 *
 * Silently ignores errors (e.g., app not running).
 *
 * @param udid - Simulator device UDID.
 * @param bundleId - App bundle identifier.
 * @returns Promise that resolves when termination is attempted.
 */
export async function terminateApp(
  udid: string,
  bundleId: string,
): Promise<void> {
  try {
    await execFile('xcrun', ['simctl', 'terminate', udid, bundleId]);
  } catch {
    // Ignore errors — app may not be running
  }
}

/**
 * Take a screenshot of a simulator device and save to the given path.
 *
 * @param udid - Simulator device UDID.
 * @param outputPath - File path for the screenshot output.
 * @returns Promise that resolves when the screenshot is saved.
 */
export async function takeScreenshot(
  udid: string,
  outputPath: string,
): Promise<void> {
  await execFile('xcrun', ['simctl', 'io', udid, 'screenshot', outputPath]);
}
