import { type ZodType } from "zod";

import {
  buildInputSchema,
  launchInputSchema,
  cleanupInputSchema,
  getStateInputSchema,
  navigateInputSchema,
  waitForNotificationInputSchema,
  switchToTabInputSchema,
  closeTabInputSchema,
  listTestIdsInputSchema,
  accessibilitySnapshotInputSchema,
  describeScreenInputSchema,
  screenshotInputSchema,
  clickInputSchema,
  typeInputSchema,
  waitForInputSchema,
  knowledgeLastInputSchema,
  knowledgeSearchInputSchema,
  knowledgeSummarizeInputSchema,
  knowledgeSessionsInputSchema,
  seedContractInputSchema,
  seedContractsInputSchema,
  getContractAddressInputSchema,
  listDeployedContractsInputSchema,
  runStepsInputSchema,
  setContextInputSchema,
  getContextInputSchema,
  clipboardInputSchema,
} from "../schemas.js";

import type {
  SeedContractInput,
  SeedContractsInput,
  GetContractAddressInput,
  ListDeployedContractsInput,
} from "../types/index.js";

import { getSessionManager } from "../session-manager.js";
import type { BuildToolOptions } from "./build.js";
import type { SeedingToolOptions } from "./seeding.js";
import type { StateToolOptions } from "./state.js";
import { type ToolHandler, handleRunSteps } from "./batch.js";

import { handleBuild } from "./build.js";
import { handleLaunch } from "./launch.js";
import { handleCleanup } from "./cleanup.js";
import { handleGetState } from "./state.js";
import {
  handleNavigate,
  handleWaitForNotification,
  handleSwitchToTab,
  handleCloseTab,
} from "./navigation.js";
import {
  handleListTestIds,
  handleAccessibilitySnapshot,
  handleDescribeScreen,
} from "./discovery-tools.js";
import { handleClick, handleType, handleWaitFor } from "./interaction.js";
import { handleClipboard } from "./clipboard.js";
import { handleScreenshot } from "./screenshot.js";
import {
  handleKnowledgeLast,
  handleKnowledgeSearch,
  handleKnowledgeSummarize,
  handleKnowledgeSessions,
} from "./knowledge.js";
import {
  handleSeedContract,
  handleSeedContracts,
  handleGetContractAddress,
  handleListDeployedContracts,
} from "./seeding.js";
import { handleSetContext, handleGetContext } from "./context.js";

export const TOOL_PREFIX = "mm";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ZodSchema = ZodType<unknown> & { toJSONSchema(): Record<string, unknown> };

type ToolEntry = {
  schema: ZodSchema;
  description: string;
  handler: ToolHandler;
};

function createBuildHandler(): ToolHandler {
  return async (input, options) => {
    const sessionManager = getSessionManager();
    const buildOptions: BuildToolOptions = {
      ...options,
      buildCapability: sessionManager.getBuildCapability?.(),
    };
    return handleBuild(input, buildOptions);
  };
}

function createStateHandler(): ToolHandler {
  return async (_, options) => {
    const sessionManager = getSessionManager();
    const stateOptions: StateToolOptions = {
      ...options,
      stateSnapshotCapability: sessionManager.getStateSnapshotCapability?.(),
    };
    return handleGetState(stateOptions);
  };
}

function createSeedContractHandler(): ToolHandler {
  return async (input, options) => {
    const sessionManager = getSessionManager();
    const seedingOptions: SeedingToolOptions = {
      ...options,
      seedingCapability: sessionManager.getContractSeedingCapability?.(),
    };
    return handleSeedContract(input as SeedContractInput, seedingOptions);
  };
}

function createSeedContractsHandler(): ToolHandler {
  return async (input, options) => {
    const sessionManager = getSessionManager();
    const seedingOptions: SeedingToolOptions = {
      ...options,
      seedingCapability: sessionManager.getContractSeedingCapability?.(),
    };
    return handleSeedContracts(input as SeedContractsInput, seedingOptions);
  };
}

