/**
 * Android Platform Types
 *
 * Defines types for Android device information and configuration.
 */

/**
 * Information about an Android device available via adb.
 */
export type AndroidDeviceInfo = {
  /** Device serial number (from `adb devices`). */
  serial: string;
  /** Connection state. */
  state: 'device' | 'offline' | 'unauthorized';
  /** Optional device model (from `adb -s <serial> shell getprop ro.product.model`). */
  model?: string;
};
