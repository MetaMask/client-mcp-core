/* eslint-disable @typescript-eslint/naming-convention */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

import { createMcpServer } from './server.js';
import type { McpServerConfig } from './server.js';
import * as sessionManagerModule from './session-manager.js';
import { flushPromises } from './test-utils';
import * as batchModule from './tools/batch.js';
import * as definitionsModule from './tools/definitions.js';
import { ErrorCodes } from './types';

vi.mock('@modelcontextprotocol/sdk/server/index.js');
vi.mock('@modelcontextprotocol/sdk/server/stdio.js');
vi.mock('./session-manager.js');
vi.mock('./tools/definitions.js');
vi.mock('./tools/batch.js');

describe('createMcpServer', () => {
  let processExitSpy: MockInstance;
  let processOnceSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let signalHandlers: Map<string, () => void>;
  let mockSetRequestHandler: ReturnType<typeof vi.fn>;
  let mockConnect: ReturnType<typeof vi.fn>;
  let mockClose: ReturnType<typeof vi.fn>;

  const mockToolDefinitions = [
    { name: 'mm_click', description: 'Click element', inputSchema: {} },
    { name: 'mm_type', description: 'Type text', inputSchema: {} },
  ];

  const mockToolHandlers = {
    mm_click: vi
      .fn()
      .mockResolvedValue({ ok: true, result: { clicked: true } }),
    mm_type: vi.fn().mockResolvedValue({ ok: true, result: { typed: true } }),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSetRequestHandler = vi.fn();
    mockConnect = vi.fn().mockResolvedValue(undefined);
    mockClose = vi.fn().mockResolvedValue(undefined);

    vi.mocked(Server).mockImplementation(
      () =>
        ({
          setRequestHandler: mockSetRequestHandler,
          connect: mockConnect,
          close: mockClose,
        }) as unknown as InstanceType<typeof Server>,
    );

    vi.mocked(StdioServerTransport).mockImplementation(
      () =>
        ({
          type: 'stdio',
        }) as unknown as InstanceType<typeof StdioServerTransport>,
    );

    vi.mocked(sessionManagerModule.getSessionManager).mockReturnValue({
      getSessionId: vi.fn().mockReturnValue('test-session-123'),
      cleanup: vi.fn().mockResolvedValue(true),
    } as unknown as ReturnType<typeof sessionManagerModule.getSessionManager>);
    vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(true);

    vi.mocked(definitionsModule.getToolDefinitions).mockReturnValue(
      mockToolDefinitions,
    );
    vi.mocked(definitionsModule.buildToolHandlersRecord).mockReturnValue(
      mockToolHandlers,
    );
    vi.mocked(definitionsModule.getToolHandler).mockReturnValue(
      vi.fn().mockResolvedValue({ ok: true, result: {} }),
    );
    vi.mocked(definitionsModule.safeValidateToolInput).mockReturnValue({
      success: true,
      data: {},
    });
    (definitionsModule as { TOOL_PREFIX: string }).TOOL_PREFIX = 'mm';

    vi.mocked(batchModule.setToolRegistry).mockImplementation(() => {});

    signalHandlers = new Map();
    processOnceSpy = vi
      .spyOn(process, 'once')
      .mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          signalHandlers.set(String(event), handler as () => void);
          return process;
        },
      );

    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(
        (_code?: string | number | null | undefined): never => {
          throw new Error(`process.exit(${_code})`);
        },
      );

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('factory function', () => {
    it('creates server with required config', () => {
      const config: McpServerConfig = {
        name: 'test-server',
        version: '1.0.0',
      };

      const server = createMcpServer(config);

      expect(server).toBeDefined();
      expect(server.start).toBeInstanceOf(Function);
      expect(server.stop).toBeInstanceOf(Function);
      expect(server.getServer).toBeInstanceOf(Function);
      expect(server.getToolDefinitions).toBeInstanceOf(Function);
      expect(server.getToolPrefix).toBeInstanceOf(Function);
    });

    it('creates Server with name and version', () => {
      const config: McpServerConfig = {
        name: 'my-extension',
        version: '2.0.0',
      };

      createMcpServer(config);

      expect(Server).toHaveBeenCalledWith(
        { name: 'my-extension', version: '2.0.0' },
        { capabilities: { tools: {} } },
      );
    });

    it('registers ListTools and CallTool request handlers', () => {
      createMcpServer({
        name: 'test-server',
        version: '1.0.0',
      });

      expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
    });

    it('registers signal handlers for SIGINT and SIGTERM', () => {
      createMcpServer({
        name: 'test-server',
        version: '1.0.0',
      });

      expect(processOnceSpy).toHaveBeenCalledWith(
        'SIGINT',
        expect.any(Function),
      );
      expect(processOnceSpy).toHaveBeenCalledWith(
        'SIGTERM',
        expect.any(Function),
      );
    });
  });

  describe('getServer()', () => {
    it('returns the underlying MCP Server instance', () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });

      const mcpServer = server.getServer();

      expect(mcpServer).toBeDefined();
      expect(mcpServer.setRequestHandler).toBeInstanceOf(Function);
      expect(mcpServer.connect).toBeInstanceOf(Function);
      expect(mcpServer.close).toBeInstanceOf(Function);
    });
  });

  describe('getToolDefinitions()', () => {
    it('returns all tool definitions', () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });

      const toolDefs = server.getToolDefinitions();

      expect(toolDefs).toStrictEqual(mockToolDefinitions);
    });
  });

  describe('getToolPrefix()', () => {
    it('returns the tool prefix', () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });

      const prefix = server.getToolPrefix();

      expect(prefix).toBe('mm');
    });
  });

  describe('start()', () => {
    it('creates StdioServerTransport and connects', async () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });

      await server.start();

      expect(StdioServerTransport).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalled();
    });

    it('logs server startup message', async () => {
      const customLogger = vi.fn();
      const server = createMcpServer({
        name: 'my-server',
        version: '2.0.0',
        logger: customLogger,
      });

      await server.start();

      expect(customLogger).toHaveBeenCalledWith(
        'my-server MCP Server v2.0.0 running on stdio',
      );
    });

    it('uses console.error as default logger', async () => {
      const server = createMcpServer({
        name: 'test-server',
        version: '1.0.0',
      });

      await server.start();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'test-server MCP Server v1.0.0 running on stdio',
      );
    });
  });

  describe('stop()', () => {
    it('closes server when transport exists', async () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });
      await server.start();

      await server.stop();

      expect(mockClose).toHaveBeenCalled();
    });

    it('does nothing when transport does not exist', async () => {
      const server = createMcpServer({ name: 'test', version: '1.0.0' });

      await server.stop();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe('ListToolsRequestSchema handler', () => {
    it('returns tool definitions', async () => {
      createMcpServer({ name: 'test', version: '1.0.0' });

      const listToolsHandler = mockSetRequestHandler.mock.calls[0][1];

      const result = await listToolsHandler();

      expect(result).toStrictEqual({
        tools: mockToolDefinitions,
      });
    });
  });

  describe('CallToolRequestSchema handler', () => {
    let callToolHandler: (
      request: {
        params: { name: string; arguments?: Record<string, unknown> };
      },
      extra?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    beforeEach(() => {
      createMcpServer({ name: 'test', version: '1.0.0' });
      callToolHandler = mockSetRequestHandler.mock.calls[1][1];
    });

    it('returns error for unknown tool', async () => {
      const result = await callToolHandler({
        params: { name: 'mm_unknown', arguments: {} },
      });

      expect(result).toMatchObject({
        content: [{ type: 'text' }],
        isError: true,
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
      expect(responseText.error.message).toContain('Unknown tool: mm_unknown');
    });

    it('returns error for invalid input', async () => {
      vi.mocked(definitionsModule.safeValidateToolInput).mockReturnValueOnce({
        success: false,
        error: 'name: Required',
      });

      const result = await callToolHandler({
        params: { name: 'mm_click', arguments: {} },
      });

      expect(result).toMatchObject({
        content: [{ type: 'text' }],
        isError: true,
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
      expect(responseText.error.message).toContain(
        'Invalid input: name: Required',
      );
    });

    it('returns error when no handler registered', async () => {
      vi.mocked(definitionsModule.getToolHandler).mockReturnValueOnce(
        undefined,
      );

      const result = await callToolHandler({
        params: { name: 'mm_click', arguments: {} },
      });

      expect(result).toMatchObject({
        content: [{ type: 'text' }],
        isError: true,
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
      expect(responseText.error.message).toContain(
        'No handler registered for tool: mm_click',
      );
    });

    it('executes handler and returns success response', async () => {
      const mockHandler = vi
        .fn()
        .mockResolvedValue({ ok: true, result: { clicked: true } });
      vi.mocked(definitionsModule.getToolHandler).mockReturnValueOnce(
        mockHandler,
      );

      const result = await callToolHandler({
        params: { name: 'mm_click', arguments: { testId: 'btn' } },
      });

      expect(result).toMatchObject({
        content: [{ type: 'text' }],
        isError: false,
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.ok).toBe(true);
      expect(responseText.result.clicked).toBe(true);
    });

    it('passes signal to handler', async () => {
      const mockHandler = vi.fn().mockResolvedValue({ ok: true, result: {} });
      vi.mocked(definitionsModule.getToolHandler).mockReturnValueOnce(
        mockHandler,
      );
      const mockSignal = new AbortController().signal;

      await callToolHandler(
        { params: { name: 'mm_click', arguments: {} } },
        { signal: mockSignal },
      );

      expect(mockHandler).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: mockSignal }),
      );
    });

    it('returns isError: true when handler returns ok: false', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'MM_CLICK_FAILED', message: 'Click failed' },
      });
      vi.mocked(definitionsModule.getToolHandler).mockReturnValueOnce(
        mockHandler,
      );

      const result = await callToolHandler({
        params: { name: 'mm_click', arguments: {} },
      });

      expect(result).toMatchObject({
        isError: true,
      });
    });

    it('includes sessionId in error response when session manager available', async () => {
      vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(true);
      vi.mocked(sessionManagerModule.getSessionManager).mockReturnValue({
        getSessionId: vi.fn().mockReturnValue('session-abc'),
        cleanup: vi.fn(),
      } as unknown as ReturnType<
        typeof sessionManagerModule.getSessionManager
      >);

      const result = await callToolHandler({
        params: { name: 'mm_unknown', arguments: {} },
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.meta.sessionId).toBe('session-abc');
    });

    it('does not include sessionId when no session manager', async () => {
      vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(false);

      const result = await callToolHandler({
        params: { name: 'mm_unknown', arguments: {} },
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.meta.sessionId).toBeUndefined();
    });
  });

  describe('signal handlers', () => {
    it('calls cleanup on SIGINT', async () => {
      const onCleanup = vi.fn().mockResolvedValue(undefined);
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        onCleanup,
      });

      const sigintHandler = signalHandlers.get('SIGINT');
      expect(sigintHandler).toBeDefined();

      try {
        sigintHandler?.();
        await flushPromises();
      } catch (e) {
        expect((e as Error).message).toBe('process.exit(0)');
      }

      expect(onCleanup).toHaveBeenCalled();
    });

    it('calls cleanup on SIGTERM', async () => {
      const onCleanup = vi.fn().mockResolvedValue(undefined);
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        onCleanup,
      });

      const sigtermHandler = signalHandlers.get('SIGTERM');
      expect(sigtermHandler).toBeDefined();

      try {
        sigtermHandler?.();
        await flushPromises();
      } catch (e) {
        expect((e as Error).message).toBe('process.exit(0)');
      }

      expect(onCleanup).toHaveBeenCalled();
    });

    it('cleans up session manager if available', async () => {
      const mockCleanup = vi.fn().mockResolvedValue(true);
      vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(true);
      vi.mocked(sessionManagerModule.getSessionManager).mockReturnValue({
        getSessionId: vi.fn().mockReturnValue('session-abc'),
        cleanup: mockCleanup,
      } as unknown as ReturnType<
        typeof sessionManagerModule.getSessionManager
      >);

      createMcpServer({
        name: 'test',
        version: '1.0.0',
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      await flushPromises();

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('does not call session cleanup when no session manager', async () => {
      const mockCleanup = vi.fn();
      vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(false);

      createMcpServer({
        name: 'test',
        version: '1.0.0',
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      await flushPromises();

      expect(mockCleanup).not.toHaveBeenCalled();
    });

    it('prevents duplicate cleanup calls', async () => {
      const onCleanup = vi.fn().mockResolvedValue(undefined);
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        onCleanup,
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      sigintHandler?.();
      await flushPromises();

      expect(onCleanup).toHaveBeenCalledTimes(1);
    });

    it('logs cleanup message', async () => {
      const customLogger = vi.fn();
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        logger: customLogger,
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      await flushPromises();

      expect(customLogger).toHaveBeenCalledWith(
        'Received SIGINT, cleaning up...',
      );
    });

    it('logs cleanup errors', async () => {
      const customLogger = vi.fn();
      const onCleanup = vi.fn().mockRejectedValue(new Error('Cleanup failed'));
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        onCleanup,
        logger: customLogger,
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      await flushPromises();

      expect(customLogger).toHaveBeenCalledWith(
        expect.stringContaining('Cleanup error:'),
      );
    });

    it('exits with code 0 after cleanup', async () => {
      createMcpServer({
        name: 'test',
        version: '1.0.0',
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      try {
        sigintHandler?.();
        await flushPromises();
      } catch (e) {
        expect((e as Error).message).toBe('process.exit(0)');
      }

      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('handles signal error gracefully', async () => {
      const customLogger = vi.fn();
      const onCleanup = vi.fn().mockImplementation(() => {
        throw new Error('Sync error');
      });
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        onCleanup,
        logger: customLogger,
      });

      const sigintHandler = signalHandlers.get('SIGINT');

      sigintHandler?.();
      await flushPromises();

      expect(customLogger).toHaveBeenCalledWith(
        expect.stringContaining('Cleanup error:'),
      );
    });
  });

  describe('tool registry', () => {
    it('sets tool registry with handlers', () => {
      createMcpServer({ name: 'test', version: '1.0.0' });

      expect(batchModule.setToolRegistry).toHaveBeenCalledWith(
        mockToolHandlers,
      );
    });
  });

  describe('createToolErrorResponse helper', () => {
    it('formats error with sessionId from session manager', async () => {
      vi.mocked(sessionManagerModule.hasSessionManager).mockReturnValue(true);
      vi.mocked(sessionManagerModule.getSessionManager).mockReturnValue({
        getSessionId: vi.fn().mockReturnValue('my-session'),
        cleanup: vi.fn(),
      } as unknown as ReturnType<
        typeof sessionManagerModule.getSessionManager
      >);

      createMcpServer({ name: 'test', version: '1.0.0' });
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1];

      const result = await callToolHandler({
        params: { name: 'mm_invalid', arguments: {} },
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.meta.sessionId).toBe('my-session');
      expect(responseText.meta.timestamp).toBeDefined();
      expect(responseText.meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes error details when provided', async () => {
      vi.mocked(definitionsModule.safeValidateToolInput).mockReturnValueOnce({
        success: false,
        error: 'validation error',
      });

      createMcpServer({ name: 'test', version: '1.0.0' });
      const callToolHandler = mockSetRequestHandler.mock.calls[1][1];

      const result = await callToolHandler({
        params: { name: 'mm_click', arguments: { invalid: 'arg' } },
      });

      const responseText = JSON.parse(
        (result as { content: [{ text: string }] }).content[0].text,
      );
      expect(responseText.error.details).toStrictEqual({
        providedArgs: { invalid: 'arg' },
      });
    });
  });
});
