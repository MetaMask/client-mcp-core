import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { ServerInstance } from './create-server.js';
import {
  createServer,
  extractTargetFromInput,
  extractScreenshotInfo,
  extractToolOutcome,
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

vi.mock('../knowledge-store/knowledge-store.js', () => {
  const mockStore = {
    recordStep: vi.fn().mockResolvedValue('/mock/path'),
    writeSessionMetadata: vi.fn().mockResolvedValue('/mock/path'),
    getLastSteps: vi.fn().mockResolvedValue([]),
    searchSteps: vi.fn().mockResolvedValue([]),
    summarizeSession: vi.fn().mockResolvedValue({ stepCount: 0, recipe: [] }),
    listSessions: vi.fn().mockResolvedValue([]),
    generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
    getAllSessionIds: vi.fn().mockResolvedValue([]),
    resolveSessionIds: vi.fn().mockResolvedValue([]),
  };
  return {
    KnowledgeStore: vi.fn(() => mockStore),
    createDefaultObservation: vi.fn(
      (state: unknown, testIds?: unknown[], nodes?: unknown[]) => ({
        state: state ?? {},
        testIds: testIds ?? [],
        a11y: { nodes: nodes ?? [] },
      }),
    ),
    createKnowledgeStore: vi.fn(() => mockStore),
    setKnowledgeStore: vi.fn(),
    hasKnowledgeStore: vi.fn(() => false),
    knowledgeStore: mockStore,
  };
});

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
    })),
    setActivePage: vi.fn(),
    getTrackedPages: vi.fn(() => []),
    classifyPageRole: vi.fn(() => 'extension'),
    getContext: vi.fn(() => ({})),
    getExtensionId: vi.fn(() => 'test-ext'),
    getExtensionState: vi.fn(async () => ({})),
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

describe('extractTargetFromInput', () => {
  it('returns undefined for null input', () => {
    expect(extractTargetFromInput(null)).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(extractTargetFromInput('string')).toBeUndefined();
    expect(extractTargetFromInput(42)).toBeUndefined();
  });

  it('returns undefined when no target fields present', () => {
    expect(extractTargetFromInput({ name: 'click' })).toBeUndefined();
  });

  it('extracts a11yRef', () => {
    expect(extractTargetFromInput({ a11yRef: 'e1' })).toStrictEqual({
      a11yRef: 'e1',
      testId: undefined,
      selector: undefined,
    });
  });

  it('extracts testId', () => {
    expect(extractTargetFromInput({ testId: 'btn' })).toStrictEqual({
      a11yRef: undefined,
      testId: 'btn',
      selector: undefined,
    });
  });

  it('extracts selector', () => {
    expect(extractTargetFromInput({ selector: '.my-btn' })).toStrictEqual({
      a11yRef: undefined,
      testId: undefined,
      selector: '.my-btn',
    });
  });

  it('extracts multiple target fields', () => {
    expect(
      extractTargetFromInput({ a11yRef: 'e1', testId: 'btn' }),
    ).toStrictEqual({
      a11yRef: 'e1',
      testId: 'btn',
      selector: undefined,
    });
  });

  it('ignores non-string target values', () => {
    expect(extractTargetFromInput({ a11yRef: 42 })).toBeUndefined();
  });
});

