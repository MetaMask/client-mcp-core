import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { ServerInstance } from './create-server.js';
import {
  createServer,
  buildResponseBody,
  shouldCollectObservations,
  shouldIncludeObservationsInResponse,
} from './create-server.js';
import { readDaemonState } from './daemon-state.js';
import pkg from '../../package.json';
import type { PortMap, WorkflowContext } from '../capabilities/context.js';
import type { DaemonState, ServerConfig, ToolResponse } from '../types/http.js';

const tmpDir = path.join(os.tmpdir(), `mm-create-server-test-${Date.now()}`);

vi.mock('node:child_process', () => ({
  execSync: () => Buffer.from(`${tmpDir}\n`),
}));

vi.mock('../tools/utils/discovery.js', () => ({
  collectTestIds: vi.fn().mockResolvedValue([]),
  collectTrimmedA11ySnapshot: vi.fn().mockResolvedValue({
    nodes: [],
    refMap: new Map(),
  }),
  waitForTarget: vi.fn().mockResolvedValue({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue(''),
  }),
}));

function createMockSessionManager() {
  return {
    hasActiveSession: vi.fn(() => false),
    getSessionId: vi.fn(() => 'test-session'),
    getSessionState: vi.fn(() => undefined),
    getSessionMetadata: vi.fn(() => undefined),
    launch: vi.fn(async () => ({
      sessionId: 'test-session',
      extensionId: 'test-ext',
      state: {},
    })),
    cleanup: vi.fn(async () => true),
    getPage: vi.fn(() => ({
      waitForLoadState: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      isClosed: vi.fn(() => false),
      viewportSize: vi.fn(() => ({ width: 800, height: 600 })),
      locator: vi.fn(() => ({
        count: vi.fn(async () => 0),
        first: () => ({
          isVisible: vi.fn(async () => false),
          isEnabled: vi.fn(async () => false),
          boundingBox: vi.fn(async () => null),
        }),
      })),
    })),
    setActivePage: vi.fn(),
    getTrackedPages: vi.fn(() => []),
    classifyPageRole: vi.fn(() => 'extension'),
    getContext: vi.fn(() => ({})),
    getExtensionId: vi.fn(() => 'test-ext'),
    getExtensionState: vi.fn(async () => ({})),
    waitForNotificationPage: vi.fn(async () => ({
      url: () => 'chrome-extension://test/notification.html',
    })),
    takeScreenshot: vi.fn(async () => ({ path: '', base64: '' })),
    getRefMap: vi.fn(() => new Map()),
    setRefMap: vi.fn(),
    setWorkflowContext: vi.fn(),
    getEnvironmentMode: vi.fn(() => 'e2e'),
    setContext: vi.fn(),
    getContextInfo: vi.fn(() => ({
      currentContext: 'e2e',
      hasActiveSession: false,
      sessionId: null,
      capabilities: { available: [] },
      canSwitchContext: true,
    })),
    getPlatformDriver: vi.fn().mockReturnValue(undefined),
  };
}

let exitSpy: MockInstance;

function buildConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    sessionManager:
      createMockSessionManager() as unknown as ServerConfig['sessionManager'],
    contextFactory: async () =>
      ({
        config: { environment: 'prod', extensionName: 'Test Extension' },
      }) satisfies WorkflowContext,
    ...overrides,
  };
}

async function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(data) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('buildResponseBody', () => {
  it('returns toolResult as-is for non-object', () => {
    expect(buildResponseBody('string', undefined)).toBe('string');
    expect(buildResponseBody(null, undefined)).toBeNull();
  });

  it('returns toolResult when no observations', () => {
    const result = { ok: true, data: 'test' };
    expect(buildResponseBody(result, undefined)).toStrictEqual(result);
  });

  it('merges observations into result', () => {
    const result = { ok: true };
    const obs = { state: {}, testIds: [], a11y: { nodes: [] } };
    expect(buildResponseBody(result, obs as any)).toStrictEqual({
      ok: true,
      observations: obs,
    });
  });
});