function createGetContractAddressHandler(): ToolHandler {
  return async (input, options) => {
    const sessionManager = getSessionManager();
    const seedingOptions: SeedingToolOptions = {
      ...options,
      seedingCapability: sessionManager.getContractSeedingCapability?.(),
    };
    return handleGetContractAddress(
      input as GetContractAddressInput,
      seedingOptions,
    );
  };
}

function createListDeployedContractsHandler(): ToolHandler {
  return async (input, options) => {
    const sessionManager = getSessionManager();
    const seedingOptions: SeedingToolOptions = {
      ...options,
      seedingCapability: sessionManager.getContractSeedingCapability?.(),
    };
    return handleListDeployedContracts(
      input as ListDeployedContractsInput,
      seedingOptions,
    );
  };
}

const tools: Record<string, ToolEntry> = {
  build: {
    schema: buildInputSchema,
    description: `Build the extension using yarn build:test. Call before ${TOOL_PREFIX}_launch if extension is not built.`,
    handler: createBuildHandler(),
  },
  launch: {
    schema: launchInputSchema,
    description:
      "Launch extension in a headed Chrome browser with Playwright. Returns session info and initial state.",
    handler: handleLaunch as ToolHandler,
  },
  cleanup: {
    schema: cleanupInputSchema,
    description:
      "Stop the browser, Anvil, and all services. Always call when done.",
    handler: handleCleanup as ToolHandler,
  },
  get_state: {
    schema: getStateInputSchema,
    description:
      "Get current extension state including screen, URL, balance, network, and account address.",
    handler: createStateHandler(),
  },
  navigate: {
    schema: navigateInputSchema,
    description: "Navigate to a specific screen in the extension.",
    handler: handleNavigate as ToolHandler,
  },
  wait_for_notification: {
    schema: waitForNotificationInputSchema,
    description:
      "Wait for notification popup to appear (e.g., after dapp interaction). Sets the notification page as the active page for subsequent interactions.",
    handler: handleWaitForNotification as ToolHandler,
  },
  switch_to_tab: {
    schema: switchToTabInputSchema,
    description: `Switch the active page to a different tracked tab. Use this to direct ${TOOL_PREFIX}_click, ${TOOL_PREFIX}_type, and other interaction tools to a specific page.`,
    handler: handleSwitchToTab as ToolHandler,
  },
  close_tab: {
    schema: closeTabInputSchema,
    description:
      "Close a specific tab by role or URL. Cannot close the extension home page. If closing the active tab, automatically switches to extension home.",
    handler: handleCloseTab as ToolHandler,
  },
  list_testids: {
    schema: listTestIdsInputSchema,
    description:
      "List all visible data-testid attributes on the current page. Use to discover available interaction targets.",
    handler: handleListTestIds as ToolHandler,
  },
  accessibility_snapshot: {
    schema: accessibilitySnapshotInputSchema,
    description: `Get trimmed accessibility tree with deterministic refs (e1, e2, ...). Use refs with ${TOOL_PREFIX}_click/${TOOL_PREFIX}_type.`,
    handler: handleAccessibilitySnapshot as ToolHandler,
  },
  describe_screen: {
    schema: describeScreenInputSchema,
    description:
      "Get comprehensive screen state: extension state + testIds + accessibility snapshot. Optional screenshot.",
    handler: handleDescribeScreen as ToolHandler,
  },
  screenshot: {
    schema: screenshotInputSchema,
    description: "Take a screenshot and save to test-artifacts/screenshots/",
    handler: handleScreenshot as ToolHandler,
  },
  click: {
    schema: clickInputSchema,
    description:
      "Click an element. Specify exactly one of: a11yRef, testId, or selector.",
    handler: handleClick as ToolHandler,
  },
  type: {
    schema: typeInputSchema,
    description:
      "Type text into an element. Specify exactly one of: a11yRef, testId, or selector.",
    handler: handleType as ToolHandler,
  },
  wait_for: {
    schema: waitForInputSchema,
    description:
      "Wait for an element to become visible. Specify exactly one of: a11yRef, testId, or selector.",
    handler: handleWaitFor as ToolHandler,
  },
  knowledge_last: {
    schema: knowledgeLastInputSchema,
    description:
      "Get the last N step records from the knowledge store for the current session.",
    handler: handleKnowledgeLast as ToolHandler,
  },
  knowledge_search: {
    schema: knowledgeSearchInputSchema,
    description:
      "Search step records by tool name, screen, testId, or accessibility names. Default searches all sessions.",
    handler: handleKnowledgeSearch as ToolHandler,
  },
  knowledge_summarize: {
    schema: knowledgeSummarizeInputSchema,
    description: "Generate a recipe-like summary of steps taken in a session.",
    handler: handleKnowledgeSummarize as ToolHandler,
  },
  knowledge_sessions: {
    schema: knowledgeSessionsInputSchema,
    description:
      "List recent sessions with metadata for cross-session knowledge retrieval.",
    handler: handleKnowledgeSessions as ToolHandler,
  },
  seed_contract: {
    schema: seedContractInputSchema,
    description:
      "Deploy a smart contract to the local Anvil node. Available: hst (ERC20 TST token), nfts (ERC721), erc1155, piggybank, failing (reverts), multisig, entrypoint (ERC-4337), simpleAccountFactory, verifyingPaymaster.",
    handler: createSeedContractHandler(),
  },
  seed_contracts: {
    schema: seedContractsInputSchema,
    description: "Deploy multiple smart contracts in sequence.",
    handler: createSeedContractsHandler(),
  },
  get_contract_address: {
    schema: getContractAddressInputSchema,
    description: "Get the deployed address of a smart contract.",
    handler: createGetContractAddressHandler(),
  },
  list_contracts: {
    schema: listDeployedContractsInputSchema,
    description: "List all smart contracts deployed in this session.",
    handler: createListDeployedContractsHandler(),
  },
  run_steps: {
    schema: runStepsInputSchema,
    description:
      "Execute multiple tools in sequence. Reduces round trips for multi-step flows.",
    handler: handleRunSteps as ToolHandler,
  },
  set_context: {
    schema: setContextInputSchema,
    description:
      "Switch workflow context (e2e or prod). Cannot switch during active session.",
    handler: handleSetContext as ToolHandler,
  },
  get_context: {
    schema: getContextInputSchema,
    description:
      "Get current context, available capabilities, and whether context can be switched.",
    handler: handleGetContext as ToolHandler,
  },
  clipboard: {
    schema: clipboardInputSchema,
    description:
      "Write text to or read text from the browser clipboard. Use action='write' with text parameter to write, or action='read' to read current clipboard content. Useful for pasting SRP or other data into components that have paste handlers.",
    handler: handleClipboard as ToolHandler,
  },
};

