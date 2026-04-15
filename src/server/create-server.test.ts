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
} from './create-server.js';
import { readDaemonState } from './daemon-state.js';
import type { DaemonState, ServerConfig } from '../types/http.js';
import { PACKAGE_VERSION } from '../version.js';

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
    getPage: vi.fn(() => ({})),
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
    contextFactory: () =>
      ({}) as unknown as ReturnType<ServerConfig['contextFactory']>,
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
      ports: Record<string, number>;
    };

    expect(res.status).toBe(200);
    expect(body.daemon.pid).toBe(process.pid);
    expect(body.daemon.port).toBe(state.port);
    expect(body.ports).toBeDefined();
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
    expect(daemonState?.version).toBe(PACKAGE_VERSION);
  });

  it('passes workflow context to session manager on start', async () => {
    await server.stop();

    const workflowContext = { config: { environment: 'e2e' as const } };
    const mockSM = createMockSessionManager();
    const customServer = createServer(
      buildConfig({
        sessionManager: mockSM as unknown as ServerConfig['sessionManager'],
        contextFactory: () =>
          workflowContext as unknown as ReturnType<
            ServerConfig['contextFactory']
          >,
      }),
    );

    await customServer.start();
    expect(mockSM.setWorkflowContext).toHaveBeenCalledWith(workflowContext);
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
});
