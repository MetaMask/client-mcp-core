import { describe, it, expect } from 'vitest';

import {
  getToolHandler,
  hasToolHandler,
  buildToolHandlersRecord,
  toolHandlers,
} from './registry.js';

describe('tool registry', () => {
  describe('getToolHandler', () => {
    it('returns handler for prefixed tool name', () => {
      const handler = getToolHandler('mm_launch');

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('returns handler for base tool name', () => {
      const handler = getToolHandler('launch');

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('returns undefined for unknown tool', () => {
      const handler = getToolHandler('mm_unknown_tool');

      expect(handler).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      const handler = getToolHandler('');

      expect(handler).toBeUndefined();
    });

    it('returns different handlers for different tools', () => {
      const launchHandler = getToolHandler('mm_launch');
      const cleanupHandler = getToolHandler('mm_cleanup');

      expect(launchHandler).not.toBe(cleanupHandler);
    });
  });

  describe('hasToolHandler', () => {
    it('returns true for existing prefixed tool', () => {
      const result = hasToolHandler('mm_click');

      expect(result).toBe(true);
    });

    it('returns true for existing base tool', () => {
      const result = hasToolHandler('click');

      expect(result).toBe(true);
    });

    it('returns false for non-existent tool', () => {
      const result = hasToolHandler('mm_nonexistent');

      expect(result).toBe(false);
    });

    it('returns false for empty string', () => {
      const result = hasToolHandler('');

      expect(result).toBe(false);
    });
  });

  describe('buildToolHandlersRecord', () => {
    it('returns record with prefixed tool names', () => {
      const handlers = buildToolHandlersRecord();

      expect(handlers.mm_launch).toBeDefined();
      expect(handlers.mm_cleanup).toBeDefined();
      expect(handlers.mm_click).toBeDefined();
      expect(handlers.mm_type).toBeDefined();
    });

    it('returns fresh record on each call', () => {
      const handlers1 = buildToolHandlersRecord();
      const handlers2 = buildToolHandlersRecord();

      expect(handlers1).not.toBe(handlers2);
      expect(handlers1).toStrictEqual(handlers2);
    });

    it('includes all 27 tools', () => {
      const handlers = buildToolHandlersRecord();

      expect(Object.keys(handlers)).toHaveLength(27);
    });

    it('all handlers are functions', () => {
      const handlers = buildToolHandlersRecord();

      for (const handler of Object.values(handlers)) {
        expect(typeof handler).toBe('function');
      }
    });
  });

  describe('toolHandlers export', () => {
    it('exports pre-built handlers record', () => {
      expect(toolHandlers).toBeDefined();
      expect(typeof toolHandlers).toBe('object');
    });

    it('contains all expected tools', () => {
      const expectedTools = [
        'mm_build',
        'mm_launch',
        'mm_cleanup',
        'mm_get_state',
        'mm_navigate',
        'mm_wait_for_notification',
        'mm_switch_to_tab',
        'mm_close_tab',
        'mm_list_testids',
        'mm_accessibility_snapshot',
        'mm_describe_screen',
        'mm_screenshot',
        'mm_click',
        'mm_type',
        'mm_wait_for',
        'mm_knowledge_last',
        'mm_knowledge_search',
        'mm_knowledge_summarize',
        'mm_knowledge_sessions',
        'mm_seed_contract',
        'mm_seed_contracts',
        'mm_get_contract_address',
        'mm_list_contracts',
        'mm_run_steps',
        'mm_set_context',
        'mm_get_context',
        'mm_clipboard',
      ];

      for (const tool of expectedTools) {
        expect(toolHandlers[tool]).toBeDefined();
        expect(typeof toolHandlers[tool]).toBe('function');
      }
    });

    it('matches buildToolHandlersRecord output', () => {
      const freshHandlers = buildToolHandlersRecord();

      expect(Object.keys(toolHandlers)).toStrictEqual(
        Object.keys(freshHandlers),
      );
    });
  });
});
