import { describe, expect, it } from 'vitest';

import { toolRegistry, TOOL_CATEGORIES, getToolCategory } from './registry.js';

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

describe('TOOL_CATEGORIES and getToolCategory', () => {
  it('every key in toolRegistry exists in TOOL_CATEGORIES', () => {
    for (const key of toolRegistry.keys()) {
      expect(TOOL_CATEGORIES).toHaveProperty(key);
    }
  });

  it('every key in TOOL_CATEGORIES exists in toolRegistry', () => {
    for (const key of Object.keys(TOOL_CATEGORIES)) {
      expect(toolRegistry.has(key)).toBe(true);
    }
  });

  it('getToolCategory returns mutating for nonexistent tool', () => {
    expect(getToolCategory('nonexistent_tool')).toBe('mutating');
  });

  it('getToolCategory returns mutating for click', () => {
    expect(getToolCategory('click')).toBe('mutating');
  });

  it('getToolCategory returns readonly for knowledge_last', () => {
    expect(getToolCategory('knowledge_last')).toBe('readonly');
  });

  it('getToolCategory returns discovery for describe_screen', () => {
    expect(getToolCategory('describe_screen')).toBe('discovery');
  });

  it('getToolCategory returns batch for run_steps', () => {
    expect(getToolCategory('run_steps')).toBe('batch');
  });
});