describe('extractScreenshotInfo', () => {
  it('returns undefined for non-screenshot tools', () => {
    expect(extractScreenshotInfo('click', {})).toBeUndefined();
  });

  it('returns undefined when toolResult is not an object', () => {
    expect(extractScreenshotInfo('screenshot', null)).toBeUndefined();
    expect(extractScreenshotInfo('screenshot', 'string')).toBeUndefined();
  });

  it('returns undefined when result is not ok', () => {
    expect(extractScreenshotInfo('screenshot', { ok: false })).toBeUndefined();
  });

  it('returns undefined when result has no path', () => {
    expect(
      extractScreenshotInfo('screenshot', { ok: true, result: {} }),
    ).toBeUndefined();
  });

  it('extracts screenshot path from result.path', () => {
    expect(
      extractScreenshotInfo('screenshot', {
        ok: true,
        result: { path: '/img.png' },
      }),
    ).toStrictEqual({ path: '/img.png' });
  });

  it('extracts screenshot path with dimensions', () => {
    expect(
      extractScreenshotInfo('screenshot', {
        ok: true,
        result: { path: '/img.png', width: 1280, height: 720 },
      }),
    ).toStrictEqual({
      path: '/img.png',
      dimensions: { width: 1280, height: 720 },
    });
  });

  it('extracts screenshot from nested screenshot object', () => {
    expect(
      extractScreenshotInfo('describe_screen', {
        ok: true,
        result: { screenshot: { path: '/ss.png', width: 800, height: 600 } },
      }),
    ).toStrictEqual({
      path: '/ss.png',
      dimensions: { width: 800, height: 600 },
    });
  });

  it('extracts nested screenshot without dimensions', () => {
    expect(
      extractScreenshotInfo('describe_screen', {
        ok: true,
        result: { screenshot: { path: '/ss.png' } },
      }),
    ).toStrictEqual({ path: '/ss.png' });
  });

  it('returns undefined when result.result is null', () => {
    expect(
      extractScreenshotInfo('screenshot', { ok: true, result: null }),
    ).toBeUndefined();
  });

  it('returns undefined when nested screenshot has no path', () => {
    expect(
      extractScreenshotInfo('describe_screen', {
        ok: true,
        result: { screenshot: { width: 800 } },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when nested screenshot is null', () => {
    expect(
      extractScreenshotInfo('describe_screen', {
        ok: true,
        result: { screenshot: null },
      }),
    ).toBeUndefined();
  });
});

describe('extractToolOutcome', () => {
  it('returns ok:true for non-object input', () => {
    expect(extractToolOutcome(null)).toStrictEqual({ ok: true });
    expect(extractToolOutcome('string')).toStrictEqual({ ok: true });
  });

  it('returns ok:true when ok not in result', () => {
    expect(extractToolOutcome({ result: 'data' })).toStrictEqual({ ok: true });
  });

  it('returns ok:true for successful result', () => {
    expect(extractToolOutcome({ ok: true, result: 'data' })).toStrictEqual({
      ok: true,
    });
  });

  it('returns ok:false with error for failed result', () => {
    expect(
      extractToolOutcome({
        ok: false,
        error: { code: 'ERR', message: 'fail' },
      }),
    ).toStrictEqual({
      ok: false,
      error: { code: 'ERR', message: 'fail' },
    });
  });

  it('returns ok:false without error when no error field', () => {
    expect(extractToolOutcome({ ok: false })).toStrictEqual({ ok: false });
  });
});

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

  it('returns true for readonly (collected for knowledge store)', () => {
    expect(shouldCollectObservations('readonly')).toBe(true);
  });

  it('returns true for discovery (collected for knowledge store)', () => {
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

  it('collects observations and records knowledge for tool execution', async () => {
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

  it('records error step when tool execution throws', async () => {
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

  it('playwright helpers called for read-only tools (knowledge store)', async () => {
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

  it('recordStep is called for mutating tool routes', async () => {
    const { KnowledgeStore } =
      await import('../knowledge-store/knowledge-store.js');
    const mockStore = vi.mocked(KnowledgeStore).mock.results.at(-1)?.value as {
      recordStep: ReturnType<typeof vi.fn>;
    };
    mockStore.recordStep.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(mockStore.recordStep).toHaveBeenCalled();
  });

  it('recordStep is called for read-only tool routes', async () => {
    const { KnowledgeStore } =
      await import('../knowledge-store/knowledge-store.js');
    const mockStore = vi.mocked(KnowledgeStore).mock.results.at(-1)?.value as {
      recordStep: ReturnType<typeof vi.fn>;
    };
    mockStore.recordStep.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/tool/get_state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(mockStore.recordStep).toHaveBeenCalled();
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

      const start = Date.now();
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
      expect(Date.now() - start).toBeLessThanOrEqual(600);
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
        `http://127.0.0.1:${state.port}/tool/knowledge_last`,
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
            steps: [{ tool: 'knowledge_last', args: {} }],
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(mockSM.getExtensionState).toHaveBeenCalledTimes(1);
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

  it('knowledge store always receives the full observation instead of the diff', async () => {
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

    const { KnowledgeStore } =
      await import('../knowledge-store/knowledge-store.js');
    const mockStore = vi.mocked(KnowledgeStore).mock.results.at(-1)?.value as {
      recordStep: ReturnType<typeof vi.fn>;
    };
    mockStore.recordStep.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });

    await httpRequest(`http://127.0.0.1:${state.port}/tool/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a11yRef: 'e1' }),
    });

    expect(mockStore.recordStep).toHaveBeenCalledTimes(2);
    const recorded = mockStore.recordStep.mock.calls[1][0] as {
      observation: { a11y: { nodes: unknown[]; diff?: unknown } };
    };

    expect(recorded.observation.a11y.diff).toBeUndefined();
    expect(recorded.observation.a11y.nodes).toStrictEqual(changedButtons);
  });

  it('knowledge store receives full uncompacted observations', async () => {
    const { KnowledgeStore } =
      await import('../knowledge-store/knowledge-store.js');
    const mockStore = vi.mocked(KnowledgeStore).mock.results.at(-1)?.value as {
      recordStep: ReturnType<typeof vi.fn>;
    };
    mockStore.recordStep.mockClear();

    await httpRequest(`http://127.0.0.1:${state.port}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(mockStore.recordStep).toHaveBeenCalled();
    const recorded = mockStore.recordStep.mock.calls[0][0] as {
      observation: { a11y: { nodes: unknown[] } };
    };
    expect(recorded.observation.a11y.nodes).toHaveLength(12);
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
