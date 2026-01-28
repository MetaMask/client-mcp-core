#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getToolDefinitions,
  getToolHandler,
  safeValidateToolInput,
  buildToolHandlersRecord,
  TOOL_PREFIX,
  type ToolDefinition,
} from "./tools/definitions.js";
import { ErrorCodes } from "./types/index.js";
import { createErrorResponse } from "./utils/index.js";
import { getSessionManager, hasSessionManager } from "./session-manager.js";
import { setToolRegistry } from "./tools/batch.js";

export type McpServerConfig = {
  name: string;
  version: string;
  onCleanup?: () => Promise<void>;
  logger?: (message: string) => void;
};

function createToolErrorResponse(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  details: Record<string, unknown> | undefined,
  startTime: number,
) {
  const sessionId = hasSessionManager()
    ? getSessionManager().getSessionId()
    : undefined;

  const response = createErrorResponse(
    code,
    message,
    details,
    sessionId,
    startTime,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(response),
      },
    ],
    isError: true,
  };
}

export type McpServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getServer(): Server;
  getToolDefinitions(): ToolDefinition[];
  getToolPrefix(): string;
};

export function createMcpServer(config: McpServerConfig): McpServer {
  const { name, version, onCleanup, logger = console.error } = config;

  const toolDefinitions = getToolDefinitions();
  const toolHandlers = buildToolHandlersRecord();

  setToolRegistry(toolHandlers);

  const validToolNames = new Set(toolDefinitions.map((t) => t.name));

  const server = new Server({ name, version }, { capabilities: { tools: {} } });

  let isCleaningUp = false;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: toolName, arguments: args } = request.params;
    const startTime = Date.now();
    const signal = extra?.signal;

    if (!validToolNames.has(toolName)) {
      return createToolErrorResponse(
        ErrorCodes.MM_INVALID_INPUT,
        `Unknown tool: ${toolName}`,
        undefined,
        startTime,
      );
    }

    const validation = safeValidateToolInput(toolName, args);
    if (!validation.success) {
      return createToolErrorResponse(
        ErrorCodes.MM_INVALID_INPUT,
        `Invalid input: ${validation.error}`,
        { providedArgs: args },
        startTime,
      );
    }

    const handler = getToolHandler(toolName);

    if (!handler) {
      return createToolErrorResponse(
        ErrorCodes.MM_INVALID_INPUT,
        `No handler registered for tool: ${toolName}`,
        undefined,
        startTime,
      );
    }

    const response = await handler(validation.data as Record<string, unknown>, {
      signal,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response),
        },
      ],
      isError: !response.ok,
    };
  });

  const handleSignal = async (signal: string) => {
    if (isCleaningUp) return;
    isCleaningUp = true;

    logger(`Received ${signal}, cleaning up...`);

    try {
      if (onCleanup) {
        await onCleanup();
      }

      if (hasSessionManager()) {
        await getSessionManager().cleanup();
      }
    } catch (error) {
      logger(`Cleanup error: ${error}`);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  let transport: StdioServerTransport | undefined;

  return {
    async start() {
      transport = new StdioServerTransport();
      await server.connect(transport);
      logger(`${name} MCP Server v${version} running on stdio`);
    },

    async stop() {
      if (transport) {
        await server.close();
      }
    },

    getServer() {
      return server;
    },

    getToolDefinitions() {
      return toolDefinitions;
    },

    getToolPrefix() {
      return TOOL_PREFIX;
    },
  };
}

export type { ToolRegistry, ToolHandler } from "./tools/batch.js";