describe('shouldCollectObservations', () => {
  it('returns true for mutating', () => {
    expect(shouldCollectObservations('mutating')).toBe(true);
  });

  it('returns true for readonly', () => {
    expect(shouldCollectObservations('readonly')).toBe(true);
  });

  it('returns true for discovery', () => {
    expect(shouldCollectObservations('discovery')).toBe(true);
  });

  it('returns true for batch with default policy', () => {
    expect(shouldCollectObservations('batch')).toBe(true);
  });

  it("returns true for batch with 'all' policy", () => {
    expect(
      shouldCollectObservations('batch', { includeObservations: 'all' }),
    ).toBe(true);
  });

  it("returns false for batch with 'none' policy", () => {
    expect(
      shouldCollectObservations('batch', { includeObservations: 'none' }),
    ).toBe(false);
  });

  it("returns true for batch with 'failures' policy", () => {
    expect(
      shouldCollectObservations('batch', { includeObservations: 'failures' }),
    ).toBe(true);
  });
});

describe('shouldIncludeObservationsInResponse', () => {
  const okResult: ToolResponse = { ok: true, result: {} };
  const failResult: ToolResponse = {
    ok: false,
    error: { code: 'ERR', message: 'fail' },
  };
  const summaryFailResult: ToolResponse = {
    ok: true,
    result: { summary: { ok: false } },
  };

  it('returns true for mutating', () => {
    expect(shouldIncludeObservationsInResponse('mutating', okResult)).toBe(
      true,
    );
  });

  it('returns false for readonly', () => {
    expect(shouldIncludeObservationsInResponse('readonly', okResult)).toBe(
      false,
    );
  });

  it('returns false for discovery', () => {
    expect(shouldIncludeObservationsInResponse('discovery', okResult)).toBe(
      false,
    );
  });

  it("returns true for batch with 'all' (default)", () => {
    expect(shouldIncludeObservationsInResponse('batch', okResult, {})).toBe(
      true,
    );
  });

  it("returns false for batch with 'none'", () => {
    expect(
      shouldIncludeObservationsInResponse('batch', okResult, {
        includeObservations: 'none',
      }),
    ).toBe(false);
  });

  it("returns true for batch with 'failures' when tool failed", () => {
    expect(
      shouldIncludeObservationsInResponse('batch', failResult, {
        includeObservations: 'failures',
      }),
    ).toBe(true);
  });

  it("returns true for batch with 'failures' when summary.ok is false", () => {
    expect(
      shouldIncludeObservationsInResponse('batch', summaryFailResult, {
        includeObservations: 'failures',
      }),
    ).toBe(true);
  });

  it("returns false for batch with 'failures' when tool succeeded", () => {
    const batchOk: ToolResponse = {
      ok: true,
      result: { summary: { ok: true } },
    };
    expect(
      shouldIncludeObservationsInResponse('batch', batchOk, {
        includeObservations: 'failures',
      }),
    ).toBe(false);
  });

  it("returns false for batch with 'failures' when summary is missing", () => {
    expect(
      shouldIncludeObservationsInResponse('batch', okResult, {
        includeObservations: 'failures',
      }),
    ).toBe(false);
  });
});

