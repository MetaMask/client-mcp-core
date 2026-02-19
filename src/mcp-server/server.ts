#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getSessionManager, hasSessionManager } from './session-manager.js';
import { setToolRegistry } from './tools/batch.js';
import {
  getToolDefinitions,
  getToolHandler,
  safeValidateToolInput,
  buildToolHandlersRecord,
  TOOL_PREFIX,
} from './tools/definitions.js';
import type { ToolDefinition } from './tools/definitions.js';
import { ErrorCodes } from './types';
import { createErrorResponse } from './utils';

export type McpServerConfig = {
  name: string;
  version: string;
  onCleanup?: () => Promise<void>;
  logger?: (message: string) => void;
};

/**
 * Create a standardized error response for tool execution failures.
 *
 * @param code The error code from ErrorCodes enum
 * @param message Human-readable error message
 * @param details Optional error details object
 * @param startTime Timestamp when the operation started
 * @returns MCP-formatted error response object
 */
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
        type: 'text' as const,
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

/**
 * Create and configure an MCP server instance.
 *
 * @param config Server configuration including name, version, and optional cleanup handler
 * @returns McpServer instance with start/stop methods and tool definitions
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  const { name, version, onCleanup, logger = console.error } = config;

  const toolDefinitions = getToolDefinitions();
  const toolHandlers = buildToolHandlersRecord();

  setToolRegistry(toolHandlers);

  const validToolNames = new Set(toolDefinitions.map((tool) => tool.name));

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
          type: 'text' as const,
          text: JSON.stringify(response),
        },
      ],
      isError: !response.ok,
    };
  });

  /**
   * Handle process signals (SIGINT, SIGTERM) and perform cleanup.
   *
   * @param signal The signal name received (e.g., 'SIGINT', 'SIGTERM')
   */
  const handleSignal = async (signal: string) => {
    if (isCleaningUp) {
      return;
    }
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
      logger(`Cleanup error: ${JSON.stringify(error)}`);
    }

    process.exit(0);
  };

  process.once('SIGINT', () => {
    handleSignal('SIGINT').catch((error) => logger(`SIGINT error: ${error}`));
  });
  process.once('SIGTERM', () => {
    handleSignal('SIGTERM').catch((error) => logger(`SIGTERM error: ${error}`));
  });

  let transport: StdioServerTransport | undefined;

  return {
    /**
     * Start the MCP server and connect to stdio transport.
     *
     * @returns Promise that resolves when server is running
     */
    async start() {
      transport = new StdioServerTransport();
      await server.connect(transport);
      logger(`${name} MCP Server v${version} running on stdio`);
    },

    /**
     * Stop the MCP server and close the transport.
     *
     * @returns Promise that resolves when server is stopped
     */
    async stop() {
      if (transport) {
        await server.close();
      }
    },

    /**
     * Get the underlying MCP Server instance.
     *
     * @returns The MCP Server instance
     */
    getServer() {
      return server;
    },

    /**
     * Get all available tool definitions.
     *
     * @returns Array of tool definitions
     */
    getToolDefinitions() {
      return toolDefinitions;
    },

    /**
     * Get the tool name prefix (e.g., 'mm_').
     *
     * @returns The tool prefix string
     */
    getToolPrefix() {
      return TOOL_PREFIX;
    },
  };
}
