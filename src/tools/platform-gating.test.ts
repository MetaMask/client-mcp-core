import { describe, it, expect } from 'vitest';

import { isBrowserOnlyTool } from './registry.js';

describe('isBrowserOnlyTool', () => {
  it('returns true for browser-only tools', () => {
    expect(isBrowserOnlyTool('navigate')).toBe(true);
    expect(isBrowserOnlyTool('switch_to_tab')).toBe(true);
    expect(isBrowserOnlyTool('close_tab')).toBe(true);
    expect(isBrowserOnlyTool('wait_for_notification')).toBe(true);
    expect(isBrowserOnlyTool('cdp')).toBe(true);
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
    expect(isBrowserOnlyTool('clipboard')).toBe(false);
  });

  it('returns false for unknown tools', () => {
    expect(isBrowserOnlyTool('nonexistent_tool')).toBe(false);
  });
});
