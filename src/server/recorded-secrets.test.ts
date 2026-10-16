import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from './create-server.js';
import type { ServerInstance } from './create-server.js';
import { KnowledgeStore } from '../knowledge-store/knowledge-store.js';
import { toolRegistry } from '../tools/registry.js';
import { createMockSessionManager } from '../tools/test-utils/mock-factories.js';
import type { StepRecord } from '../tools/types/step-record.js';
import type { ServerConfig, ToolResponse } from '../types/http.js';

// Synthetic credentials only. Escaping exercises JSON echoes in recorded errors.
const mnemonic = 'synthetic alpha bravo charlie delta echo foxtrot golf';
const password = 'synthetic-Password-"quoted"\\path\nAIENG-228';
const sessionId = 'mm-onboarding-2026';
let tmpDir: string;

vi.mock('node:child_process', () => ({
  execSync: () => Buffer.from(`${tmpDir}\n`),
}));
vi.mock('../tools/utils/discovery.js', () => ({
  collectTestIds: async () => [],
  collectTrimmedA11ySnapshot: async () => ({ nodes: [], refMap: new Map() }),
}));

describe('secret recording through HTTP to disk', () => {
  let server: ServerInstance;
  let port: number;
  let stepsDir: string;
  const send = vi.fn();
  const cdp = vi.fn();
  const setClipboard = vi.fn();
  const getPlatform = vi.fn();
  const originalCdpTool = toolRegistry.get('cdp');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-recorded-secrets-'));
    stepsDir = path.join(tmpDir, sessionId, 'steps');
    send.mockResolvedValue({ result: { value: mnemonic } });
    cdp.mockResolvedValue({ ok: true, result: { text: password } });
    setClipboard.mockResolvedValue(undefined);
    getPlatform.mockReturnValue('browser');
    const sessionManager = createMockSessionManager({
      hasActive: true,
      sessionId,
      environmentMode: 'prod',
    });
    sessionManager.getPage.mockReturnValue({
      context: () => ({
        newCDPSession: async () => ({ send, detach: async () => undefined }),
      }),
      waitForLoadState: async () => undefined,
      waitForFunction: async () => undefined,
    });
    const driver = {
      getPlatform,
      cdp,
      setClipboard,
      getClipboard: async () => mnemonic,
      getAppState: sessionManager.getExtensionState,
      getTestIds: async () => [],
      getAccessibilityTree: async () => ({ nodes: [], refMap: new Map() }),
    };
    server = createServer({
      sessionManager: {
        ...sessionManager,
        getPlatformDriver: () => driver,
      } as unknown as ServerConfig['sessionManager'],
      knowledgeStore: new KnowledgeStore({ rootDir: tmpDir }),
      contextFactory: () => ({ config: { environment: 'prod' } }),
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    if (originalCdpTool) {
      toolRegistry.set('cdp', originalCdpTool);
    }
    await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function execute(tool: string, input: Record<string, unknown>) {
    // fetch is available throughout the package's supported Node >=20 range.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const response = await fetch(`http://127.0.0.1:${port}/tool/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return {
      status: response.status,
      body: (await response.json()) as ToolResponse,
    };
  }

  async function recordedSteps() {
    const filenames = await fs.readdir(stepsDir);
    const steps: StepRecord[] = [];
    for (const filename of filenames) {
      const contents = await fs.readFile(
        path.join(stepsDir, filename),
        'utf-8',
      );
      for (const secret of [mnemonic, password]) {
        expect(filename).not.toContain(secret);
        expect(contents).not.toContain(JSON.stringify(secret).slice(1, -1));
      }
      const step = JSON.parse(contents) as StepRecord;
      expect(step).toMatchObject({ sessionId, context: 'prod' });
      steps.push(step);
    }
    return steps;
  }

  it('records the onboarding inputs without changing tool delivery or results', async () => {
    const clipboard = await execute('clipboard', {
      action: 'write',
      text: mnemonic,
    });
    const params = { text: password };
    const cdpResult = { text: password };
    cdp.mockResolvedValueOnce({ ok: true, result: cdpResult });
    const inserted = await execute('cdp', {
      method: 'Input.insertText',
      params,
    });
    getPlatform.mockReturnValue('ios');
    const mobile = await execute('device_clipboard', {
      action: 'write',
      text: mnemonic,
    });

    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: `navigator.clipboard.writeText(${JSON.stringify(mnemonic)})`,
      }),
    );
    expect(cdp).toHaveBeenCalledWith(expect.objectContaining({ params }));
    expect(setClipboard).toHaveBeenCalledWith(mnemonic);
    expect(clipboard.body).toMatchObject({
      ok: true,
      result: { text: mnemonic },
    });
    expect(inserted.body).toMatchObject({
      ok: true,
      result: { result: cdpResult },
    });
    expect(mobile.body).toMatchObject({ ok: true, result: { success: true } });
    const steps = await recordedSteps();
    expect(steps.map((step) => step.tool.name).sort()).toStrictEqual([
      'cdp',
      'clipboard',
      'device_clipboard',
    ]);
    for (const step of steps) {
      expect(step.tool.textRedacted).toBe(true);
      expect(step.outcome).toStrictEqual({ ok: true });
      if (step.tool.name === 'cdp') {
        expect(step.tool.input).toMatchObject({
          method: 'Input.insertText',
          params: '[REDACTED]',
        });
      } else {
        expect(step.tool).toMatchObject({
          input: { action: 'write', text: '[REDACTED]' },
          textLength: mnemonic.length,
        });
      }
    }
  });

  it.each(['clipboard', 'device_clipboard', 'device-clipboard'])(
    'redacts %s and arbitrary CDP params inside recursive batches',
    async (tool) => {
      getPlatform.mockReturnValue(tool === 'clipboard' ? 'browser' : 'android');
      const params = { arguments: [{ value: password }] };
      const nestedSteps = [
        { tool, args: { action: 'write', text: mnemonic } },
        { tool: 'cdp', args: { method: 'Runtime.callFunctionOn', params } },
      ];
      const response = await execute('run_steps', {
        includeObservations: 'none',
        steps: [{ tool: 'run_steps', args: { steps: nestedSteps } }],
      });

      expect(response.body).toMatchObject({
        ok: true,
        result: { summary: { ok: true } },
      });
      expect(cdp).toHaveBeenCalledWith(expect.objectContaining({ params }));
      if (tool === 'clipboard') {
        expect(send).toHaveBeenCalledWith(
          'Runtime.evaluate',
          expect.objectContaining({
            expression: `navigator.clipboard.writeText(${JSON.stringify(mnemonic)})`,
          }),
        );
      } else {
        expect(setClipboard).toHaveBeenCalledWith(mnemonic);
      }
      const steps = await recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0].tool.textRedacted).toBe(true);
    },
  );

  it.each(['tool-returned', 'server-exception'])(
    'scrubs raw and escaped credentials in the %s error recording path',
    async (mode) => {
      const message = `echo ${password}; params=${JSON.stringify({ text: password })}`;
      const code =
        mode === 'tool-returned' ? 'MM_CDP_FAILED' : 'TOOL_EXECUTION_FAILED';
      if (mode === 'tool-returned') {
        cdp.mockResolvedValueOnce({ ok: false, code, message });
      } else {
        toolRegistry.set('cdp', async () => {
          throw new Error(message);
        });
      }
      const response = await execute('cdp', {
        method: 'Input.insertText',
        params: { text: password },
      });

      expect(response.status).toBe(mode === 'tool-returned' ? 200 : 500);
      expect(response.body).toMatchObject({
        ok: false,
        error: { code, message },
      });
      const steps = await recordedSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0].outcome.error).toStrictEqual({
        code,
        message: 'echo [REDACTED]; params={"text":"[REDACTED]"}',
      });
    },
  );

  it('keeps clipboard reads and parameterless CDP inputs useful', async () => {
    const response = await execute('clipboard', { action: 'read' });
    await execute('cdp', { method: 'Network.enable' });

    expect(response.body).toMatchObject({
      ok: true,
      result: { text: mnemonic },
    });
    const steps = await recordedSteps();
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.tool.input)).toStrictEqual(
      expect.arrayContaining([
        { action: 'read' },
        { method: 'Network.enable', timeoutMs: 30_000, target: 'hermes' },
      ]),
    );
    expect(steps.every((step) => step.tool.textRedacted === undefined)).toBe(
      true,
    );
  });
});
