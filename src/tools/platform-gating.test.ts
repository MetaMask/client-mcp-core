import { describe, it, expect } from 'vitest';

import {
  checkPlatformGate,
  isBrowserOnlyTool,
  isMobileOnlyTool,
} from './registry.js';

describe('isBrowserOnlyTool', () => {
  it('returns true for browser-only tools', () => {
    expect(isBrowserOnlyTool('navigate')).toBe(true);
    expect(isBrowserOnlyTool('switch_to_tab')).toBe(true);
    expect(isBrowserOnlyTool('close_tab')).toBe(true);
    expect(isBrowserOnlyTool('wait_for_notification')).toBe(true);
    expect(isBrowserOnlyTool('clipboard')).toBe(true);
    expect(isBrowserOnlyTool('mock_network')).toBe(true);
    expect(isBrowserOnlyTool('build')).toBe(true);
  });

  it('returns false for cross-platform tools', () => {
    expect(isBrowserOnlyTool('click')).toBe(false);
    expect(isBrowserOnlyTool('type')).toBe(false);
    expect(isBrowserOnlyTool('wait_for')).toBe(false);
    expect(isBrowserOnlyTool('describe_screen')).toBe(false);
    expect(isBrowserOnlyTool('screenshot')).toBe(false);
    expect(isBrowserOnlyTool('get_state')).toBe(false);
    expect(isBrowserOnlyTool('launch')).toBe(false);
    expect(isBrowserOnlyTool('cleanup')).toBe(false);
    expect(isBrowserOnlyTool('list_testids')).toBe(false);
    expect(isBrowserOnlyTool('accessibility_snapshot')).toBe(false);
    expect(isBrowserOnlyTool('get_text')).toBe(false);
    expect(isBrowserOnlyTool('cdp')).toBe(false);
  });

  it('returns false for the mobile-only hermes tools', () => {
    expect(isBrowserOnlyTool('hermes_targets')).toBe(false);
  });

  it('returns false for unknown tools', () => {
    expect(isBrowserOnlyTool('nonexistent_tool')).toBe(false);
  });
});

describe('isMobileOnlyTool', () => {
  it('returns true for mobile-only hermes tools', () => {
    expect(isMobileOnlyTool('hermes_targets')).toBe(true);
  });

  it('returns false for browser-only and cross-platform tools', () => {
    expect(isMobileOnlyTool('cdp')).toBe(false);
    expect(isMobileOnlyTool('click')).toBe(false);
    expect(isMobileOnlyTool('navigate')).toBe(false);
    expect(isMobileOnlyTool('screenshot')).toBe(false);
    expect(isMobileOnlyTool('build')).toBe(false);
  });

  it('returns false for unknown tools', () => {
    expect(isMobileOnlyTool('nonexistent_tool')).toBe(false);
  });
});

describe('checkPlatformGate', () => {
  it('allows browser-only tools on the browser platform', () => {
    expect(checkPlatformGate('navigate', 'browser')).toBeUndefined();
  });

  it('allows browser-only tools when no platform driver is present', () => {
    expect(checkPlatformGate('navigate', undefined)).toBeUndefined();
  });

  it('blocks browser-only tools on a mobile platform', () => {
    expect(checkPlatformGate('navigate', 'ios')).toStrictEqual({
      code: 'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      message: 'Tool "navigate" is not supported on ios platform',
    });
  });

  it('allows mobile-only tools on a mobile platform', () => {
    expect(checkPlatformGate('hermes_targets', 'android')).toBeUndefined();
  });

  it('blocks mobile-only tools on the browser platform', () => {
    expect(checkPlatformGate('hermes_targets', 'browser')).toStrictEqual({
      code: 'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      message:
        'Tool "hermes_targets" is only supported on mobile (iOS/Android) platforms',
    });
  });

  it('blocks mobile-only tools when no platform driver is present', () => {
    expect(checkPlatformGate('hermes_targets', undefined)).toStrictEqual({
      code: 'MM_TOOL_NOT_SUPPORTED_ON_PLATFORM',
      message:
        'Tool "hermes_targets" is only supported on mobile (iOS/Android) platforms',
    });
  });

  it('allows cross-platform tools on any platform', () => {
    expect(checkPlatformGate('cdp', 'ios')).toBeUndefined();
    expect(checkPlatformGate('cdp', 'browser')).toBeUndefined();
    expect(checkPlatformGate('cdp', undefined)).toBeUndefined();
  });
});