describe('createServer integration', () => {
  let server: ServerInstance;
  let state: DaemonState;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    server = createServer(buildConfig());
    state = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    exitSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('gET /health returns 200 with status and nonce', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/health`);
    const body = (await res.json()) as { status: string; nonce: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.nonce).toBe(state.nonce);
  });

  it('gET /status returns daemon info', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/status`);
    const body = (await res.json()) as {
      daemon: { pid: number; port: number };
      ports: PortMap;
    };

    expect(res.status).toBe(200);
    expect(body.daemon.pid).toBe(process.pid);
    expect(body.daemon.port).toBe(state.port);
    expect(body.ports).toStrictEqual({});
  });

  it('pOST /launch delegates to session manager', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'default' }),
    });
    const body = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('pOST /cleanup delegates to session manager', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('pOST /tool/nonexistent returns 404', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/nonexistent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('writes .mm-server on start', async () => {
    const daemonState = await readDaemonState(tmpDir);
    expect(daemonState).not.toBeNull();
    expect(daemonState?.port).toBe(state.port);
    expect(daemonState?.nonce).toBe(state.nonce);
    expect(daemonState?.version).toBe(pkg.version);
  });

  it('passes workflow context to session manager on start', async () => {
    await server.stop();

    const workflowContext: WorkflowContext = {
      config: { environment: 'e2e', extensionName: 'Test Extension' },
    };
    const mockSM = createMockSessionManager();
    const customServer = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        contextFactory: vi.fn().mockResolvedValue(workflowContext),
      }),
    );

    await customServer.start();
    expect(mockSM.setWorkflowContext).toHaveBeenCalledWith(workflowContext);
    await customServer.stop();
  });

  it('fails startup when contextFactory rejects', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi
          .fn<ServerConfig['contextFactory']>()
          .mockRejectedValue(new Error('port allocation failed')),
      }),
    );

    await expect(customServer.start()).rejects.toThrowError(
      'contextFactory failed during server startup: port allocation failed',
    );
  });

  it('preserves original error as cause when contextFactory rejects', async () => {
    await server.stop();

    const cause = new Error('root cause');
    const customServer = createServer(
      buildConfig({
        contextFactory: vi
          .fn<ServerConfig['contextFactory']>()
          .mockRejectedValue(cause),
      }),
    );

    await expect(customServer.start()).rejects.toThrowError(
      expect.objectContaining({ cause }),
    );
  });

  it('fails startup when contextFactory resolves with null', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi.fn().mockResolvedValue(null),
      }),
    );

    await expect(customServer.start()).rejects.toThrowError(
      'contextFactory must return an object with a valid config.environment field',
    );
  });

  it('fails startup when contextFactory resolves without config', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi.fn().mockResolvedValue({}),
      }),
    );

    await expect(customServer.start()).rejects.toThrowError(
      'contextFactory must return an object with a valid config.environment field',
    );
  });

  it('fails startup when allocatedPorts contains non-number values', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi.fn().mockResolvedValue({
          config: { environment: 'prod', extensionName: 'Test' },
          allocatedPorts: { bad: 'not-a-number' },
        }),
      }),
    );

    await expect(customServer.start()).rejects.toThrowError(
      'allocatedPorts["bad"] must be a finite number',
    );
  });

  it('does not call setWorkflowContext when contextFactory rejects', async () => {
    await server.stop();

    const mockSM = createMockSessionManager();
    const customServer = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        contextFactory: vi
          .fn<ServerConfig['contextFactory']>()
          .mockRejectedValue(new Error('boom')),
      }),
    );

    await customServer.start().catch(() => {});
    expect(mockSM.setWorkflowContext).not.toHaveBeenCalled();
  });

  it('does not write .mm-server when contextFactory rejects', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi
          .fn<ServerConfig['contextFactory']>()
          .mockRejectedValue(new Error('boom')),
      }),
    );

    await customServer.start().catch(() => {});
    const daemonState = await readDaemonState(tmpDir);
    expect(daemonState).toBeNull();
  });

  it('cleans up session when startup fails after contextFactory succeeds', async () => {
    await server.stop();

    const mockSM = createMockSessionManager();
    const customServer = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        contextFactory: vi.fn().mockResolvedValue({
          config: { environment: 'prod', extensionName: 'Test' },
        } satisfies WorkflowContext),
      }),
    );

    await fs.chmod(tmpDir, 0o444);
    try {
      await expect(customServer.start()).rejects.toThrowError(/EACCES/u);
      expect(mockSM.cleanup).toHaveBeenCalled();
    } finally {
      await fs.chmod(tmpDir, 0o755).catch(() => {});
    }
  });

  it('accepts a synchronous contextFactory', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: () => ({
          config: { environment: 'prod' as const, extensionName: 'Sync' },
        }),
      }),
    );

    const customState = await customServer.start();
    expect(customState.port).toBeGreaterThan(0);
    await customServer.stop();
  });

  it('gET /status returns empty ports when allocatedPorts is undefined', async () => {
    await server.stop();

    const customServer = createServer(
      buildConfig({
        contextFactory: vi.fn().mockResolvedValue({
          config: { environment: 'prod', extensionName: 'Test Extension' },
        } satisfies WorkflowContext),
      }),
    );

    const customState = await customServer.start();
    const res = await httpRequest(
      `http://127.0.0.1:${customState.port}/status`,
    );
    const body = (await res.json()) as { ports: PortMap };

    expect(res.status).toBe(200);
    expect(body.ports).toStrictEqual({});

    await customServer.stop();
  });

  it('gET /status returns custom allocated ports', async () => {
    await server.stop();

    const allocatedPorts = { serviceA: 3001, serviceB: 3002 };
    const customServer = createServer(
      buildConfig({
        contextFactory: vi.fn().mockResolvedValue({
          config: { environment: 'prod', extensionName: 'Test Extension' },
          allocatedPorts,
        } satisfies WorkflowContext),
      }),
    );

    const customState = await customServer.start();
    const res = await httpRequest(
      `http://127.0.0.1:${customState.port}/status`,
    );
    const body = (await res.json()) as { ports: PortMap };

    expect(res.status).toBe(200);
    expect(body.ports).toStrictEqual(allocatedPorts);

    await customServer.stop();
  });

  it('removes .mm-server on stop', async () => {
    await server.stop();
    const daemonState = await readDaemonState(tmpDir);
    expect(daemonState).toBeNull();
  });

  it('serializes concurrent launch requests through the queue', async () => {
    const [res1, res2] = await Promise.all([
      httpRequest(`http://127.0.0.1:${state.port}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      httpRequest(`http://127.0.0.1:${state.port}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('stop() is idempotent', async () => {
    await server.stop();
    expect(await server.stop()).toBeUndefined();
  });

  describe('POST /tool/:name input validation', () => {
    it('returns 400 for missing required field', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/click`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid enum value', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/navigate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ screen: 'nonexistent' }),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when cross-field refine fails', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/clipboard`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write' }),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain(
        "text is required when action is 'write'",
      );
    });

    it('returns 400 for wrong field type', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/wait_for_notification`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeoutMs: 'not-a-number' }),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('passes validation for valid input (empty schema)', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/get_state`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).not.toBe(400);
    });
  });
});

