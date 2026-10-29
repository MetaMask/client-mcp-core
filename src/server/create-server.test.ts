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
  resolveObserveLevel,
  screenAfterResponse,
} from './create-server.js';
import { readDaemonState } from './daemon-state.js';
import pkg from '../../package.json';
import type { PortMap, WorkflowContext } from '../capabilities/context.js';
import { toolRegistry } from '../tools/registry.js';
import type { StepRecordObservation } from '../tools/types/observation.js';
import { waitForAnimationsToSettle } from '../tools/utils/discovery.js';
import type {
  DaemonState,
  ServerConfig,
  ToolContext,
  ToolFunction,
  ToolResponse,
} from '../types/http.js';

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
  waitForAnimationsToSettle: vi.fn().mockResolvedValue(true),
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
    clearRefMap: vi.fn(),
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
    const obs = { testIds: [], a11y: { nodes: [] } };
    expect(buildResponseBody(result, obs as any)).toStrictEqual({
      ok: true,
      observations: obs,
    });
  });
});

describe('resolveObserveLevel', () => {
  const batchResult = (steps: { skipped?: boolean }[]): ToolResponse => ({
    ok: true,
    result: {
      steps: steps.map((step) => ({
        tool: 'click',
        ok: true,
        meta: { durationMs: 0, timestamp: '', skipped: step.skipped },
      })),
      summary: { ok: true },
    },
  });

  it.each([
    ['mutating', 'diff'],
    ['readonly', 'none'],
    ['discovery', 'none'],
    ['cdp', 'none'],
    ['batch', 'diff'],
  ] as const)('defaults %s to %s', (category, expected) => {
    expect(resolveObserveLevel(category)).toBe(expected);
    expect(resolveObserveLevel(category, {})).toBe(expected);
  });

  it.each([
    ['mutating', 'none'],
    ['mutating', 'diff'],
    ['mutating', 'full'],
    ['readonly', 'none'],
    ['readonly', 'diff'],
    ['readonly', 'full'],
    ['discovery', 'none'],
    ['discovery', 'diff'],
    ['discovery', 'full'],
    ['cdp', 'none'],
    ['cdp', 'diff'],
    ['cdp', 'full'],
    ['batch', 'none'],
    ['batch', 'diff'],
    ['batch', 'full'],
  ] as const)('honours an explicit level on %s: %s', (category, level) => {
    expect(resolveObserveLevel(category, { observe: level })).toBe(level);
  });

  it('ignores an invalid observe value', () => {
    expect(resolveObserveLevel('mutating', { observe: 'bogus' })).toBe('diff');
    expect(resolveObserveLevel('readonly', { observe: 'bogus' })).toBe('none');
  });

  it('uses the last executed step observe for run_steps', () => {
    const input = {
      steps: [
        { tool: 'click', args: { observe: 'none' } },
        { tool: 'click', args: { observe: 'full' } },
      ],
    };
    expect(resolveObserveLevel('batch', input, batchResult([{}, {}]))).toBe(
      'full',
    );
  });

  it('ignores observe on steps other than the last executed one', () => {
    const input = {
      steps: [{ tool: 'click', args: { observe: 'none' } }, { tool: 'click' }],
    };
    expect(resolveObserveLevel('batch', input, batchResult([{}, {}]))).toBe(
      'diff',
    );
  });

  it('uses the last executed step when run_steps stopped early', () => {
    const input = {
      steps: [
        { tool: 'click', args: { observe: 'full' } },
        { tool: 'click', args: { observe: 'none' } },
      ],
    };
    expect(resolveObserveLevel('batch', input, batchResult([{}]))).toBe('full');
  });

  it('does not count steps skipped by batchTimeoutMs', () => {
    const input = {
      steps: [
        { tool: 'click', args: { observe: 'none' } },
        { tool: 'click', args: { observe: 'full' } },
      ],
    };
    expect(
      resolveObserveLevel('batch', input, batchResult([{}, { skipped: true }])),
    ).toBe('none');
  });

  it('prefers the top-level run_steps observe over the last step', () => {
    const input = {
      observe: 'none',
      steps: [{ tool: 'click', args: { observe: 'full' } }],
    };
    expect(resolveObserveLevel('batch', input, batchResult([{}]))).toBe('none');
  });

  it('defaults run_steps to diff when the batch failed or has no steps', () => {
    const input = { steps: [{ tool: 'click', args: { observe: 'full' } }] };
    const failed: ToolResponse = {
      ok: false,
      error: { code: 'ERR', message: 'fail' },
    };
    expect(resolveObserveLevel('batch', input, failed)).toBe('diff');
    expect(resolveObserveLevel('batch', input, { ok: true, result: {} })).toBe(
      'diff',
    );
    expect(resolveObserveLevel('batch', input, batchResult([]))).toBe('diff');
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

  it('mutating tool response includes observations with testIds and a11y but no state', async () => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      ok: boolean;
      observations?: Record<string, unknown>;
    };

    expect(res.status).toBe(200);
    expect(body.observations).toBeDefined();
    expect(body.observations).not.toHaveProperty('state');
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

  it('observation Playwright helpers not called for read-only tools', async () => {
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

    expect(collectTestIdsSpy).not.toHaveBeenCalled();
    expect(collectA11ySpy).not.toHaveBeenCalled();
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

  describe('observation without app state', () => {
    it('does not call getExtensionState when observing a mutating tool', async () => {
      const res = await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { observations?: unknown };

      expect(res.status).toBe(200);
      expect(body.observations).toBeDefined();
      expect(mockSM.getExtensionState).not.toHaveBeenCalled();
    });

    it('does not call getExtensionState when observing run_steps', async () => {
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
      const body = (await res.json()) as { observations?: unknown };

      expect(res.status).toBe(200);
      expect(body.observations).toBeDefined();
      expect(mockSM.getExtensionState).not.toHaveBeenCalled();
    });

    it('collects no observation for readonly tool category', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/get_context`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as { observations?: unknown };

      expect(res.status).toBe(200);
      expect(body.observations).toBeUndefined();
    });

    it('collects no observation for discovery tool category', async () => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}/tool/list_testids`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as { observations?: unknown };

      expect(res.status).toBe(200);
      expect(body.observations).toBeUndefined();
    });
  });

  describe('observe level', () => {
    type ObservedBody = {
      ok: boolean;
      result?: Record<string, unknown>;
      observations?: Record<string, unknown>;
      meta?: { timing: { observationMs: number } };
    };

    const post = async (
      urlPath: string,
      requestBody: unknown,
    ): Promise<{ status: number; body: ObservedBody }> => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}${urlPath}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
      );
      return { status: res.status, body: (await res.json()) as ObservedBody };
    };

    it('click with observe none returns no observations and observationMs 0', async () => {
      const { collectTestIds } = await import('../tools/utils/discovery.js');
      vi.mocked(collectTestIds).mockClear();

      const { status, body } = await post('/tool/click', {
        a11yRef: 'e1',
        observe: 'none',
      });

      expect(status).toBe(200);
      expect(body.observations).toBeUndefined();
      expect(body.meta?.timing.observationMs).toBe(0);
      expect(collectTestIds).not.toHaveBeenCalled();
    });

    it('get_state with observe full includes an observation without state', async () => {
      mockSM.getPlatformDriver.mockReturnValue({
        getPlatform: () => 'browser',
        getAppState: vi.fn().mockResolvedValue({
          isLoaded: true,
          extensionId: 'test-ext',
        }),
      });

      const { status, body } = await post('/tool/get_state', {
        observe: 'full',
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result).toHaveProperty('state');
      expect(body.observations).toBeDefined();
      expect(body.observations).not.toHaveProperty('state');
      expect(body.meta?.timing.observationMs).toBeGreaterThanOrEqual(0);
    });

    it('get_state with observe diff includes an observation', async () => {
      const { body } = await post('/tool/get_state', { observe: 'diff' });

      expect(body.observations).toBeDefined();
    });

    it('cdp with observe full waits for animations and returns an observation', async () => {
      vi.mocked(waitForAnimationsToSettle).mockClear();
      const page = {
        waitForLoadState: vi.fn(async () => undefined),
      };
      mockSM.getPage.mockReturnValue(page as never);
      mockSM.getPlatformDriver.mockReturnValue({
        getPlatform: () => 'browser',
        cdp: vi.fn().mockResolvedValue({ ok: true, result: { value: 2 } }),
      });

      const { body } = await post('/tool/cdp', {
        method: 'Runtime.evaluate',
        observe: 'full',
      });

      expect(body.ok).toBe(true);
      expect(body.observations).toBeDefined();
      expect(waitForAnimationsToSettle).toHaveBeenCalledWith(page, 1_000, 250);
    });

    it('get_state with observe full does not wait for animations', async () => {
      vi.mocked(waitForAnimationsToSettle).mockClear();
      const page = {
        waitForLoadState: vi.fn(async () => undefined),
        url: () => '',
      };
      mockSM.getPage.mockReturnValue(page as never);

      const { body } = await post('/tool/get_state', { observe: 'full' });

      expect(body.observations).toBeDefined();
      expect(waitForAnimationsToSettle).not.toHaveBeenCalled();
    });

    it('does not pass observe to the tool handler', async () => {
      await post('/launch', { force: true, observe: 'none' });

      expect(mockSM.launch).toHaveBeenCalledWith(
        expect.not.objectContaining({ observe: expect.anything() }),
      );
    });

    it('honours observe in the /cleanup body', async () => {
      const { status, body } = await post('/cleanup', { observe: 'none' });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.observations).toBeUndefined();
      expect(body.meta?.timing.observationMs).toBe(0);
    });

    it('rejects an invalid observe level', async () => {
      const { status, body } = await post('/tool/click', {
        a11yRef: 'e1',
        observe: 'everything',
      });

      expect(status).toBe(400);
      expect(body.ok).toBe(false);
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
      const { collectTestIds } = await import('../tools/utils/discovery.js');
      vi.mocked(collectTestIds).mockImplementationOnce(
        async () => new Promise((resolve) => setTimeout(() => resolve([]), 60)),
      );

      const { body } = await post('/cleanup');

      expectValidTiming(body);
      expect(body.meta?.timing.toolMs).toBeGreaterThanOrEqual(50);
      expect(body.meta?.timing.observationMs).toBeGreaterThanOrEqual(50);
    });

    it.each([
      ['readonly', '/tool/get_state'],
      ['discovery', '/tool/list_testids'],
      ['cdp', '/tool/cdp', JSON.stringify({ method: 'Runtime.evaluate' })],
    ])(
      'reports observationMs 0 for %s tools with an active session',
      async (category, urlPath, requestBody?: string) => {
        if (category === 'cdp') {
          mockSM.getPlatformDriver.mockReturnValue({
            getPlatform: () => 'browser',
            cdp: vi.fn().mockResolvedValue({ ok: true, result: { value: 2 } }),
          });
        }

        const { status, body } = await post(urlPath, requestBody);

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(
          (body as TimedBody & { observations?: unknown }).observations,
        ).toBeUndefined();
        expectValidTiming(body);
        expect(body.meta?.timing.observationMs).toBe(0);
      },
    );

    it('reports observationMs above 0 for mutating tools', async () => {
      const { collectTestIds } = await import('../tools/utils/discovery.js');
      vi.mocked(collectTestIds).mockImplementationOnce(
        async () => new Promise((resolve) => setTimeout(() => resolve([]), 20)),
      );

      const { body } = await post('/cleanup');

      expect(
        (body as TimedBody & { observations?: unknown }).observations,
      ).toBeDefined();
      expect(body.meta?.timing.observationMs).toBeGreaterThan(0);
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
      // Hold the first request well past the threshold below: under host
      // load the second request can take tens of ms to reach the queue.
      await new Promise((resolve) => setTimeout(resolve, 250));
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

  it('accessibility_snapshot resets the diff baseline', async () => {
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

    await httpRequest(
      `http://127.0.0.1:${state.port}/tool/accessibility_snapshot`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );

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

  it('read tools do not move the diff baseline', async () => {
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

    await httpRequest(`http://127.0.0.1:${state.port}/tool/get_state`, {
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

  describe('observe levels on a second mutation', () => {
    type CompactBody = {
      ok: boolean;
      observations?: {
        a11y: {
          nodes: unknown[];
          diff?: { added: string[]; removed: string[]; unchanged: number };
        };
      };
    };

    const post = async (
      urlPath: string,
      requestBody: unknown,
    ): Promise<CompactBody> => {
      const res = await httpRequest(
        `http://127.0.0.1:${state.port}${urlPath}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
      );
      return (await res.json()) as CompactBody;
    };

    beforeEach(async () => {
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
    });

    afterEach(async () => {
      // Drop queued snapshots a test did not consume.
      const { collectTrimmedA11ySnapshot } =
        await import('../tools/utils/discovery.js');
      vi.mocked(collectTrimmedA11ySnapshot).mockReset();
    });

    it('diff returns only the changes', async () => {
      await post('/tool/click', { a11yRef: 'e1' });
      const body = await post('/tool/click', {
        a11yRef: 'e1',
        observe: 'diff',
      });

      expect(body.observations?.a11y.diff).toStrictEqual({
        added: ['e3'],
        removed: ['e2'],
        unchanged: 1,
      });
      expect(body.observations?.a11y.nodes).toHaveLength(1);
    });

    it('full returns the whole screen with no diff', async () => {
      await post('/tool/click', { a11yRef: 'e1' });
      const body = await post('/tool/click', {
        a11yRef: 'e1',
        observe: 'full',
      });

      expect(body.observations?.a11y.diff).toBeUndefined();
      expect(body.observations?.a11y.nodes).toStrictEqual(changedButtons);
    });

    it('full still moves the diff baseline', async () => {
      const { collectTrimmedA11ySnapshot } =
        await import('../tools/utils/discovery.js');
      vi.mocked(collectTrimmedA11ySnapshot).mockResolvedValueOnce({
        nodes: initialButtons as never,
        refMap: new Map(),
      });

      await post('/tool/click', { a11yRef: 'e1' });
      await post('/tool/click', { a11yRef: 'e1', observe: 'full' });
      const body = await post('/tool/click', { a11yRef: 'e1' });

      expect(body.observations?.a11y.diff).toStrictEqual({
        added: ['e2'],
        removed: ['e3'],
        unchanged: 1,
      });
    });

    it('none does not move the diff baseline', async () => {
      const { collectTrimmedA11ySnapshot } =
        await import('../tools/utils/discovery.js');
      vi.mocked(collectTrimmedA11ySnapshot).mockClear();

      await post('/tool/click', { a11yRef: 'e1' });
      await post('/tool/click', { a11yRef: 'e1', observe: 'none' });
      const body = await post('/tool/click', { a11yRef: 'e1' });

      // The `none` call collected nothing, so the second snapshot (changed
      // buttons) is diffed against the first one.
      expect(vi.mocked(collectTrimmedA11ySnapshot)).toHaveBeenCalledTimes(2);
      expect(body.observations?.a11y.diff).toStrictEqual({
        added: ['e3'],
        removed: ['e2'],
        unchanged: 1,
      });
    });

    it('run_steps with top-level observe full returns no diff', async () => {
      await post('/tool/click', { a11yRef: 'e1' });
      const body = await post('/tool/run_steps', {
        steps: [{ tool: 'get_context' }],
        observe: 'full',
      });

      expect(body.observations?.a11y.diff).toBeUndefined();
      expect(body.observations?.a11y.nodes).toStrictEqual(changedButtons);
    });

    it('run_steps uses the last step observe when there is no top-level one', async () => {
      await post('/tool/click', { a11yRef: 'e1' });
      const body = await post('/tool/run_steps', {
        steps: [
          { tool: 'get_context', args: { observe: 'none' } },
          { tool: 'get_context', args: { observe: 'full' } },
        ],
      });

      expect(body.observations?.a11y.diff).toBeUndefined();
      expect(body.observations?.a11y.nodes).toStrictEqual(changedButtons);
    });

    it('run_steps with last step observe none omits observations', async () => {
      const body = await post('/tool/run_steps', {
        steps: [{ tool: 'get_context', args: { observe: 'none' } }],
      });

      expect(body.ok).toBe(true);
      expect(body.observations).toBeUndefined();
    });

    it('run_steps top-level observe wins over the last step', async () => {
      await post('/tool/click', { a11yRef: 'e1' });
      const body = await post('/tool/run_steps', {
        steps: [{ tool: 'get_context', args: { observe: 'full' } }],
        observe: 'diff',
      });

      expect(body.observations?.a11y.diff).toStrictEqual({
        added: ['e3'],
        removed: ['e2'],
        unchanged: 1,
      });
    });
  });

  it('batch without observe returns compact observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/run_steps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: [{ tool: 'get_state' }],
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

  it('batch with observe none omits observations', async () => {
    const res = await httpRequest(
      `http://127.0.0.1:${state.port}/tool/run_steps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: [{ tool: 'get_state' }],
          observe: 'none',
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
        extensionId: 'io.metamask',
        source: 'stub',
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
      observations?: Record<string, unknown>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The mobile driver should have been used for observation collection,
    // NOT the Playwright path (which would fail since there's no browser
    // page). Observations no longer read app state.
    expect(mobileDriver.getAppState).not.toHaveBeenCalled();
    expect(mobileDriver.getTestIds).toHaveBeenCalled();
    expect(mobileDriver.getAccessibilityTree).toHaveBeenCalled();
    expect(body.observations).toBeDefined();
    expect(body.observations).not.toHaveProperty('state');
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

describe('createServer abort, ref generations and observations', () => {
  type Node = { ref: string; role: string; name: string; path: string[] };
  type ObsBody = {
    ok: boolean;
    error?: { code: string; message: string };
    observations?: {
      a11y: {
        nodes: Node[];
        diff?: { added: string[]; removed: string[]; unchanged: number };
      };
    };
  };
  type Tree = { nodes: Node[]; refMap: Map<string, string> };

  const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const buildTree = (names: string[]): Tree => ({
    nodes: names.map((name, index) => ({
      ref: `e${index + 1}`,
      role: 'button',
      name,
      path: [],
    })),
    refMap: new Map(
      names.map((name, index) => [`e${index + 1}`, `label:${name}`] as const),
    ),
  });

  let server: ServerInstance | undefined;
  let state: DaemonState;
  let mockSM: ReturnType<typeof createMockSessionManager>;
  let storedRefMap: Map<string, string>;
  let driver: {
    getPlatform: ReturnType<typeof vi.fn>;
    getAppState: ReturnType<typeof vi.fn>;
    getTestIds: ReturnType<typeof vi.fn>;
    getAccessibilityTree: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
  };
  const addedTools: string[] = [];

  const startServer = async (
    options: { requestTimeoutMs?: number; mobile?: boolean } = {},
  ): Promise<void> => {
    if (options.mobile !== false) {
      mockSM.getPlatformDriver.mockReturnValue(driver);
    }
    server = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        requestTimeoutMs: options.requestTimeoutMs,
      }),
    );
    state = await server.start();
  };

  const post = async (
    urlPath: string,
    requestBody: unknown = {},
  ): Promise<{ status: number; body: ObsBody }> => {
    const res = await httpRequest(`http://127.0.0.1:${state.port}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    return { status: res.status, body: (await res.json()) as ObsBody };
  };

  const addTool = (name: string, fn: ToolFunction<unknown, unknown>): void => {
    toolRegistry.set(name, fn);
    addedTools.push(name);
  };

  // A mutating tool without a `timeoutMs` default, so the server's
  // requestTimeoutMs is the queue timeout (click defaults to 15 s).
  const addTapTool = (): void => {
    addTool('test_tap', async () => ({ ok: true, result: {} }));
  };

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    storedRefMap = new Map();
    mockSM = createMockSessionManager();
    mockSM.hasActiveSession.mockReturnValue(true);
    mockSM.setRefMap.mockImplementation((map: Map<string, string>) => {
      storedRefMap = map;
    });
    mockSM.getRefMap.mockImplementation(() => storedRefMap);

    driver = {
      getPlatform: vi.fn().mockReturnValue('android'),
      getAppState: vi.fn().mockResolvedValue({ isLoaded: true }),
      getTestIds: vi.fn().mockResolvedValue([]),
      getAccessibilityTree: vi.fn().mockResolvedValue(buildTree(['Unlock'])),
      click: vi.fn().mockResolvedValue({ clicked: true, target: 'x' }),
    };
  });

  afterEach(async () => {
    const running = server;
    server = undefined;
    await running?.stop();
    for (const name of addedTools.splice(0)) {
      toolRegistry.delete(name);
    }
    exitSpy.mockRestore();
    const discovery = await import('../tools/utils/discovery.js');
    vi.mocked(discovery.collectTrimmedA11ySnapshot).mockReset();
    vi.mocked(discovery.collectTrimmedA11ySnapshot).mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('P1-08: timed-out requests', () => {
    it('aborts the signal of a timed-out task and ignores its late setRefMap (AC1)', async () => {
      await startServer({ requestTimeoutMs: 50 });
      let abortedWhenLate: boolean | undefined;
      let finished!: () => void;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      addTool('test_slow_tool', async (_input, context) => {
        await sleep(120);
        abortedWhenLate = context.signal?.aborted;
        context.sessionManager.setRefMap(new Map([['e1', 'late']]));
        finished();
        return { ok: true, result: {} };
      });

      const { status, body } = await post('/tool/test_slow_tool');
      await done;

      expect(status).toBe(500);
      expect(body.error?.message).toContain('timed out after 50ms');
      expect(abortedWhenLate).toBe(true);
      expect(mockSM.setRefMap).not.toHaveBeenCalled();
    });

    it('keeps the refMap of the second request after the first times out (AC2)', async () => {
      await startServer({ requestTimeoutMs: 50 });
      const firstTree = buildTree(['Old screen']);
      const secondTree = buildTree(['New screen']);
      // First click: its observation snapshot arrives after the timeout.
      driver.getAccessibilityTree
        .mockImplementationOnce(async () => {
          await sleep(120);
          return firstTree;
        })
        .mockResolvedValueOnce(secondTree);
      addTapTool();

      const first = await post('/tool/test_tap');
      const second = await post('/tool/test_tap');

      expect(first.status).toBe(500);
      expect(second.status).toBe(200);
      expect(second.body.observations?.a11y.nodes).toStrictEqual(
        secondTree.nodes,
      );
      expect(mockSM.setRefMap).toHaveBeenCalledTimes(1);
      expect(storedRefMap).toStrictEqual(secondTree.refMap);
      // The aborted observation stopped before its test ID step.
      expect(driver.getTestIds).toHaveBeenCalledTimes(1);
    });

    it('stops the browser observation at the next checkpoint after an abort', async () => {
      const discovery = await import('../tools/utils/discovery.js');
      vi.mocked(discovery.collectTestIds).mockClear();
      mockSM.getPage.mockReturnValue({
        waitForLoadState: vi.fn(async () => sleep(120)),
      } as never);
      await startServer({ requestTimeoutMs: 50, mobile: false });
      addTapTool();

      const { status } = await post('/tool/test_tap');
      await sleep(150);

      expect(status).toBe(500);
      expect(vi.mocked(discovery.collectTestIds)).not.toHaveBeenCalled();
      expect(mockSM.setRefMap).not.toHaveBeenCalled();
    });

    it('cancels a tool that checks the signal between steps', async () => {
      await startServer({ requestTimeoutMs: 50 });
      const steps: string[] = [];
      addTool('test_steps_tool', async (_input, context) => {
        steps.push('one');
        await sleep(100);
        if (context.signal?.aborted) {
          return { ok: false, error: { code: 'X', message: 'aborted' } };
        }
        steps.push('two');
        return { ok: true, result: {} };
      });

      await post('/tool/test_steps_tool');
      await sleep(80);

      expect(steps).toStrictEqual(['one']);
    });
  });

  describe('P1-09: observations and refs', () => {
    it('a non-delivered observation does not change lastObservation (AC1)', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['A', 'B']))
        .mockResolvedValueOnce(buildTree(['A', 'B', 'C']));
      await post('/tool/click', { testId: 'x' });
      await post('/tool/click', { testId: 'x', observe: 'none' });
      const { body } = await post('/tool/click', { testId: 'x' });

      // observe none collected nothing; the diff is against the first
      // (delivered) observation.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
      expect(body.observations?.a11y.diff).toStrictEqual({
        added: ['e3'],
        removed: [],
        unchanged: 2,
      });
    });

    it('lets the observation replace the refs the tool set, without a settle', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Send', 'Swap']))
        .mockResolvedValueOnce(buildTree(['Banner', 'Send', 'Swap']));

      const { body } = await post('/tool/describe_screen', {
        observe: 'full',
      });

      expect(body.ok).toBe(true);
      // The observation is the last tree in the response: every ref in it
      // resolves to the element it shows.
      const nodes = body.observations?.a11y.nodes ?? [];
      expect(nodes.map((node) => [node.ref, node.name])).toStrictEqual([
        ['e1', 'Banner'],
        ['e2', 'Send'],
        ['e3', 'Swap'],
      ]);
      expect(storedRefMap).toStrictEqual(
        buildTree(['Banner', 'Send', 'Swap']).refMap,
      );
      // No settle: the tool set refs, so it had just read the screen.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('lets the run_steps observation replace refs a step set', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Send']))
        .mockResolvedValueOnce(buildTree(['Done']));

      await post('/tool/run_steps', {
        steps: [{ tool: 'accessibility_snapshot' }],
      });

      expect(mockSM.setRefMap).toHaveBeenCalledTimes(2);
      expect(storedRefMap).toStrictEqual(new Map([['e1', 'label:Done']]));
    });

    it('sends the new refs when an element is inserted above the others', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Send', 'Swap']))
        .mockResolvedValueOnce(buildTree(['Banner', 'Send', 'Swap']));

      await post('/tool/click', { testId: 'x' });
      const { body } = await post('/tool/click', { testId: 'x' });

      // Refs are positional: Banner takes e1, Send and Swap move to e2/e3.
      // Every node changed, so the response carries the full tree (a diff
      // would not be smaller) and the agent sees the new refs.
      expect(body.observations?.a11y.diff).toBeUndefined();
      expect(
        body.observations?.a11y.nodes.map((node) => [node.ref, node.name]),
      ).toStrictEqual([
        ['e1', 'Banner'],
        ['e2', 'Send'],
        ['e3', 'Swap'],
      ]);
      expect(storedRefMap.get('e1')).toBe('label:Banner');
    });

    it('diffs two mobile observations of the same tree as unchanged', async () => {
      await startServer();
      // Many unnamed containers (Android: android.view.ViewGroup), plus a
      // status-bar label that changes.
      const screen = (signal: string): Tree => {
        const nodes: Node[] = [
          {
            ref: 'e1',
            role: 'android.widget.FrameLayout',
            name: signal,
            path: [],
          },
          ...Array.from(
            { length: 30 },
            (_, index): Node => ({
              ref: `e${index + 2}`,
              role: 'android.view.ViewGroup',
              name: '',
              path: ['android.widget.FrameLayout'],
            }),
          ),
          { ref: 'e32', role: 'android.widget.Button', name: 'Send', path: [] },
        ];
        return {
          nodes,
          refMap: new Map([
            ['e1', `label:${signal}|type:android.widget.FrameLayout`],
            ['e32', 'label:Send|type:android.widget.Button'],
          ]),
        };
      };
      driver.getAccessibilityTree
        .mockResolvedValueOnce(screen('T-Mobile, no signal.'))
        .mockResolvedValueOnce(screen('T-Mobile, no signal.'))
        // Settle retry (unchanged): the status bar changed meanwhile.
        .mockResolvedValue(screen('T-Mobile, signal full.'));

      await post('/tool/click', { testId: 'x' });
      const same = await post('/tool/click', { testId: 'x' });

      // Only the status-bar node whose name changed is sent.
      expect(
        same.body.observations?.a11y.nodes.map((node) => node.name),
      ).toStrictEqual(['T-Mobile, signal full.']);

      const again = await post('/tool/click', { testId: 'x' });

      expect(again.body.observations?.a11y.diff).toStrictEqual({
        added: [],
        removed: [],
        unchanged: 32,
      });
      expect(again.body.observations?.a11y.nodes).toStrictEqual([]);
    });

    it('routes context.sessionManager.setRefMap through the request handle', async () => {
      await startServer();
      const target = mockSM as unknown as Record<string, unknown>;
      target.whoAmI = function (this: unknown): boolean {
        return this === mockSM;
      };
      Object.defineProperty(mockSM, 'isSelf', {
        configurable: true,
        get(this: unknown): boolean {
          return this === mockSM;
        },
      });
      let seen: { bound?: boolean; getter?: boolean; id?: string } = {};
      addTool('test_consumer_tool', async (_input, context) => {
        const sessionManager = context.sessionManager as unknown as {
          whoAmI(): boolean;
          isSelf: boolean;
        } & ToolContext['sessionManager'];
        const { whoAmI } = sessionManager;
        seen = {
          bound: whoAmI(),
          getter: sessionManager.isSelf,
          id: sessionManager.getSessionId(),
        };
        context.sessionManager.setRefMap(new Map([['e1', 'consumer']]));
        return { ok: true, result: {} };
      });

      await post('/tool/test_consumer_tool', { observe: 'none' });

      expect(seen).toStrictEqual({
        bound: true,
        getter: true,
        id: 'test-session',
      });
      expect(mockSM.setRefMap).toHaveBeenCalledTimes(1);
      expect(storedRefMap).toStrictEqual(new Map([['e1', 'consumer']]));
    });

    it('drops a late clearRefMap from a timed-out request', async () => {
      await startServer({ requestTimeoutMs: 50 });
      storedRefMap = new Map([['e1', 'kept']]);
      mockSM.clearRefMap.mockImplementation(() => {
        storedRefMap = new Map();
      });
      let finished!: () => void;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      addTool('test_slow_clear_tool', async (_input, context) => {
        await sleep(120);
        context.sessionManager.clearRefMap();
        finished();
        return { ok: true, result: {} };
      });

      const { status } = await post('/tool/test_slow_clear_tool');
      await done;

      expect(status).toBe(500);
      expect(mockSM.clearRefMap).not.toHaveBeenCalled();
      expect(storedRefMap).toStrictEqual(new Map([['e1', 'kept']]));
    });

    it('binds methods and getters of a session manager class with #private fields', async () => {
      class PrivateSessionManager {
        readonly #id = 'private-session';

        #refMap = new Map<string, string>();

        get privateId(): string {
          return this.#id;
        }

        readPrivateId(): string {
          return this.#id;
        }

        hasActiveSession(): boolean {
          return true;
        }

        getSessionId(): string {
          return this.#id;
        }

        getPlatformDriver(): typeof driver {
          return driver;
        }

        setRefMap(map: Map<string, string>): void {
          this.#refMap = map;
        }

        getRefMap(): Map<string, string> {
          return this.#refMap;
        }
      }
      const real = new PrivateSessionManager();
      // Fill in the other members the server needs from the mock, as own
      // properties of the real instance (the #private members stay real).
      for (const [key, value] of Object.entries(mockSM)) {
        if (!(key in real)) {
          (real as unknown as Record<string, unknown>)[key] = value;
        }
      }
      server = createServer(
        buildConfig({
          sessionManager: real as unknown as ServerConfig['sessionManager'],
        }),
      );
      state = await server.start();
      let seen: { getter?: string; method?: string; detached?: string } = {};
      addTool('test_private_tool', async (_input, context) => {
        const proxied = context.sessionManager as unknown as Pick<
          PrivateSessionManager,
          'privateId' | 'readPrivateId'
        >;
        const { readPrivateId } = proxied;
        seen = {
          getter: proxied.privateId,
          method: proxied.readPrivateId(),
          detached: readPrivateId(),
        };
        context.sessionManager.setRefMap(new Map([['e1', 'private']]));
        return { ok: true, result: {} };
      });

      const { status } = await post('/tool/test_private_tool', {
        observe: 'none',
      });

      expect(status).toBe(200);
      expect(seen).toStrictEqual({
        getter: 'private-session',
        method: 'private-session',
        detached: 'private-session',
      });
      // The write went through the RefStore to the real #refMap.
      expect(real.getRefMap()).toStrictEqual(new Map([['e1', 'private']]));
    });

    describe('launch and cleanup', () => {
      let realLaunch: ToolFunction<unknown, unknown> | undefined;

      beforeEach(() => {
        realLaunch = toolRegistry.get('launch');
      });

      afterEach(() => {
        if (realLaunch) {
          toolRegistry.set('launch', realLaunch);
        }
      });

      it('does not compare against the screen from before a launch', async () => {
        await startServer();
        toolRegistry.set('launch', async () => ({ ok: true, result: {} }));
        driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));

        await post('/tool/click', { testId: 'x' });
        await post('/launch', { observe: 'none' });
        await post('/tool/click', { testId: 'x' });

        // No unchanged retry after the launch: there is no previous screen.
        expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('P1-13: device snapshots per observation (MobilePlatformDriver)', () => {
    type Element = {
      type: string;
      label?: string;
      value?: string;
      identifier?: string;
      frame: { x: number; y: number; width: number; height: number };
      enabled: boolean;
      children?: Element[];
    };

    const frame = { x: 0, y: 0, width: 1080, height: 2400 };
    // Android screen: the status bar (System UI, clock changes every
    // snapshot) and the app window.
    const screen = (clock: string, names: string[]): Element[] => [
      {
        type: 'android.widget.FrameLayout',
        frame: { x: 0, y: 0, width: 1080, height: 63 },
        enabled: true,
        children: [
          {
            type: 'android.widget.TextView',
            identifier: 'com.android.systemui:id/clock',
            value: clock,
            frame: { x: 11, y: 2, width: 136, height: 58 },
            enabled: true,
          },
        ],
      },
      {
        type: 'android.widget.FrameLayout',
        frame,
        enabled: true,
        children: names.map((name) => ({
          type: 'android.widget.Button',
          identifier: `btn-${name}`,
          label: name,
          frame: { x: 0, y: 100, width: 200, height: 100 },
          enabled: true,
        })),
      },
    ];

    let minute = 0;
    let names: string[] = [];
    let backend: {
      platform: 'android';
      snapshot: ReturnType<typeof vi.fn>;
      getWindowSize: ReturnType<typeof vi.fn>;
      getAppState: ReturnType<typeof vi.fn>;
      waitForElement: ReturnType<typeof vi.fn>;
      tapElement: ReturnType<typeof vi.fn>;
    };

    const startWithRealDriver = async (): Promise<void> => {
      minute = 0;
      names = ['Wallet'];
      backend = {
        platform: 'android',
        // A new clock value on every snapshot, like a real status bar.
        snapshot: vi.fn(async () => {
          minute += 1;
          return {
            platform: 'android',
            hierarchy: screen(`12:${String(minute).padStart(2, '0')}`, names),
            raw: '',
            timestamp: 0,
          };
        }),
        getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
        getAppState: vi
          .fn()
          .mockResolvedValue({ bundleId: 'io.metamask', state: 'Running' }),
        waitForElement: vi.fn().mockResolvedValue(undefined),
        tapElement: vi.fn().mockResolvedValue({ success: true }),
      };
      const { MobilePlatformDriver } =
        await import('../platform/mobile-platform-driver.js');
      const realDriver = new MobilePlatformDriver(
        backend as unknown as ConstructorParameters<
          typeof MobilePlatformDriver
        >[0],
      );
      await startServer({ mobile: false });
      mockSM.getPlatformDriver.mockReturnValue(realDriver);
    };

    it('takes one backend.snapshot() per observation when the screen changed (AC1)', async () => {
      await startWithRealDriver();

      await post('/tool/click', { testId: 'btn-Wallet' });
      expect(backend.snapshot).toHaveBeenCalledTimes(1);

      names = ['Send'];
      const { body } = await post('/tool/click', { testId: 'btn-Wallet' });

      expect(backend.snapshot).toHaveBeenCalledTimes(2);
      expect(backend.getWindowSize).not.toHaveBeenCalled();
      const testIds = (
        body as unknown as { observations: { testIds: { testId: string }[] } }
      ).observations.testIds.map((item) => item.testId);
      expect(testIds).toStrictEqual(['btn-Send']);
    });

    it('retries an unchanged screen once even though the Android clock changed', async () => {
      await startWithRealDriver();

      await post('/tool/click', { testId: 'btn-Wallet' });
      const { body } = await post('/tool/click', { testId: 'btn-Wallet' });

      // Second click: the screen equals the last one once System UI is
      // removed, so the P1-09 settle takes its one unchanged retry.
      expect(backend.snapshot).toHaveBeenCalledTimes(3);
      expect(body.observations?.a11y.nodes).toStrictEqual([]);
      expect(body.observations?.a11y.diff).toStrictEqual({
        added: [],
        removed: [],
        unchanged: 2,
      });
    });

    it.each([
      ['describe_screen', {}],
      ['list_testids', {}],
      ['accessibility_snapshot', {}],
    ])('takes one backend.snapshot() for %s', async (tool, input) => {
      await startWithRealDriver();

      const { body } = await post(`/tool/${tool}`, input);

      expect(body.ok).toBe(true);
      expect(backend.snapshot).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain('systemui');
    });
  });

  describe('P1-09: mobile settle after a mutating tool', () => {
    it('re-snapshots once after 300 ms when the screen looks unchanged', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValueOnce(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });
      const startedAt = Date.now();
      const { body } = await post('/tool/click', { testId: 'unlock' });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(3);
      expect(body.observations?.a11y.nodes.map((node) => node.name)).toContain(
        'Wallet',
      );
    });

    it('retries an unchanged, non-busy screen only once', async () => {
      await startServer();
      driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));

      await post('/tool/click', { testId: 'x' });
      await post('/tool/click', { testId: 'x' });

      // 1 (first click) + 1 + 1 retry (second click).
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(3);
    });

    it('takes at most three extra snapshots while the screen is busy', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValue(buildTree(['Password', 'Unlock, busy']));

      await post('/tool/click', { testId: 'x' });
      await post('/tool/click', { testId: 'x' });

      // 1 (first click) + 1 + 3 extra (second click).
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(5);
    });

    it('keeps retrying when an unchanged screen turns busy, within the limits', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock, busy']))
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValue(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });
      const { body } = await post('/tool/click', {
        testId: 'x',
        observe: 'full',
      });

      // Second click: unchanged → retry (the one unchanged retry), busy →
      // retry, unchanged again → no second unchanged retry: stop.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(4);
      expect(
        body.observations?.a11y.nodes.map((node) => node.name),
      ).toStrictEqual(['Password', 'Unlock']);
    });

    it('re-snapshots while a node is busy, even when the screen changed (Android unlock)', async () => {
      await startServer();
      const busy: Tree = {
        nodes: [
          {
            ref: 'e1',
            role: 'android.widget.EditText',
            name: 'Password',
            path: [],
          },
          {
            ref: 'e2',
            role: 'android.widget.Button',
            name: 'Unlock, busy',
            path: [],
          },
        ],
        refMap: new Map([['e2', 'identifier:log-in-button']]),
      };
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Password', 'Unlock']))
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });
      const { body } = await post('/tool/click', { testId: 'log-in-button' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(4);
      expect(
        body.observations?.a11y.nodes.map((node) => node.name),
      ).toStrictEqual(['Wallet']);
    });

    it('re-snapshots a busy first observation without a previous screen', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Unlock, busy']))
        .mockResolvedValueOnce(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('does not compare against a describe_screen that timed out', async () => {
      await startServer({ requestTimeoutMs: 100 });
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Login']))
        .mockImplementationOnce(async () => {
          await sleep(200);
          return buildTree(['Wallet']);
        })
        .mockResolvedValue(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });
      mockSM.setRefMap.mockClear();
      const described = await post('/tool/describe_screen');
      await sleep(150);

      expect(described.status).toBe(500);
      // The late describe_screen write was dropped.
      expect(mockSM.setRefMap).not.toHaveBeenCalled();

      await post('/tool/click', { testId: 'x' });

      // Compared against the delivered Login tree, so Wallet is a change:
      // no unchanged retry (3 snapshots so far + 1).
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(3);
      expect(storedRefMap).toStrictEqual(buildTree(['Wallet']).refMap);
    });

    it('stops settling at MOBILE_SETTLE_MAX_MS', async () => {
      await startServer();
      driver.getAccessibilityTree.mockImplementation(async () => {
        await sleep(800);
        return buildTree(['Unlock, busy']);
      });

      await post('/tool/click', { testId: 'x' });

      // 1st snapshot 800 ms, then 300 ms + 800 ms = 1900 ms; a second wait
      // would end at 2200 ms, after the 2000 ms cap (the first snapshot
      // counts). Kept well away from the cap so timer jitter cannot flip it.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('counts the first snapshot against MOBILE_SETTLE_MAX_MS', async () => {
      await startServer();
      let calls = 0;
      driver.getAccessibilityTree.mockImplementation(async () => {
        calls += 1;
        // The click's first capture is slow (a slow Android snapshot).
        await sleep(calls === 2 ? 1_600 : 0);
        return buildTree(['Unlock, busy']);
      });

      await post('/tool/click', { testId: 'x', observe: 'none' });
      await post('/tool/click', { testId: 'x' });

      // 1600 ms capture + 300 ms wait + snapshot = 1900 ms; a second wait
      // would end at 2200 ms, after 2000 ms. Counting from after the first
      // capture would allow 3 extra snapshots.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unchanged screen after a slow first capture', async () => {
      await startServer();
      let calls = 0;
      driver.getAccessibilityTree.mockImplementation(async () => {
        calls += 1;
        // Well above MOBILE_SETTLE_SLOW_CAPTURE_MS: timers can fire a ms
        // early against Date.now().
        await sleep(calls === 2 ? 1_200 : 0);
        return buildTree(['Same']);
      });

      await post('/tool/click', { testId: 'x' });
      await post('/tool/click', { testId: 'x' });

      // 1 (first click) + 1 slow capture, no unchanged retry.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('still retries a busy screen after a slow first capture', async () => {
      await startServer();
      let calls = 0;
      driver.getAccessibilityTree.mockImplementation(async () => {
        calls += 1;
        if (calls === 2) {
          await sleep(1_200);
          return buildTree(['Unlock, busy']);
        }
        return buildTree(calls === 1 ? ['Unlock'] : ['Wallet']);
      });

      await post('/tool/click', { testId: 'x' });
      const { body } = await post('/tool/click', { testId: 'x' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(3);
      expect(
        body.observations?.a11y.nodes.map((node) => node.name),
      ).toStrictEqual(['Wallet']);
    });

    it('does not settle when the tool set refs', async () => {
      await startServer();
      driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));
      addTool('test_ref_tool', async (_input, context) => {
        context.sessionManager.setRefMap(buildTree(['Same']).refMap);
        return { ok: true, result: {} };
      });

      await post('/tool/click', { testId: 'x' });
      await post('/tool/test_ref_tool');

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('settles against the tree describe_screen returned', async () => {
      await startServer();
      driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));

      await post('/tool/describe_screen');
      await post('/tool/click', { testId: 'x' });

      // One describe snapshot; the click snapshot is unchanged against the
      // described tree, so it retries once.
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(3);
    });

    it('does not settle after cleanup', async () => {
      await startServer();
      driver.getAccessibilityTree.mockResolvedValue(
        buildTree(['Unlock, busy']),
      );
      mockSM.cleanup.mockResolvedValue(true);

      await post('/cleanup', { observe: 'full' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(1);
    });

    it('takes the test IDs from the same snapshot as the final tree', async () => {
      await startServer();
      const screens = [
        { names: ['Password', 'Unlock'], testIds: ['login'] },
        { names: ['Password', 'Unlock, busy'], testIds: ['login-busy'] },
        { names: ['Wallet'], testIds: ['wallet'] },
      ].map(({ names, testIds }) => ({
        ...buildTree(names),
        getTestIds: vi.fn(async () =>
          testIds.map((testId) => ({ testId, tag: 'View', visible: true })),
        ),
      }));
      const captureScreen = vi.fn();
      for (const screen of screens) {
        captureScreen.mockResolvedValueOnce(screen);
      }
      Object.assign(driver, { captureScreen });

      await post('/tool/click', { testId: 'x' });
      const { body } = (await post('/tool/click', {
        testId: 'x',
      })) as unknown as {
        body: {
          observations: {
            testIds: { testId: string }[];
            a11y: { nodes: Node[] };
          };
        };
      };

      expect(captureScreen).toHaveBeenCalledTimes(3);
      expect(driver.getAccessibilityTree).not.toHaveBeenCalled();
      expect(driver.getTestIds).not.toHaveBeenCalled();
      expect(screens[1]?.getTestIds).not.toHaveBeenCalled();
      expect(
        body.observations.testIds.map((item) => item.testId),
      ).toStrictEqual(['wallet']);
      expect(
        body.observations.a11y.nodes.map((node) => node.name),
      ).toStrictEqual(['Wallet']);
    });

    it('does not wait when the screen changed', async () => {
      await startServer();
      driver.getAccessibilityTree
        .mockResolvedValueOnce(buildTree(['Login']))
        .mockResolvedValueOnce(buildTree(['Wallet']));

      await post('/tool/click', { testId: 'x' });
      await post('/tool/click', { testId: 'x' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('does not wait for a readonly tool that asked for an observation', async () => {
      await startServer();
      driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));

      await post('/tool/click', { testId: 'x' });
      await post('/tool/get_state', { observe: 'full' });

      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
    });

    it('stops waiting and sets no refs when the request is aborted', async () => {
      await startServer({ requestTimeoutMs: 150 });
      driver.getAccessibilityTree.mockResolvedValue(buildTree(['Same']));

      addTapTool();

      await post('/tool/test_tap');
      mockSM.setRefMap.mockClear();
      const { status } = await post('/tool/test_tap');
      await sleep(250);

      expect(status).toBe(500);
      expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(2);
      expect(mockSM.setRefMap).not.toHaveBeenCalled();
    });
  });
});

describe('screenAfterResponse', () => {
  const tree = [{ ref: 'e1', role: 'button', name: 'Go', path: [] }];
  const other = [{ ref: 'e1', role: 'button', name: 'Back', path: [] }];
  const observation = {
    testIds: [],
    a11y: { nodes: other },
  } as unknown as StepRecordObservation;

  it.each(['launch', 'cleanup'])('returns null after %s', (toolName) => {
    expect(
      screenAfterResponse(
        toolName,
        { ok: true, result: {} },
        observation,
        tree,
      ),
    ).toBeNull();
  });

  it('prefers the delivered observation', () => {
    expect(
      screenAfterResponse(
        'describe_screen',
        { ok: true, result: { a11y: { nodes: tree } } },
        observation,
        null,
      ),
    ).toBe(other);
  });

  it('returns the describe_screen and accessibility_snapshot trees', () => {
    expect(
      screenAfterResponse(
        'describe_screen',
        { ok: true, result: { a11y: { nodes: tree } } },
        undefined,
        null,
      ),
    ).toBe(tree);
    expect(
      screenAfterResponse(
        'accessibility_snapshot',
        { ok: true, result: { nodes: tree } },
        undefined,
        null,
      ),
    ).toBe(tree);
  });

  it('ignores an accessibility_snapshot of a subtree', () => {
    expect(
      screenAfterResponse(
        'accessibility_snapshot',
        { ok: true, result: { nodes: tree } },
        undefined,
        other,
        '#modal',
      ),
    ).toBe(other);
  });

  it('keeps the previous tree for an error or a call without a tree', () => {
    expect(
      screenAfterResponse(
        'describe_screen',
        { ok: false, error: { code: 'X', message: 'x' } },
        undefined,
        tree,
      ),
    ).toBe(tree);
    expect(
      screenAfterResponse(
        'get_state',
        { ok: true, result: {} },
        undefined,
        tree,
      ),
    ).toBe(tree);
  });
});
