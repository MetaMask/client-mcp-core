/* eslint-disable id-length */
import { describe, it, expect, beforeAll } from 'vitest';

import {
  getToolDefinitions,
  TOOL_PREFIX,
  extractBaseName,
  validateToolInput,
  safeValidateToolInput,
  getToolNames,
  getPrefixedToolNames,
  buildToolHandlersRecord,
  getToolHandler,
  hasToolHandler,
} from './definitions.js';
import type { ToolDefinition } from './definitions.js';

describe('tool-definitions', () => {
  describe('getToolDefinitions', () => {
    it('creates tool definitions with mm_ prefix', () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.name.startsWith(`${TOOL_PREFIX}_`)).toBe(true);
      }
    });

    it('creates 27 tool definitions', () => {
      const definitions = getToolDefinitions();
      expect(definitions).toHaveLength(27);
    });

    it('includes all expected tools', () => {
      const definitions = getToolDefinitions();
      const toolNames = definitions.map((d) => d.name);

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
      ];

      for (const expected of expectedTools) {
        expect(toolNames).toContain(expected);
      }
    });

    it('all tools have valid input schema', () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.inputSchema).toBeDefined();
        const hasObjectType = def.inputSchema.type === 'object';
        const hasAllOf = Array.isArray(def.inputSchema.allOf);
        expect(hasObjectType || hasAllOf).toBe(true);
      }
    });

    it('all tools have descriptions', () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.description).toBeDefined();
        expect(typeof def.description).toBe('string');
        expect(def.description.length).toBeGreaterThan(10);
      }
    });

    describe('specific tool schemas', () => {
      let definitions: ToolDefinition[];

      beforeAll(() => {
        definitions = getToolDefinitions();
      });

      /**
       * Find a tool definition by its name.
       *
       * @param name The tool name to search for
       * @returns The matching tool definition or undefined if not found
       */
      const findTool = (name: string): ToolDefinition | undefined =>
        definitions.find((d) => d.name === name);

      /**
       * Schema object structure for testing.
       */
      type SchemaObj = {
        /**
         * Object properties mapping
         */
        properties?: Record<string, unknown>;
        /**
         * Required property names
         */
        required?: string[];
        /**
         * Array of schemas to combine
         */
        allOf?: SchemaObj[];
      };

      /**
       * Get all properties from a schema, including those in allOf.
       *
       * @param schema The schema object to extract properties from
       * @returns Combined properties from schema and allOf items
       */
      const getAllProperties = (schema: SchemaObj): Record<string, unknown> => {
        if (schema.properties) {
          return schema.properties;
        }
        if (schema.allOf) {
          return schema.allOf.reduce(
            (acc, item) => ({ ...acc, ...getAllProperties(item) }),
            {},
          );
        }
        return {};
      };

      /**
       * Get all required properties from a schema, including those in allOf.
       *
       * @param schema The schema object to extract required properties from
       * @returns Combined required property names from schema and allOf items
       */
      const getAllRequired = (schema: SchemaObj): string[] => {
        const required: string[] = [];
        if (schema.required) {
          required.push(...schema.required);
        }
        if (schema.allOf) {
          for (const item of schema.allOf) {
            required.push(...getAllRequired(item));
          }
        }
        return required;
      };

      it('mm_click has correct schema', () => {
        const tool = findTool('mm_click');
        expect(tool).toBeDefined();

        const props = getAllProperties(tool?.inputSchema as SchemaObj);
        expect(props.a11yRef).toBeDefined();
        expect(props.testId).toBeDefined();
        expect(props.selector).toBeDefined();
        expect(props.timeoutMs).toBeDefined();
      });

      it('mm_type has required text property', () => {
        const tool = findTool('mm_type');
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain('text');
      });

      it('mm_navigate has required screen property', () => {
        const tool = findTool('mm_navigate');
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain('screen');

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<
          string,
          {
            /**
             *
             */
            enum?: string[];
          }
        >;
        expect(props.screen?.enum).toStrictEqual([
          'home',
          'settings',
          'notification',
          'url',
        ]);
      });

      it('mm_screenshot has required name property', () => {
        const tool = findTool('mm_screenshot');
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain('name');
      });

      it('mm_run_steps has required steps property', () => {
        const tool = findTool('mm_run_steps');
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain('steps');

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<
          string,
          {
            /**
             * The JSON schema type
             */
            type?: string;
            /**
             * Array item schema definition
             */
            items?: {
              /**
               * The item type
               */
              type: string;
            };
          }
        >;
        expect(props.steps?.type).toBe('array');
      });

      it('mm_seed_contract has required contractName property', () => {
        const tool = findTool('mm_seed_contract');
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain('contractName');

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<
          string,
          {
            /**
             *
             */
            enum?: string[];
          }
        >;
       expect(props.contractName?.enum).toContain('hst');
         expect(props.contractName?.enum).toContain('nfts');
       });

       it('mm_launch has stateMode enum', () => {
         const tool = findTool('mm_launch');
         expect(tool).toBeDefined();

         const props = getAllProperties(
           tool?.inputSchema as SchemaObj,
         ) as Record<
           string,
           {
             /**
              *
              */
             enum?: string[];
           }
         >;
         expect(props.stateMode?.enum).toStrictEqual([
           'default',
           'onboarding',
           'custom',
         ]);
       });

       it('mm_switch_to_tab has role enum', () => {
         const tool = findTool('mm_switch_to_tab');
         expect(tool).toBeDefined();

         const props = getAllProperties(
           tool?.inputSchema as SchemaObj,
         ) as Record<
           string,
           {
             /**
              *
              */
             enum?: string[];
           }
         >;
         expect(props.role?.enum).toStrictEqual([
           'extension',
           'notification',
           'dapp',
           'other',
         ]);
       });

       it('mm_knowledge_search has required query property', () => {
         const tool = findTool('mm_knowledge_search');
         expect(tool).toBeDefined();

         const required = getAllRequired(tool?.inputSchema as SchemaObj);
         expect(required).toContain('query');
       });
     });

     it('uses mm_ prefix in descriptions', () => {
       const definitions = getToolDefinitions();

       const a11yTool = definitions.find(
         (d) => d.name === 'mm_accessibility_snapshot',
       );
       expect(a11yTool?.description).toContain('mm_click');
       expect(a11yTool?.description).toContain('mm_type');
     });

     it('all schemas have additionalProperties set to false', () => {
       const definitions = getToolDefinitions();

       for (const def of definitions) {
         const schema = def.inputSchema as Record<string, unknown>;
         if (schema.type === 'object') {
           expect(schema.additionalProperties).toBe(false);
         }
       }
     });

     it('all schemas have properties defined', () => {
       const definitions = getToolDefinitions();

       for (const def of definitions) {
         const schema = def.inputSchema as Record<string, unknown>;
         expect(
           schema.properties || schema.allOf || schema.anyOf || schema.oneOf,
         ).toBeDefined();
       }
     });

      it('all required properties are defined in properties', () => {
        const definitions = getToolDefinitions();

        for (const def of definitions) {
          const schema = def.inputSchema as Record<string, unknown>;
          if (Array.isArray(schema.required) && schema.properties) {
            const props = schema.properties as Record<string, unknown>;
            for (const req of schema.required) {
              expect(props[req as string]).toBeDefined();
            }
          }
        }
      });

      it('processes anyOf arrays in nested properties', () => {
        const definitions = getToolDefinitions();

        // Find tools with anyOf in properties (e.g., knowledge tools with scope)
        // This exercises the anyOf handling in removeDefaultsFromRequired (lines 397-400)
        let foundAnyOf = false;
        for (const def of definitions) {
          const schema = def.inputSchema as Record<string, unknown>;
          if (schema.properties && typeof schema.properties === 'object') {
            const props = schema.properties as Record<string, unknown>;
            for (const [, prop] of Object.entries(props)) {
              if (prop && typeof prop === 'object') {
                const propObj = prop as Record<string, unknown>;
                if ('anyOf' in propObj) {
                  foundAnyOf = true;
                  expect(Array.isArray(propObj.anyOf)).toBe(true);
                  // Verify anyOf items are properly processed
                  const anyOfArray = propObj.anyOf as unknown[];
                  for (const item of anyOfArray) {
                    expect(item).toBeDefined();
                  }
                }
              }
            }
          }
        }
        // Verify we found at least one tool with anyOf (knowledge tools)
        expect(foundAnyOf).toBe(true);
      });

      it('processes nested object properties recursively', () => {
        const definitions = getToolDefinitions();

        // Verify that nested object properties are processed correctly
        // This exercises the recursive property handling in removeDefaultsFromRequired (lines 418-421)
        for (const def of definitions) {
          const schema = def.inputSchema as Record<string, unknown>;
          if (schema.properties && typeof schema.properties === 'object') {
            const props = schema.properties as Record<string, unknown>;
            for (const [, value] of Object.entries(props)) {
              if (value && typeof value === 'object') {
                const propObj = value as Record<string, unknown>;
                // Nested objects should have proper structure
                expect(propObj).toBeDefined();
                // If it has properties, they should be objects
                if ('properties' in propObj && propObj.properties) {
                  expect(typeof propObj.properties).toBe('object');
                }
              }
            }
          }
        }
      });

      it('sets additionalProperties false on top-level object schemas', () => {
        const definitions = getToolDefinitions();

        // Verify that additionalProperties is set to false on top-level schemas
        // This exercises the additionalProperties assignment in zodSchemaToJsonSchema (line 503)
        for (const def of definitions) {
          const schema = def.inputSchema as Record<string, unknown>;
          // All tool schemas should be objects with additionalProperties: false
          if (schema.type === 'object') {
            expect(schema.additionalProperties).toBe(false);
          }
        }
      });
    });

  describe('extractBaseName', () => {
    it('removes mm_ prefix from tool name', () => {
      const result = extractBaseName('mm_click');

      expect(result).toBe('click');
    });

    it('returns original name when no prefix', () => {
      const result = extractBaseName('click');

      expect(result).toBe('click');
    });

    it('handles multiple underscores correctly', () => {
      const result = extractBaseName('mm_wait_for_notification');

      expect(result).toBe('wait_for_notification');
    });

    it('handles empty string', () => {
      const result = extractBaseName('');

      expect(result).toBe('');
    });

    it('handles string with only prefix', () => {
      const result = extractBaseName('mm_');

      expect(result).toBe('');
    });

    it('handles all tool names from getToolNames', () => {
      const baseNames = getToolNames();

      for (const baseName of baseNames) {
        const prefixed = `${TOOL_PREFIX}_${baseName}`;
        const extracted = extractBaseName(prefixed);
        expect(extracted).toBe(baseName);
      }
    });
  });

  describe('validateToolInput', () => {
    it('parses valid input for known tool', () => {
      const result = validateToolInput('mm_click', { testId: 'button' });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('testId', 'button');
    });

    it('throws error for unknown tool', () => {
      expect(() => {
        validateToolInput('mm_unknown_tool', {});
      }).toThrow('Unknown tool: mm_unknown_tool');
    });

    it('throws error for invalid input schema', () => {
      expect(() => {
        validateToolInput('mm_type', { text: 123 });
      }).toThrow();
    });

    it('accepts input without prefix', () => {
      const result = validateToolInput('click', { testId: 'button' });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('testId', 'button');
    });

    it('parses input with multiple valid properties', () => {
      const result = validateToolInput('mm_click', {
        testId: 'button',
        timeoutMs: 5000,
      });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('testId', 'button');
      expect(result).toHaveProperty('timeoutMs', 5000);
    });
  });

  describe('safeValidateToolInput', () => {
    it('returns success with data for valid input', () => {
      const result = safeValidateToolInput('mm_click', { testId: 'button' });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('data');
      if (result.success) {
        expect(result.data).toHaveProperty('testId', 'button');
      }
    });

    it('returns failure for unknown tool', () => {
      const result = safeValidateToolInput('mm_unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
      if (!result.success) {
        expect(result.error).toContain('Unknown tool');
      }
    });

    it('returns failure for invalid input', () => {
      const result = safeValidateToolInput('mm_type', { text: 123 });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('accepts input without prefix', () => {
      const result = safeValidateToolInput('click', { testId: 'button' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('testId', 'button');
      }
    });

    it('returns success with multiple valid properties', () => {
      const result = safeValidateToolInput('mm_click', {
        testId: 'button',
        timeoutMs: 5000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('testId', 'button');
        expect(result.data).toHaveProperty('timeoutMs', 5000);
      }
    });

    it('includes error message with path for validation errors', () => {
      const result = safeValidateToolInput('mm_type', { text: 123 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/text/);
      }
    });
  });

  describe('getToolNames', () => {
    it('returns array of tool base names', () => {
      const names = getToolNames();

      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });

    it('includes expected tool names without prefix', () => {
      const names = getToolNames();

      expect(names).toContain('click');
      expect(names).toContain('type');
      expect(names).toContain('launch');
      expect(names).toContain('cleanup');
    });

    it('does not include mm_ prefix in names', () => {
      const names = getToolNames();

      for (const name of names) {
        expect(name).not.toMatch(/^mm_/);
      }
    });

    it('returns 27 tool names', () => {
      const names = getToolNames();

      expect(names.length).toBe(27);
    });

    it('all names are strings', () => {
      const names = getToolNames();

      for (const name of names) {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getPrefixedToolNames', () => {
    it('returns array of prefixed tool names', () => {
      const names = getPrefixedToolNames();

      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });

    it('includes mm_ prefix in all names', () => {
      const names = getPrefixedToolNames();

      for (const name of names) {
        expect(name).toMatch(/^mm_/);
      }
    });

    it('includes expected prefixed tool names', () => {
      const names = getPrefixedToolNames();

      expect(names).toContain('mm_click');
      expect(names).toContain('mm_type');
      expect(names).toContain('mm_launch');
      expect(names).toContain('mm_cleanup');
    });

    it('has same count as getToolNames', () => {
      const baseNames = getToolNames();
      const prefixedNames = getPrefixedToolNames();

      expect(prefixedNames.length).toBe(baseNames.length);
    });
  });

  describe('buildToolHandlersRecord', () => {
    it('returns record mapping prefixed names to handlers', () => {
      const handlers = buildToolHandlersRecord();

      expect(typeof handlers).toBe('object');
      expect(handlers).not.toBeNull();
    });

    it('includes all prefixed tool names as keys', () => {
      const handlers = buildToolHandlersRecord();
      const prefixedNames = getPrefixedToolNames();

      for (const name of prefixedNames) {
        expect(handlers).toHaveProperty(name);
      }
    });

    it('all values are functions', () => {
      const handlers = buildToolHandlersRecord();

      for (const [, handler] of Object.entries(handlers)) {
        expect(typeof handler).toBe('function');
      }
    });

    it('has same count as getPrefixedToolNames', () => {
      const handlers = buildToolHandlersRecord();
      const prefixedNames = getPrefixedToolNames();

      expect(Object.keys(handlers).length).toBe(prefixedNames.length);
    });

    it('does not include base names without prefix', () => {
      const handlers = buildToolHandlersRecord();
      const baseNames = getToolNames();

      for (const baseName of baseNames) {
        expect(handlers).not.toHaveProperty(baseName);
      }
    });
  });

  describe('getToolHandler', () => {
    it('returns handler for prefixed tool name', () => {
      const handler = getToolHandler('mm_click');

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('returns handler for base tool name', () => {
      const handler = getToolHandler('click');

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('returns undefined for unknown tool', () => {
      const handler = getToolHandler('mm_unknown_tool');

      expect(handler).toBeUndefined();
    });

    it('returns same handler for prefixed and base names', () => {
      const prefixedHandler = getToolHandler('mm_click');
      const baseHandler = getToolHandler('click');

      expect(prefixedHandler).toBe(baseHandler);
    });
  });

  describe('hasToolHandler', () => {
    it('returns true for existing prefixed tool', () => {
      const exists = hasToolHandler('mm_click');

      expect(exists).toBe(true);
    });

    it('returns true for existing base tool name', () => {
      const exists = hasToolHandler('click');

      expect(exists).toBe(true);
    });

    it('returns false for unknown tool', () => {
      const exists = hasToolHandler('mm_unknown_tool');

      expect(exists).toBe(false);
    });

    it('returns true for all prefixed tool names', () => {
      const prefixedNames = getPrefixedToolNames();

      for (const name of prefixedNames) {
        expect(hasToolHandler(name)).toBe(true);
      }
    });

    it('returns true for all base tool names', () => {
      const baseNames = getToolNames();

      for (const name of baseNames) {
        expect(hasToolHandler(name)).toBe(true);
      }
    });
  });
});
