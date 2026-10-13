import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from './create-server.js';
import type { ServerInstance } from './create-server.js';
import { KnowledgeStore } from '../knowledge-store/knowledge-store.js';
import { toolRegistry } from '../tools/registry.js';
import type { StepRecord } from '../tools/types/step-record.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
} from '../tools/utils/discovery.js';
import type { ServerConfig, ToolResponse } from '../types/http.js';

// Deliberately synthetic values, never wallet credentials.
const mnemonic =
  'synthetic alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo';
const password = 'synthetic-Password-"quoted"\\path\nAIENG-228';
const sessionId = 'mm-synthetic-onboarding-2026';
let tmpDir: string;

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

describe('recorded onboarding secrets', () => {
  let server: ServerInstance;
  let port: number;
  let knowledgeRoot: string;
  let store: KnowledgeStore;
  const send = vi.fn();
  const cdp = vi.fn();
  const getExtensionState = vi.fn();
  const getPlatform = vi.fn();
  const setClipboard = vi.fn();
  const getClipboard = vi.fn();
  const originalCdpTool = toolRegistry.get('cdp');

  function observeEchoes(...values: string[]) {
    getExtensionState.mockResolvedValue({
      currentScreen: 'onboarding',
      currentUrl: 'chrome-extension://synthetic/home.html',
      networkName: `echo: ${values.join('; ')}; ${JSON.stringify(values)}`,
    });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-recorded-secrets-'));
    knowledgeRoot = path.join(tmpDir, 'test-artifacts', 'llm-knowledge');
    store = new KnowledgeStore({ rootDir: knowledgeRoot });
    send.mockResolvedValue({});
    cdp.mockResolvedValue({ ok: true, result: {} });
    getPlatform.mockReturnValue('browser');
    setClipboard.mockResolvedValue(undefined);
    getClipboard.mockResolvedValue(mnemonic);
    vi.mocked(collectTestIds).mockResolvedValue([]);
    vi.mocked(collectTrimmedA11ySnapshot).mockResolvedValue({
      nodes: [],
      refMap: new Map(),
    });
    observeEchoes();

    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send,
          detach: async () => undefined,
        }),
      }),
      waitForLoadState: async () => undefined,
      waitForFunction: async () => undefined,
    };
    const sessionManager = {
      hasActiveSession: () => true,
      getSessionId: () => sessionId,
      getPage: () => page,
      getRefMap: () => new Map(),
      setRefMap: () => undefined,
      setWorkflowContext: () => undefined,
      getEnvironmentMode: () => 'prod',
      getPlatformDriver: () => ({
        getPlatform,
        cdp,
        setClipboard,
        getClipboard,
        getAppState: getExtensionState,
        getTestIds: async () => [],
        getAccessibilityTree: async () => ({ nodes: [], refMap: new Map() }),
      }),
      getExtensionState,
      cleanup: async () => true,
    } as unknown as ServerConfig['sessionManager'];

    server = createServer({
      sessionManager,
      knowledgeStore: store,
      contextFactory: () => ({
        config: { environment: 'prod', extensionName: 'Synthetic Extension' },
      }),
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    if (originalCdpTool) {
      toolRegistry.set('cdp', originalCdpTool);
    }
    await server?.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function execute(tool: string, input: Record<string, unknown>) {
    return new Promise<{
      status: number;
      body: ToolResponse<Record<string, unknown>>;
    }>((resolve, reject) => {
      const request = http.request(
        `http://127.0.0.1:${port}/tool/${tool}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(data) as ToolResponse<Record<string, unknown>>,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(input));
    });
  }

  async function readRecordedStep(tool: string, secrets: string[]) {
    const stepsDir = path.join(knowledgeRoot, sessionId, 'steps');
    const filenames = await fs.readdir(stepsDir);
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toMatch(new RegExp(`-${tool}\\.json$`, 'u'));
    const filepath = path.join(stepsDir, filenames[0]);
    const contents = await fs.readFile(filepath, 'utf-8');
    const step = JSON.parse(contents) as StepRecord;
    function assertNoSecretStrings(value: unknown) {
      if (typeof value === 'string') {
        for (const secret of secrets) {
          expect(value).not.toContain(secret);
          expect(value).not.toContain(JSON.stringify(secret).slice(1, -1));
        }
      } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          assertNoSecretStrings(key);
          assertNoSecretStrings(entry);
        }
      }
    }
    assertNoSecretStrings(step);
    for (const secret of secrets) {
      expect(filepath).not.toContain(secret);
      expect(contents).not.toContain(secret);
      expect(contents).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(step).toMatchObject({
      schemaVersion: 1,
      sessionId,
      context: 'prod',
      tool: { name: tool },
      timing: { durationMs: expect.any(Number) },
    });
    return step;
  }

  it('persists a clipboard write without the mnemonic and delivers the original text', async () => {
    observeEchoes(mnemonic);
    const response = await execute('clipboard', {
      action: 'write',
      text: mnemonic,
    });

    expect(send).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: `navigator.clipboard.writeText(${JSON.stringify(mnemonic)})`,
      awaitPromise: true,
      userGesture: true,
    });
    expect(response.body).toMatchObject({
      ok: true,
      result: { action: 'write', success: true, text: mnemonic },
    });
    const step = await readRecordedStep('clipboard', [mnemonic]);
    expect(step.tool).toMatchObject({
      input: { action: 'write', text: '[REDACTED]' },
      textRedacted: true,
      textLength: mnemonic.length,
    });
    expect(step.outcome).toStrictEqual({ ok: true });
  });

  it('persists Input.insertText without the password and preserves the CDP result for the caller', async () => {
    observeEchoes(password);
    cdp.mockResolvedValueOnce({ ok: true, result: { text: password } });
    const params = { text: password };
    const response = await execute('cdp', {
      method: 'Input.insertText',
      params,
    });

    expect(cdp).toHaveBeenCalledWith({
      method: 'Input.insertText',
      params,
      timeoutMs: 30_000,
      target: 'hermes',
    });
    expect(response.body).toMatchObject({
      ok: true,
      result: { method: 'Input.insertText', result: { text: password } },
    });
    const step = await readRecordedStep('cdp', [password]);
    expect(step.tool).toMatchObject({
      input: {
        method: 'Input.insertText',
        params: '[REDACTED]',
        timeoutMs: 30_000,
        target: 'hermes',
      },
      textRedacted: true,
    });
    expect(step.tool.textLength).toBeUndefined();
    expect(step.outcome).toStrictEqual({ ok: true });
  });

  it('redacts all CDP params, including nested values, without a method allowlist', async () => {
    observeEchoes(password, mnemonic);
    const params = { arguments: [{ value: password }, { value: mnemonic }] };
    await execute('cdp', { method: 'Runtime.callFunctionOn', params });

    expect(cdp).toHaveBeenCalledWith(expect.objectContaining({ params }));
    const step = await readRecordedStep('cdp', [password, mnemonic]);
    expect(step.tool.input?.params).toBe('[REDACTED]');
  });

  it('keeps the step schema and redaction marker intact for short CDP strings', async () => {
    await execute('cdp', {
      method: 'Runtime.callFunctionOn',
      params: { arguments: [{ value: 'ok' }, { value: 'RED' }] },
    });

    const step = await readRecordedStep('cdp', []);
    expect(step.tool.input?.params).toBe('[REDACTED]');
    expect(step.tool.textRedacted).toBe(true);
    expect(step.outcome).toStrictEqual({ ok: true });
  });

  it.each(['2', 'o'])(
    'preserves metadata and observation substrings when dispatching %s',
    async (text) => {
      const params = { type: 'char', text, key: text };
      const testIds = [
        {
          testId: 'onboarding-step-2',
          tag: 'button',
          text: `echo ${text}`,
          visible: true,
        },
        { testId: 'exact-echo', tag: 'span', text, visible: true },
      ];
      const nodes = [
        {
          ref: 'e2',
          role: 'button',
          name: 'Continue onboarding 2',
          path: ['dialog', 'button'],
          testId: 'onboarding-step-2',
          textContent: `echo ${text}`,
        },
        { ref: 'e3', role: 'textbox', name: text, path: ['dialog'] },
      ];
      vi.mocked(collectTestIds).mockResolvedValue(testIds);
      vi.mocked(collectTrimmedA11ySnapshot).mockResolvedValue({
        nodes,
        refMap: new Map(),
      });
      getExtensionState.mockResolvedValue({
        currentScreen: 'onboarding',
        currentUrl: 'chrome-extension://synthetic/home.html',
        networkName: text,
        balance: '20 tokens',
      });
      cdp.mockResolvedValueOnce({
        ok: false,
        code: `MM_CDP_${text}`,
        message: text,
      });
      const before = Date.now();
      const response = await execute('cdp', {
        method: 'Input.dispatchKeyEvent',
        params,
      });
      const after = Date.now();

      expect(cdp).toHaveBeenCalledWith(expect.objectContaining({ params }));
      expect(response.body).toMatchObject({
        ok: false,
        error: { code: `MM_CDP_${text}`, message: text },
      });
      const step = await readRecordedStep('cdp', []);
      expect(Date.parse(step.timestamp)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(step.timestamp)).toBeLessThanOrEqual(after);
      expect(new Date(step.timestamp).toISOString()).toBe(step.timestamp);
      expect(step.environment?.nodeVersion).toBe(process.version);
      expect(step.tool).toMatchObject({
        name: 'cdp',
        input: { method: 'Input.dispatchKeyEvent', params: '[REDACTED]' },
      });
      expect(step.labels).toStrictEqual(['error-recovery']);
      expect(step.outcome.error).toStrictEqual({
        code: `MM_CDP_${text}`,
        message: '[REDACTED]',
      });
      expect(step.observation.state).toStrictEqual({
        currentScreen: 'onboarding',
        currentUrl: 'chrome-extension://synthetic/home.html',
        networkName: '[REDACTED]',
        balance: '20 tokens',
      });
      expect(step.observation.testIds).toStrictEqual([
        testIds[0],
        { ...testIds[1], text: '[REDACTED]' },
      ]);
      expect(step.observation.a11y.nodes).toStrictEqual([
        nodes[0],
        { ...nodes[1], name: '[REDACTED]' },
      ]);
    },
  );

  it('uses raw string length for escaped echoes at the eight-character boundary', async () => {
    const short = '"""""""';
    const long = '""""""""';
    const escapedShort = JSON.stringify(short).slice(1, -1);
    const escapedLong = JSON.stringify(long).slice(1, -1);
    await store.recordStep({
      sessionId,
      toolName: 'cdp',
      input: { method: 'Runtime.evaluate', params: { short, long } },
      context: 'prod',
      durationMs: 5,
      target: { selector: short, testId: `prefix ${short}` },
      outcome: {
        ok: false,
        error: {
          code: short,
          message: `prefix ${long}; escaped ${escapedLong}; short ${escapedShort}`,
          details: {
            rawShort: short,
            escapedShort,
            embeddedShort: `prefix ${short}`,
            embeddedEscapedShort: `prefix ${escapedShort}`,
            [short]: escapedShort,
            [`prefix ${escapedShort}`]: 'diagnostic',
          },
        },
      },
      observation: {
        state: {
          currentScreen: 'onboarding',
        } as StepRecord['observation']['state'],
        testIds: [],
        a11y: { nodes: [] },
      },
      screenshotPath: `prefix ${escapedShort}`,
    });

    const step = await readRecordedStep('cdp', []);
    expect(step.outcome.error).toStrictEqual({
      code: short,
      message: `prefix [REDACTED]; escaped [REDACTED]; short ${escapedShort}`,
      details: {
        rawShort: '[REDACTED]',
        escapedShort: '[REDACTED]',
        embeddedShort: `prefix ${short}`,
        embeddedEscapedShort: `prefix ${escapedShort}`,
        '[REDACTED]': '[REDACTED]',
        [`prefix ${escapedShort}`]: 'diagnostic',
      },
    });
    expect(step.tool.target).toStrictEqual({
      selector: '[REDACTED]',
      testId: `prefix ${short}`,
    });
    expect(step.artifacts?.screenshot?.path).toBe(`prefix ${escapedShort}`);
  });

  it('preserves structural metadata even when it exactly matches a long redacted value', async () => {
    const structuralValue = 'error-recovery';
    await store.recordStep({
      sessionId,
      toolName: structuralValue,
      input: { password: structuralValue },
      context: 'prod',
      durationMs: 5,
      outcome: {
        ok: false,
        error: { code: structuralValue, message: `echo ${structuralValue}` },
      },
      observation: {
        state: {
          currentScreen: 'onboarding',
        } as StepRecord['observation']['state'],
        testIds: [],
        a11y: { nodes: [] },
      },
    });

    const step = await readRecordedStep(structuralValue, []);
    expect(step.tool.input).toStrictEqual({ password: '[REDACTED]' });
    expect(step.labels).toStrictEqual([structuralValue]);
    expect(step.outcome.error).toStrictEqual({
      code: structuralValue,
      message: 'echo [REDACTED]',
    });
  });

  it('preserves existing redaction markers inside scrubbed text', async () => {
    await store.recordStep({
      sessionId,
      toolName: 'cdp',
      input: {
        method: 'Runtime.evaluate',
        params: { text: 'REDACTED', empty: '' },
      },
      context: 'prod',
      durationMs: 5,
      outcome: {
        ok: false,
        error: { code: 'MM_CDP_FAILED', message: '[REDACTED] and REDACTED' },
      },
      observation: {
        state: {} as StepRecord['observation']['state'],
        testIds: [],
        a11y: { nodes: [] },
      },
    });

    const step = await readRecordedStep('cdp', []);
    expect(step.tool.input?.params).toBe('[REDACTED]');
    expect(step.outcome.error?.message).toBe('[REDACTED] and [REDACTED]');
  });

  it('scrubs observation text while preserving accessibility and prior-knowledge metadata', async () => {
    const timestamp = '2026-10-13T12:00:00.000Z';
    const input = {
      method: 'Runtime.evaluate',
      params: {
        strings: [
          password,
          'button',
          'element',
          'e2',
          'type',
          'testId',
          'a11yHint',
          'prod',
          'cdp',
          process.version,
          timestamp,
          sessionId,
        ],
      },
    };
    const observation: StepRecord['observation'] = {
      state: {
        currentScreen: 'onboarding',
        activeTab: { role: 'button', url: `echo ${password}`, title: password },
      } as StepRecord['observation']['state'],
      testIds: [
        { testId: 'testId', tag: 'element', text: password, visible: true },
      ],
      a11y: {
        nodes: [
          {
            ref: 'e2',
            role: 'button',
            name: password,
            path: [password],
            textContent: password,
          },
        ],
        diff: { added: [password], removed: ['testId'], unchanged: 2 },
      },
      priorKnowledge: {
        schemaVersion: 1,
        generatedAt: timestamp,
        query: {
          windowHours: 48,
          usedFlowTags: ['type'],
          usedFilters: { screen: password },
          candidateSessions: 1,
          candidateSteps: 1,
        },
        relatedSessions: [
          {
            sessionId,
            createdAt: timestamp,
            goal: password,
            flowTags: ['type'],
            tags: ['testId'],
          },
        ],
        similarSteps: [
          {
            sessionId,
            timestamp,
            tool: 'cdp',
            screen: password,
            snippet: password,
            labels: ['type'],
            target: { testId: 'testId' },
            a11yHint: { role: 'button', name: password },
            confidence: 1,
          },
        ],
        suggestedNextActions: [
          {
            rank: 1,
            action: 'type',
            rationale: password,
            confidence: 1,
            preferredTarget: {
              type: 'a11yHint',
              value: { role: 'button', name: password },
            },
            fallbackTargets: [
              { type: 'testId', value: 'testId' },
              { type: 'selector', value: `echo ${password}` },
            ],
          },
        ],
        avoid: [
          {
            rationale: password,
            target: { selector: password },
            errorCode: password,
            frequency: 1,
          },
        ],
      },
    };
    const original = structuredClone({ input, observation });
    await store.recordStep({
      sessionId,
      toolName: 'cdp',
      input,
      observation,
      context: 'prod',
      durationMs: 5,
      outcome: { ok: true },
    });

    const step = await readRecordedStep('cdp', []);
    expect(step.environment?.nodeVersion).toBe(process.version);
    expect(step.tool.input).toStrictEqual({
      method: 'Runtime.evaluate',
      params: '[REDACTED]',
    });
    expect(step.observation.state.activeTab).toStrictEqual({
      role: 'button',
      url: 'echo [REDACTED]',
      title: '[REDACTED]',
    });
    expect(step.observation.testIds).toStrictEqual([
      {
        testId: '[REDACTED]',
        tag: 'element',
        text: '[REDACTED]',
        visible: true,
      },
    ]);
    expect(step.observation.a11y).toStrictEqual({
      nodes: [
        {
          ref: 'e2',
          role: 'button',
          name: '[REDACTED]',
          path: ['[REDACTED]'],
          textContent: '[REDACTED]',
        },
      ],
      diff: { added: ['[REDACTED]'], removed: ['[REDACTED]'], unchanged: 2 },
    });
    expect(step.observation.priorKnowledge).toStrictEqual({
      ...observation.priorKnowledge,
      query: {
        ...observation.priorKnowledge?.query,
        usedFilters: { screen: '[REDACTED]' },
      },
      relatedSessions: [
        {
          sessionId,
          createdAt: timestamp,
          goal: '[REDACTED]',
          flowTags: ['type'],
          tags: ['testId'],
        },
      ],
      similarSteps: [
        {
          sessionId,
          timestamp,
          tool: 'cdp',
          screen: '[REDACTED]',
          snippet: '[REDACTED]',
          labels: ['type'],
          target: { testId: '[REDACTED]' },
          a11yHint: { role: 'button', name: '[REDACTED]' },
          confidence: 1,
        },
      ],
      suggestedNextActions: [
        {
          rank: 1,
          action: 'type',
          rationale: '[REDACTED]',
          confidence: 1,
          preferredTarget: {
            type: 'a11yHint',
            value: { role: 'button', name: '[REDACTED]' },
          },
          fallbackTargets: [
            { type: 'testId', value: '[REDACTED]' },
            { type: 'selector', value: 'echo [REDACTED]' },
          ],
        },
      ],
      avoid: [
        {
          rationale: '[REDACTED]',
          target: { selector: '[REDACTED]' },
          errorCode: password,
          frequency: 1,
        },
      ],
    });
    expect({ input, observation }).toStrictEqual(original);
  });

  it('redacts mobile clipboard writes while delivering the original text to the driver', async () => {
    getPlatform.mockReturnValue('ios');
    observeEchoes(mnemonic);
    const response = await execute('device_clipboard', {
      action: 'write',
      text: mnemonic,
    });

    expect(setClipboard).toHaveBeenCalledWith(mnemonic);
    expect(response.body).toMatchObject({
      ok: true,
      result: { action: 'write', success: true },
    });
    const step = await readRecordedStep('device_clipboard', [mnemonic]);
    expect(step.tool).toMatchObject({
      input: { action: 'write', text: '[REDACTED]' },
      textRedacted: true,
      textLength: mnemonic.length,
    });
    expect(step.outcome).toStrictEqual({ ok: true });
  });

  it('scrubs mobile clipboard errors while preserving the HTTP error', async () => {
    getPlatform.mockReturnValue('android');
    setClipboard.mockRejectedValueOnce(
      new Error(`Unable to write ${mnemonic}`),
    );
    const response = await execute('device_clipboard', {
      action: 'write',
      text: mnemonic,
    });

    expect(setClipboard).toHaveBeenCalledWith(mnemonic);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'MM_DEVICE_ACTION_FAILED',
        message: expect.stringContaining(mnemonic),
      },
    });
    const step = await readRecordedStep('device_clipboard', [mnemonic]);
    expect(step.outcome.error).toStrictEqual({
      code: 'MM_DEVICE_ACTION_FAILED',
      message: 'Device clipboard operation failed: Unable to write [REDACTED]',
    });
  });

  it.each(['device_clipboard', 'device-clipboard'])(
    'redacts %s text inside nested run_steps without changing execution',
    async (tool) => {
      getPlatform.mockReturnValue('ios');
      const response = await execute('run_steps', {
        includeObservations: 'none',
        steps: [
          {
            tool: 'run_steps',
            args: {
              steps: [
                {
                  tool,
                  args: { action: 'write', text: mnemonic },
                },
              ],
            },
          },
        ],
      });

      expect(setClipboard).toHaveBeenCalledWith(mnemonic);
      expect(response.body).toMatchObject({
        ok: true,
        result: { summary: { ok: true } },
      });
      const step = await readRecordedStep('run_steps', [mnemonic]);
      expect(step.tool.input?.steps).toStrictEqual([
        {
          tool: 'run_steps',
          args: {
            steps: [
              {
                tool,
                args: { action: 'write', text: '[REDACTED]' },
              },
            ],
          },
        },
      ]);
    },
  );

  it('preserves mobile clipboard reads and their original HTTP result', async () => {
    getPlatform.mockReturnValue('android');
    const response = await execute('device_clipboard', { action: 'read' });

    expect(getClipboard).toHaveBeenCalledWith();
    expect(response.body).toMatchObject({
      ok: true,
      result: { action: 'read', text: mnemonic },
    });
    const step = await readRecordedStep('device_clipboard', [mnemonic]);
    expect(step.tool.input).toStrictEqual({ action: 'read' });
    expect(step.tool.textRedacted).toBeUndefined();
    expect(step.outcome).toStrictEqual({ ok: true });
  });

  it.each(['returned error', 'thrown error'])(
    'scrubs CDP %s echoes but keeps the error code',
    async (mode) => {
      const message = `Unable to insert ${password}; params=${JSON.stringify({ text: password })}`;
      if (mode === 'returned error') {
        cdp.mockResolvedValueOnce({
          ok: false,
          code: 'MM_CDP_FAILED',
          message,
        });
      } else {
        cdp.mockRejectedValueOnce(new Error(message));
      }
      const response = await execute('cdp', {
        method: 'Input.insertText',
        params: { text: password },
      });

      expect(response.body).toMatchObject({
        ok: false,
        error: {
          code: 'MM_CDP_FAILED',
          message: expect.stringContaining(password),
        },
      });
      const step = await readRecordedStep('cdp', [password]);
      expect(step.outcome).toMatchObject({
        ok: false,
        error: {
          code: 'MM_CDP_FAILED',
          message: expect.stringContaining('[REDACTED]'),
        },
      });
      expect(step.labels).toContain('error-recovery');
    },
  );

  it('scrubs clipboard errors that echo the mnemonic', async () => {
    send.mockRejectedValueOnce(new Error(`Unable to write ${mnemonic}`));
    const response = await execute('clipboard', {
      action: 'write',
      text: mnemonic,
    });

    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'MM_CLIPBOARD_FAILED',
        message: expect.stringContaining(mnemonic),
      },
    });
    const step = await readRecordedStep('clipboard', [mnemonic]);
    expect(step.outcome.error).toStrictEqual({
      code: 'MM_CLIPBOARD_FAILED',
      message: 'Clipboard operation failed: Unable to write [REDACTED]',
    });
  });

  it('scrubs errors recorded by the server exception path', async () => {
    toolRegistry.set('cdp', async () => {
      throw new Error(`Unexpected failure: ${password}`);
    });
    const response = await execute('cdp', {
      method: 'Input.insertText',
      params: { text: password },
    });

    expect(response.status).toBe(500);
    const step = await readRecordedStep('cdp', [password]);
    expect(step.outcome.error).toStrictEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: 'Unexpected failure: [REDACTED]',
    });
  });

  it('redacts clipboard and CDP inputs in a persisted onboarding batch', async () => {
    await execute('run_steps', {
      includeObservations: 'none',
      steps: [
        { tool: 'clipboard', args: { action: 'write', text: mnemonic } },
        {
          tool: 'cdp',
          args: { method: 'Input.insertText', params: { text: password } },
        },
      ],
    });

    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: `navigator.clipboard.writeText(${JSON.stringify(mnemonic)})`,
      }),
    );
    expect(cdp).toHaveBeenCalledWith(
      expect.objectContaining({ params: { text: password } }),
    );
    const step = await readRecordedStep('run_steps', [mnemonic, password]);
    expect(step.tool.input?.steps).toStrictEqual([
      { tool: 'clipboard', args: { action: 'write', text: '[REDACTED]' } },
      {
        tool: 'cdp',
        args: { method: 'Input.insertText', params: '[REDACTED]' },
      },
    ]);
  });

  it('leaves no mnemonic or password in any step file after the onboarding input sequence', async () => {
    observeEchoes(mnemonic);
    await execute('clipboard', { action: 'write', text: mnemonic });
    observeEchoes(password);
    await execute('cdp', {
      method: 'Input.insertText',
      params: { text: password },
    });

    const stepsDir = path.join(knowledgeRoot, sessionId, 'steps');
    const filenames = await fs.readdir(stepsDir);
    expect(filenames).toHaveLength(2);
    for (const filename of filenames) {
      const contents = await fs.readFile(
        path.join(stepsDir, filename),
        'utf-8',
      );
      expect(contents).not.toContain(mnemonic);
      expect(contents).not.toContain(JSON.stringify(password).slice(1, -1));
    }
  });

  it('preserves existing sensitive-field redaction and ordinary text recording', async () => {
    const cases = [
      {
        tool: 'type',
        input: { testId: 'password-input', text: password },
        recordedInput: { testId: 'password-input', text: '[REDACTED]' },
        secrets: [password],
      },
      {
        tool: 'custom',
        input: { apiKey: password, description: 'diagnostic' },
        recordedInput: { apiKey: '[REDACTED]', description: 'diagnostic' },
        secrets: [password],
      },
      {
        tool: 'type',
        input: { testId: 'recipient-input', text: '0x1234' },
        recordedInput: { testId: 'recipient-input', text: '0x1234' },
        secrets: [],
      },
    ];
    for (const { tool, input, recordedInput, secrets } of cases) {
      await store.recordStep({
        sessionId,
        toolName: tool,
        input,
        outcome: {
          ok: false,
          error: { code: 'EXAMPLE', message: `echo ${password}` },
        },
        observation: {
          state: {} as StepRecord['observation']['state'],
          testIds: [],
          a11y: { nodes: [] },
        },
        context: 'prod',
        durationMs: 5,
      });
      const step = await readRecordedStep(tool, secrets);
      expect(step.tool.input).toStrictEqual(recordedInput);
      await fs.rm(path.join(knowledgeRoot, sessionId, 'steps'), {
        recursive: true,
      });
    }
  });

  it('keeps clipboard reads and parameterless CDP calls useful', async () => {
    await execute('cdp', { method: 'Network.enable' });
    const step = await readRecordedStep('cdp', []);
    expect(step.tool.input).toStrictEqual({
      method: 'Network.enable',
      timeoutMs: 30_000,
      target: 'hermes',
    });
    expect(step.tool.textRedacted).toBeUndefined();

    await fs.rm(path.join(knowledgeRoot, sessionId, 'steps'), {
      recursive: true,
    });
    send.mockResolvedValueOnce({ result: { value: mnemonic } });
    const response = await execute('clipboard', { action: 'read' });
    expect(response.body).toMatchObject({
      ok: true,
      result: { text: mnemonic },
    });
    const readStep = await readRecordedStep('clipboard', []);
    expect(readStep.tool.input).toStrictEqual({ action: 'read' });
    expect(readStep.tool.textRedacted).toBeUndefined();
    expect(readStep.outcome).toStrictEqual({ ok: true });
  });

  it('scrubs nested error details, targets, and artifact paths without mutating the supplied record', async () => {
    const input = { method: 'Input.insertText', params: { text: password } };
    const outcome = {
      ok: false,
      error: {
        code: 'MM_CDP_FAILED',
        message: `echo ${password}`,
        details: { nested: [{ echo: password, [password]: 'diagnostic' }] },
      },
    };
    const target = { selector: `[value=${JSON.stringify(password)}]` };
    const observation = {
      state: { currentScreen: 'onboarding' },
      testIds: [],
      a11y: { nodes: [] },
    } as unknown as StepRecord['observation'];
    const original = structuredClone({ input, outcome, target, observation });
    await store.recordStep({
      sessionId,
      toolName: 'cdp',
      input,
      outcome,
      target,
      observation,
      context: 'prod',
      durationMs: 5,
      screenshotPath: `/synthetic/${password}.png`,
    });

    const step = await readRecordedStep('cdp', [password]);
    expect(step.outcome.error?.details).toStrictEqual({
      nested: [{ echo: '[REDACTED]', '[REDACTED]': 'diagnostic' }],
    });
    expect(step.artifacts?.screenshot?.path).toBe('/synthetic/[REDACTED].png');
    expect({ input, outcome, target, observation }).toStrictEqual(original);
  });
});
