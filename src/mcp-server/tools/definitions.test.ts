import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  getToolDefinitions,
  TOOL_PREFIX,
  type ToolDefinition,
} from "./definitions.js";

describe("tool-definitions", () => {
  describe("getToolDefinitions", () => {
    it("creates tool definitions with mm_ prefix", () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.name.startsWith(`${TOOL_PREFIX}_`)).toBe(true);
      }
    });

    it("creates 27 tool definitions", () => {
      const definitions = getToolDefinitions();
      expect(definitions.length).toBe(27);
    });

    it("includes all expected tools", () => {
      const definitions = getToolDefinitions();
      const toolNames = definitions.map((d) => d.name);

      const expectedTools = [
        "mm_build",
        "mm_launch",
        "mm_cleanup",
        "mm_get_state",
        "mm_navigate",
        "mm_wait_for_notification",
        "mm_switch_to_tab",
        "mm_close_tab",
        "mm_list_testids",
        "mm_accessibility_snapshot",
        "mm_describe_screen",
        "mm_screenshot",
        "mm_click",
        "mm_type",
        "mm_wait_for",
        "mm_knowledge_last",
        "mm_knowledge_search",
        "mm_knowledge_summarize",
        "mm_knowledge_sessions",
        "mm_seed_contract",
        "mm_seed_contracts",
        "mm_get_contract_address",
        "mm_list_contracts",
        "mm_run_steps",
        "mm_set_context",
        "mm_get_context",
      ];

      for (const expected of expectedTools) {
        expect(toolNames).toContain(expected);
      }
    });

    it("all tools have valid input schema", () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.inputSchema).toBeDefined();
        const hasObjectType = def.inputSchema.type === "object";
        const hasAllOf = Array.isArray(def.inputSchema.allOf);
        expect(hasObjectType || hasAllOf).toBe(true);
      }
    });

    it("all tools have descriptions", () => {
      const definitions = getToolDefinitions();

      for (const def of definitions) {
        expect(def.description).toBeDefined();
        expect(typeof def.description).toBe("string");
        expect(def.description.length).toBeGreaterThan(10);
      }
    });

    describe("specific tool schemas", () => {
      let definitions: ToolDefinition[];

      beforeAll(() => {
        definitions = getToolDefinitions();
      });

      const findTool = (name: string): ToolDefinition | undefined =>
        definitions.find((d) => d.name === name);

      type SchemaObj = {
        properties?: Record<string, unknown>;
        required?: string[];
        allOf?: SchemaObj[];
      };

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

      it("mm_click has correct schema", () => {
        const tool = findTool("mm_click");
        expect(tool).toBeDefined();

        const props = getAllProperties(tool?.inputSchema as SchemaObj);
        expect(props.a11yRef).toBeDefined();
        expect(props.testId).toBeDefined();
        expect(props.selector).toBeDefined();
        expect(props.timeoutMs).toBeDefined();
      });

      it("mm_type has required text property", () => {
        const tool = findTool("mm_type");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("text");
      });

      it("mm_navigate has required screen property", () => {
        const tool = findTool("mm_navigate");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("screen");

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<string, { enum?: string[] }>;
        expect(props.screen?.enum).toEqual([
          "home",
          "settings",
          "notification",
          "url",
        ]);
      });

      it("mm_screenshot has required name property", () => {
        const tool = findTool("mm_screenshot");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("name");
      });

      it("mm_run_steps has required steps property", () => {
        const tool = findTool("mm_run_steps");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("steps");

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<string, { type?: string; items?: { type: string } }>;
        expect(props.steps?.type).toBe("array");
      });

      it("mm_seed_contract has required contractName property", () => {
        const tool = findTool("mm_seed_contract");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("contractName");

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<string, { enum?: string[] }>;
        expect(props.contractName?.enum).toContain("hst");
        expect(props.contractName?.enum).toContain("nfts");
      });

      it("mm_launch has stateMode enum", () => {
        const tool = findTool("mm_launch");
        expect(tool).toBeDefined();

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<string, { enum?: string[] }>;
        expect(props.stateMode?.enum).toEqual([
          "default",
          "onboarding",
          "custom",
        ]);
      });

      it("mm_switch_to_tab has role enum", () => {
        const tool = findTool("mm_switch_to_tab");
        expect(tool).toBeDefined();

        const props = getAllProperties(
          tool?.inputSchema as SchemaObj,
        ) as Record<string, { enum?: string[] }>;
        expect(props.role?.enum).toEqual([
          "extension",
          "notification",
          "dapp",
          "other",
        ]);
      });

      it("mm_knowledge_search has required query property", () => {
        const tool = findTool("mm_knowledge_search");
        expect(tool).toBeDefined();

        const required = getAllRequired(tool?.inputSchema as SchemaObj);
        expect(required).toContain("query");
      });
    });

    it("uses mm_ prefix in descriptions", () => {
      const definitions = getToolDefinitions();

      const a11yTool = definitions.find(
        (d) => d.name === "mm_accessibility_snapshot",
      );
      expect(a11yTool?.description).toContain("mm_click");
      expect(a11yTool?.description).toContain("mm_type");
    });
  });
});