/**
 * Zod v4's toJSONSchema() marks properties with defaults as required.
 * This is incorrect for MCP tool input schemas where LLM clients shouldn't
 * be required to provide values that have defaults. This function recursively
 * removes those properties from the required array.
 */
function removeDefaultsFromRequired(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };

  if (Array.isArray(result.allOf)) {
    result.allOf = result.allOf.map((item: Record<string, unknown>) =>
      removeDefaultsFromRequired(item),
    );
  }

  if (Array.isArray(result.anyOf)) {
    result.anyOf = result.anyOf.map((item: Record<string, unknown>) =>
      removeDefaultsFromRequired(item),
    );
  }

  if (Array.isArray(result.oneOf)) {
    result.oneOf = result.oneOf.map((item: Record<string, unknown>) =>
      removeDefaultsFromRequired(item),
    );
  }

  if (
    result.properties &&
    typeof result.properties === "object" &&
    result.properties !== null
  ) {
    const newProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      result.properties as Record<string, unknown>,
    )) {
      if (value && typeof value === "object") {
        newProperties[key] = removeDefaultsFromRequired(
          value as Record<string, unknown>,
        );
      } else {
        newProperties[key] = value;
      }
    }
    result.properties = newProperties;
  }

  if (
    Array.isArray(result.required) &&
    result.properties &&
    typeof result.properties === "object"
  ) {
    const properties = result.properties as Record<
      string,
      Record<string, unknown>
    >;
    result.required = result.required.filter((propName: string) => {
      const prop = properties[propName];
      return prop && !("default" in prop);
    });

    if ((result.required as string[]).length === 0) {
      delete result.required;
    }
  }

  return result;
}