describe('createServer with active session', () => {
  let server: ServerInstance;
  let state: DaemonState;
  let mockSM: ReturnType<typeof createMockSessionManager>;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    mockSM = createMockSessionManager();
    mockSM.hasActiveSession.mockReturnValue(true);
    mockSM.getExtensionState.mockResolvedValue({
      isLoaded: true,
      currentUrl: 'chrome-extension://test/home.html',
    });

    server = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
      }),
    );
    state = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    exitSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('collects observations for tool execution', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { ok: boolean; observations?: unknown };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.observations).toBeDefined();
  });

  it('returns 500 when tool execution throws', async () => {
    mockSM.cleanup.mockRejectedValueOnce(new Error('Browser crash'));

    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TOOL_EXECUTION_FAILED');
    expect(body.error.message).toContain('Browser crash');
  });

  it('handles observation collection failure gracefully', async () => {
    mockSM.getPage.mockImplementation(() => {
      throw new Error('Page closed');
    });

    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('records step with environment context', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/get_state`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(200);
  });

  it('read-only tool response omits observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/get_state`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as { ok: boolean; observations?: unknown };

    expect(res.status).toBe(200);
    expect(body.observations).toBeUndefined();
  });

  it('mutating tool response includes observations with state, testIds, a11y', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: { state: unknown; testIds: unknown[]; a11y: unknown };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations?.state).toBeDefined();
    expect(body.observations?.testIds).toBeDefined();
    expect(body.observations?.a11y).toBeDefined();
  });

  it('extends queue timeout for tool-specific timeoutMs values', async () => {
    const timedServer = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        requestTimeoutMs: 50,
      }),
    );

    mockSM.waitForNotificationPage.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                url: () => 'chrome-extension://test/notification.html',
              }),
            75,
          );
        }),
    );

    const timedState = await timedServer.start();

    try {
      const res = await httpRequest(
        `http://127.0.0.1:${timedState.port}/tool/wait_for_notification`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeoutMs: 1000 }),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        result?: { found: boolean; pageUrl: string };
      };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result).toStrictEqual({
        found: true,
        pageUrl: 'chrome-extension://test/notification.html',
      });
    } finally {
      await timedServer.stop();
    }
  });

  it('observation Playwright helpers called for read-only tools', async () => {
    const { collectTestIds, collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    const collectTestIdsSpy = vi.mocked(collectTestIds);
    const collectA11ySpy = vi.mocked(collectTrimmedA11ySnapshot);

    collectTestIdsSpy.mockClear();
    collectA11ySpy.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/tool/get_state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(collectTestIdsSpy).toHaveBeenCalled();
    expect(collectA11ySpy).toHaveBeenCalled();
  });

  it('observation Playwright helpers called for mutating tools', async () => {
    const { collectTestIds, collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    const collectTestIdsSpy = vi.mocked(collectTestIds);
    const collectA11ySpy = vi.mocked(collectTrimmedA11ySnapshot);

    collectTestIdsSpy.mockClear();
    collectA11ySpy.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(collectTestIdsSpy).toHaveBeenCalled();
    expect(collectA11ySpy).toHaveBeenCalled();
  });

  describe('post-mutation state recheck', () => {
    it('resolves immediately when getExtensionState returns a known screen', async () => {
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState.mockResolvedValue({
        isLoaded: true,
        currentScreen: 'home',
        currentUrl: 'chrome-extension://test/home.html',
      });

      const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as {
        ok: boolean;
        observations?: { state: { currentScreen?: string } };
      };

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(1);
      expect(body.observations?.state.currentScreen).toBe('home');
    });

    it("retries when first call returns 'unknown', resolves on second call", async () => {
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState
        .mockResolvedValueOnce({
          isLoaded: true,
          currentScreen: 'unknown',
          currentUrl: 'chrome-extension://test/unknown.html',
        })
        .mockResolvedValueOnce({
          isLoaded: true,
          currentScreen: 'home',
          currentUrl: 'chrome-extension://test/home.html',
        });

      const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as {
        ok: boolean;
        observations?: { state: { currentScreen?: string } };
      };

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(2);
      expect(body.observations?.state.currentScreen).toBe('home');
    });

    it("retries up to deadline and returns 'unknown' if all calls return 'unknown'", async () => {
      vi.useFakeTimers();
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState.mockResolvedValue({
        isLoaded: true,
        currentScreen: 'unknown',
        currentUrl: 'chrome-extension://test/unknown.html',
      });

      const responsePromise = httpRequest(
        `http://127.0.0.1:${state.port}/cleanup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );

      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();

      const res = await responsePromise;
      const body = (await res.json()) as {
        ok: boolean;
        observations?: { state: { currentScreen?: string } };
      };

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(6);
      expect(body.observations?.state.currentScreen).toBe('unknown');
    });

    it('does not recheck for readonly tool category', async () => {
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState.mockResolvedValue({
        isLoaded: true,
        currentScreen: 'unknown',
        currentUrl: 'chrome-extension://test/unknown.html',
      });

      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/get_context`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(1);
    });

    it('does not recheck for discovery tool category', async () => {
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState.mockResolvedValue({
        isLoaded: true,
        currentScreen: 'unknown',
        currentUrl: 'chrome-extension://test/unknown.html',
      });

      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/list_testids`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(1);
    });

    it('does not recheck for batch tool category', async () => {
      mockSM.getExtensionState.mockReset();
      mockSM.getExtensionState.mockResolvedValue({
        isLoaded: true,
        currentScreen: 'unknown',
        currentUrl: 'chrome-extension://test/unknown.html',
      });

      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/run_steps`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            steps: [{ tool: 'get_context', args: {} }],
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(1);
    });
  });

  describe('meta.timing', () => {
    type TimedBody = {
      ok: boolean;
      error?: { code: string };
      meta?: {
        timing: {
          queueMs: number;
          toolMs: number;
          observationMs: number;
          totalMs: number;
        };
      };
    };

    const post = async (
      urlPath: string,
      body: string = JSON.stringify({}),
    ): Promise<{ status: number; body: TimedBody }> => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}${urlPath}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      return { status: res.status, body: (await res.json()) as TimedBody };
    };

    const expectValidTiming = (body: TimedBody): void => {
      const timing = body.meta?.timing;
      expect(timing).toBeDefined();
      for (const value of Object.values(timing ?? {})) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(timing?.totalMs).toBeGreaterThanOrEqual(
        (timing?.queueMs ?? 0) +
          (timing?.toolMs ?? 0) +
          (timing?.observationMs ?? 0),
      );
    };

    it('adds meta.timing as the last key of a successful response', async () => {
      const { status, body } = await post('/cleanup');

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expectValidTiming(body);
      expect(Object.keys(body).at(-1)).toBe('meta');
    });

    it('measures tool and observation time separately', async () => {
      mockSM.cleanup.mockImplementationOnce(
        async () =>
          new Promise((resolve) => setTimeout(() => resolve(true), 60)),
      );
      mockSM.getExtensionState.mockImplementationOnce(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ isLoaded: true, currentUrl: '' }), 60),
          ),
      );

      const { body } = await post('/cleanup');

      expectValidTiming(body);
      expect(body.meta?.timing.toolMs).toBeGreaterThanOrEqual(50);
      expect(body.meta?.timing.observationMs).toBeGreaterThanOrEqual(50);
    });

    it('reports observationMs 0 when no session is active', async () => {
      mockSM.hasActiveSession.mockReturnValue(false);

      const { body } = await post('/tool/get_context');

      expectValidTiming(body);
      expect(body.meta?.timing.observationMs).toBe(0);
    });

    it('reports queue wait for a request queued behind another', async () => {
      let releaseFirst!: () => void;
      mockSM.cleanup.mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(true);
          }),
      );

      const first = post('/cleanup');
      // The first request is now running inside the queue.
      await vi.waitFor(() => expect(mockSM.cleanup).toHaveBeenCalled());
      const second = post('/tool/get_context');
      await new Promise((resolve) => setTimeout(resolve, 60));
      releaseFirst();

      const [firstRes, secondRes] = await Promise.all([first, second]);
      expectValidTiming(firstRes.body);
      expectValidTiming(secondRes.body);
      expect(secondRes.body.meta?.timing.queueMs).toBeGreaterThanOrEqual(50);
    });

    it('includes meta.timing when the tool throws', async () => {
      mockSM.cleanup.mockRejectedValueOnce(new Error('Browser crash'));

      const { status, body } = await post('/cleanup');

      expect(status).toBe(500);
      expect(body.error?.code).toBe('TOOL_EXECUTION_FAILED');
      expectValidTiming(body);
    });

    it('includes meta.timing on validation errors', async () => {
      const { status, body } = await post('/tool/click');

      expect(status).toBe(400);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expectValidTiming(body);
      expect(body.meta?.timing.toolMs).toBe(0);
    });

    it('includes meta.timing for unknown tools', async () => {
      const { status, body } = await post('/tool/nonexistent');

      expect(status).toBe(404);
      expectValidTiming(body);
    });

    it('includes meta.timing for platform gate errors', async () => {
      const { status, body } = await post(
        '/tool/device_swipe',
        JSON.stringify({ direction: 'up' }),
      );

      expect(status).toBe(200);
      expect(body.error?.code).toBe('MM_TOOL_NOT_SUPPORTED_ON_PLATFORM');
      expectValidTiming(body);
    });

    it('includes meta.timing for malformed JSON bodies, measured from request arrival', async () => {
      // Each performance.now() call advances 25ms, so a start recorded before
      // the body parser yields totalMs > 0 in the error middleware.
      let clock = 0;
      const nowSpy = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => (clock += 25));

      try {
        const { status, body } = await post('/tool/get_state', '{not json');

        expect(status).toBe(500);
        expect(body.error?.code).toBe('INTERNAL_ERROR');
        expectValidTiming(body);
        expect(body.meta?.timing.totalMs).toBeGreaterThan(0);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});

