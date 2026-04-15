import { describe, expect, it } from 'vitest';

import { toolRegistry } from './registry.js';

describe('toolRegistry', () => {
  it('has expected tool entries', () => {
    const expectedTools = [
      'build',
      'launch',
      'cleanup',
      'click',
      'type',
      'navigate',
      'screenshot',
      'describe_screen',
      'clipboard',
      'run_steps',
    ];

    for (const toolName of expectedTools) {
      expect(toolRegistry.has(toolName)).toBe(true);
    }
  });

  it('returns a function for launch', () => {
    expect(typeof toolRegistry.get('launch')).toBe('function');
  });

  it('returns undefined for a nonexistent tool', () => {
    expect(toolRegistry.get('nonexistent')).toBeUndefined();
  });

  it('has the expected number of entries', () => {
    expect(toolRegistry.size).toBe(27);
  });

  it('stores only functions as values', () => {
    for (const handler of toolRegistry.values()) {
      expect(typeof handler).toBe('function');
    }
  });

  it('uses unprefixed keys', () => {
    for (const key of toolRegistry.keys()) {
      expect(key.startsWith('mm_')).toBe(false);
    }
  });
});