/**
 * MCP protocol doesn't support allOf/oneOf/anyOf at the top level of input schemas.
 * This flattens allOf into a single merged object schema.
 */
function flattenTopLevelAllOf(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(schema.allOf)) {
    return schema;
  }

  const mergedProperties: Record<string, unknown> = {};
  const mergedRequired: string[] = [];

  for (const subSchema of schema.allOf as Record<string, unknown>[]) {
    if (subSchema.properties && typeof subSchema.properties === "object") {
      Object.assign(mergedProperties, subSchema.properties);
    }
    if (Array.isArray(subSchema.required)) {
      mergedRequired.push(...subSchema.required);
    }
  }

  const result: Record<string, unknown> = {
    type: "object",
    properties: mergedProperties,
    additionalProperties: false,
  };

  if (mergedRequired.length > 0) {
    result.required = [...new Set(mergedRequired)];
  }

  return result;
}

function zodSchemaToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  const jsonSchema = schema.toJSONSchema();
  const { $schema: _, ...rest } = jsonSchema;

  const flattened = flattenTopLevelAllOf(rest);

  if (flattened.type === "object" && !("additionalProperties" in flattened)) {
    flattened.additionalProperties = false;
  }

  return removeDefaultsFromRequired(flattened);
}

export function getToolDefinitions(): ToolDefinition[] {
  return Object.entries(tools).map(([baseName, tool]) => ({
    name: `${TOOL_PREFIX}_${baseName}`,
    description: tool.description,
    inputSchema: zodSchemaToJsonSchema(tool.schema),
  }));
}

export function getToolHandler(name: string): ToolHandler | undefined {
  const prefixedMatch = Object.entries(tools).find(
    ([baseName]) => `${TOOL_PREFIX}_${baseName}` === name,
  );
  if (prefixedMatch) {
    return prefixedMatch[1].handler;
  }

  const tool = tools[name];
  return tool?.handler;
}

export function hasToolHandler(name: string): boolean {
  return getToolHandler(name) !== undefined;
}

export function extractBaseName(toolName: string): string {
  const prefixWithUnderscore = `${TOOL_PREFIX}_`;
  if (toolName.startsWith(prefixWithUnderscore)) {
    return toolName.slice(prefixWithUnderscore.length);
  }
  return toolName;
}

export function validateToolInput<T = unknown>(
  toolName: string,
  input: unknown,
): T {
  const baseName = extractBaseName(toolName);
  const tool = tools[baseName];

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return tool.schema.parse(input ?? {}) as T;
}

export function safeValidateToolInput(
  toolName: string,
  input: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  const baseName = extractBaseName(toolName);
  const tool = tools[baseName];

  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  const result = tool.schema.safeParse(input ?? {});
  if (!result.success) {
    const errorMessage = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { success: false, error: errorMessage };
  }

  return { success: true, data: result.data };
}

export function getToolNames(): string[] {
  return Object.keys(tools);
}

export function getPrefixedToolNames(): string[] {
  return Object.keys(tools).map((name) => `${TOOL_PREFIX}_${name}`);
}

export function buildToolHandlersRecord(): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  for (const [baseName, tool] of Object.entries(tools)) {
    handlers[`${TOOL_PREFIX}_${baseName}`] = tool.handler;
  }
  return handlers;
}

export type { ToolEntry, ToolHandler };