describe('createServer with logging', () => {
  let server: ServerInstance;
  let state: DaemonState;

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    server = createServer(
      buildConfig({ logFilePath: path.join(tmpDir, 'daemon.log') }),
    );
    state = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    exitSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes request logs to file', async () => {
    await httpRequest(`http://127.0.0.1:${state.port}/health`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logContent = await fs
      .readFile(path.join(tmpDir, 'daemon.log'), 'utf-8')
      .catch(() => '');
    expect(logContent).toContain('/health');
  });

  it('logs fatal errors to stderr and file', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Trigger a cleanup error by making sessionManager.cleanup() throw
    const mockSM = createMockSessionManager();
    mockSM.hasActiveSession.mockReturnValue(true);
    mockSM.cleanup.mockRejectedValue(new Error('Cleanup failed'));

    const testServer = createServer({
      sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
      contextFactory: vi.fn().mockResolvedValue({
        config: {
          environment: 'e2e',
          extensionName: 'Test',
          defaultPassword: 'test',
          artifactsDir: tmpDir,
          defaultChainId: 1,
          ports: { anvil: 8545, fixtureServer: 12345 },
        },
      } satisfies WorkflowContext),
      logFilePath: path.join(tmpDir, 'error.log'),
    });

    await testServer.start();
    await testServer.stop();

    // Verify stderr was called with fatal error
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Cleanup failed'),
    );

    stderrSpy.mockRestore();
  });

  it('handles log file write errors gracefully', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Create a read-only directory to cause write errors
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fs.mkdir(readOnlyDir, { recursive: true });
    const logPath = path.join(readOnlyDir, 'daemon.log');

    // Make directory read-only
    await fs.chmod(readOnlyDir, 0o444);

    try {
      const testServer = createServer(buildConfig({ logFilePath: logPath }));
      const testState = await testServer.start();

      // Make a request to trigger logging
      await httpRequest(`http://127.0.0.1:${testState.port}/health`);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await testServer.stop();

      // Verify that stderr was called with the write error message
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write log'),
      );
    } finally {
      stderrSpy.mockRestore();
      // Restore write permissions for cleanup
      await fs.chmod(readOnlyDir, 0o755).catch(() => {});
    }
  });

  it('handles server close timeout with force close', async () => {
    const testServer = createServer(buildConfig());
    const testState = await testServer.start();

    // Make a request to ensure server is active
    await httpRequest(`http://127.0.0.1:${testState.port}/health`);

    // Stop should complete even if server doesn't close gracefully
    expect(await testServer.stop()).toBeUndefined();
  });
});

describe('observation compaction in HTTP responses', () => {
  let server: ServerInstance;
  let state: DaemonState;
  let mockSM: ReturnType<typeof createMockSessionManager>;

  const comboboxAndOptions = [
    { ref: 'e1', role: 'combobox', name: 'Language', path: ['root'] },
    ...Array.from({ length: 10 }, (_, i) => ({
      ref: `e${i + 2}`,
      role: 'option',
      name: `Lang ${i + 1}`,
      path: ['root', 'combobox'],
    })),
    { ref: 'e12', role: 'button', name: 'Submit', path: ['root'] },
  ];

  const initialButtons = [
    { ref: 'e1', role: 'button', name: 'Continue', path: ['root'] },
    { ref: 'e2', role: 'button', name: 'Cancel', path: ['root'] },
  ];

  const changedButtons = [
    { ref: 'e1', role: 'button', name: 'Continue', path: ['root'] },
    { ref: 'e3', role: 'button', name: 'Confirm', path: ['root'] },
  ];

  const manyNewButtons = Array.from({ length: 10 }, (_, index) => ({
    ref: `e${index + 10}`,
    role: 'button',
    name: `Action ${index + 1}`,
    path: ['root'],
  }));

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    mockSM = createMockSessionManager();
    mockSM.hasActiveSession.mockReturnValue(true);
    mockSM.getExtensionState.mockResolvedValue({
      isLoaded: true,
      currentUrl: 'chrome-extension://test/home.html',
    });

    const { collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    vi.mocked(collectTrimmedA11ySnapshot).mockResolvedValue({
      nodes: comboboxAndOptions as never,
      refMap: new Map(),
    });

    server = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
      }),
    );
    state = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    exitSpy.mockRestore();

    const { collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    vi.mocked(collectTrimmedA11ySnapshot).mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('mutating tool returns compact observations in HTTP response', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: { a11y: { nodes: unknown[] } };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    // 12 original nodes → compacted: combobox + summary + button = 3
    expect(body.observations?.a11y.nodes).toHaveLength(3);
  });

  it('first mutation returns a full compact observation when no baseline exists', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: {
        a11y: {
          nodes: unknown[];
          diff?: unknown;
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations?.a11y.diff).toBeUndefined();
    expect(body.observations?.a11y.nodes).toHaveLength(3);
  });

  it('second mutation returns a diff-based observation', async () => {
    const { collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    vi.mocked(collectTrimmedA11ySnapshot)
      .mockResolvedValueOnce({
        nodes: initialButtons as never,
        refMap: new Map(),
      })
      .mockResolvedValueOnce({
        nodes: changedButtons as never,
        refMap: new Map(),
      });

    await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });

    const res = await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: {
        a11y: {
          nodes: unknown[];
          diff?: { added: string[]; removed: string[]; unchanged: number };
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.observations?.a11y.diff).toStrictEqual({
      added: ['e3'],
      removed: ['e2'],
      unchanged: 1,
    });
    expect(body.observations?.a11y.nodes).toHaveLength(1);
  });

  it('describe_screen resets the diff baseline', async () => {
    const { collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    vi.mocked(collectTrimmedA11ySnapshot)
      .mockResolvedValueOnce({
        nodes: initialButtons as never,
        refMap: new Map(),
      })
      .mockResolvedValueOnce({
        nodes: initialButtons as never,
        refMap: new Map(),
      })
      .mockResolvedValueOnce({
        nodes: changedButtons as never,
        refMap: new Map(),
      });

    await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });

    await httpRequest(`http://127.0.0.1:${state.port}/tool/describe_screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: {
        a11y: {
          nodes: unknown[];
          diff?: unknown;
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations?.a11y.diff).toBeUndefined();
    expect(body.observations?.a11y.nodes.length).toBeGreaterThan(1);
  });

  it('falls back to the full observation when the diff is not smaller', async () => {
    const { collectTrimmedA11ySnapshot } =
      await import('../tools/utils/discovery.js');
    vi.mocked(collectTrimmedA11ySnapshot)
      .mockResolvedValueOnce({
        nodes: [initialButtons[0]] as never,
        refMap: new Map(),
      })
      .mockResolvedValueOnce({
        nodes: manyNewButtons as never,
        refMap: new Map(),
      });

    await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });

    const res = await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: {
        a11y: {
          nodes: unknown[];
          diff?: unknown;
        };
      };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations?.a11y.diff).toBeUndefined();
    expect(body.observations?.a11y.nodes).toHaveLength(10);
  });

  it('batch with includeObservations=all returns compact observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/run_steps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: [{ tool: 'get_state' }],
          includeObservations: 'all',
        }),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      observations?: { a11y: { nodes: unknown[] } };
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations?.a11y.nodes).toHaveLength(3);
  });

  it('batch with includeObservations=none omits observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/run_steps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: [{ tool: 'get_state' }],
          includeObservations: 'none',
        }),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      observations?: unknown;
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeUndefined();
  });

  it('describe_screen response omits observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/describe_screen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      observations?: unknown;
    };

    // Discovery tools never include observations in the HTTP response
    expect(body.observations).toBeUndefined();
  });
});

describe('createServer observation driver freshness after launch', () => {
  let server: ServerInstance;
  let state: DaemonState;
  let mockSM: ReturnType<typeof createMockSessionManager>;
  let mobileDriver: {
    getPlatform: ReturnType<typeof vi.fn>;
    getAppState: ReturnType<typeof vi.fn>;
    getTestIds: ReturnType<typeof vi.fn>;
    getAccessibilityTree: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });

    mobileDriver = {
      getPlatform: vi.fn().mockReturnValue('ios'),
      getAppState: vi.fn().mockResolvedValue({
        isLoaded: true,
        currentUrl: '',
        extensionId: 'io.metamask',
        isUnlocked: true,
        currentScreen: 'unknown',
        accountAddress: null,
        networkName: null,
        chainId: null,
        balance: null,
      }),
      getTestIds: vi.fn().mockResolvedValue([]),
      getAccessibilityTree: vi
        .fn()
        .mockResolvedValue({ nodes: [], refMap: new Map() }),
    };

    mockSM = createMockSessionManager();
    mockSM.getPlatformDriver.mockReturnValue(undefined);
    // Session starts inactive; launch activates it and sets the mobile driver
    mockSM.hasActiveSession.mockReturnValue(false);
    mockSM.launch.mockImplementation(async () => {
      mockSM.hasActiveSession.mockReturnValue(true);
      mockSM.getPlatformDriver.mockReturnValue(mobileDriver);
      return {
        sessionId: 'mobile-session',
        extensionId: 'io.metamask',
        state: {},
      };
    });

    server = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
      }),
    );
    state = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('uses the mobile driver for observations after launch sets it', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: { state: unknown };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The mobile driver's getAppState should have been called for
    // observation collection, NOT the Playwright path (which would
    // fail since there's no browser page).
    expect(mobileDriver.getAppState).toHaveBeenCalled();
    expect(mobileDriver.getTestIds).toHaveBeenCalled();
    expect(mobileDriver.getAccessibilityTree).toHaveBeenCalled();
    expect(body.observations).toBeDefined();
  });

  it('blocks browser-only tools on a mobile platform', async () => {
    await httpRequest(`http://127.0.0.1:${state.port}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    });

    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/navigate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen: 'home' }),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MM_TOOL_NOT_SUPPORTED_ON_PLATFORM');
  });

  it('lets mobile-only tools pass platform gating on a mobile platform', async () => {
    await httpRequest(`http://127.0.0.1:${state.port}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    });

    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/hermes_targets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    // Gating passes (platform is mobile); the mock driver has no hermesTargets
    // method, so the tool itself reports MM_HERMES_NOT_AVAILABLE rather than the
    // platform-gating error.
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MM_HERMES_NOT_AVAILABLE');
  });

  it('blocks mobile-only tools when no platform driver is present', async () => {
    mockSM.hasActiveSession.mockReturnValue(true);

    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/hermes_targets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MM_TOOL_NOT_SUPPORTED_ON_PLATFORM');
  });

  it('blocks mobile-only tools on a browser platform', async () => {
    mockSM.hasActiveSession.mockReturnValue(true);
    mockSM.getPlatformDriver.mockReturnValue({ getPlatform: () => 'browser' });

    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/hermes_targets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MM_TOOL_NOT_SUPPORTED_ON_PLATFORM');
  });
});
