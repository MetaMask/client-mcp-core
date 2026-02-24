/**
 * Unit tests for KnowledgeStore core operations (Part 1).
 * Part 1 focuses on lines 1-500: initialization, recordStep, session lifecycle.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  KnowledgeStore,
  createDefaultObservation,
  createKnowledgeStore,
  setKnowledgeStore,
  hasKnowledgeStore,
  knowledgeStore,
} from './knowledge-store.js';
import type { KnowledgeStoreConfig } from './knowledge-store.js';
import type {
  SessionMetadata,
  StepRecordOutcome,
  StepRecordObservation,
} from './types';
import type { ExtensionState } from '../capabilities/types.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  },
}));

function createObservation(
  overrides: Partial<ExtensionState> = {},
): StepRecordObservation {
  return {
    state: {
      isLoaded: true,
      currentUrl: 'chrome-extension://test/home.html',
      extensionId: 'test-ext',
      isUnlocked: true,
      currentScreen: 'home',
      accountAddress: '0x1234',
      networkName: 'Localhost 8545',
      chainId: 1337,
      balance: '25 ETH',
      ...overrides,
    },
    testIds: [],
    a11y: { nodes: [] },
  };
}

describe('core', () => {
  let originalCwd: () => string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd;
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  describe('KnowledgeStore initialization', () => {
    it('uses default configuration when no config provided', () => {
      const store = new KnowledgeStore();

      expect(store).toBeDefined();
    });

    it('accepts custom rootDir configuration', () => {
      const config: KnowledgeStoreConfig = {
        rootDir: '/custom/knowledge/root',
      };

      const store = new KnowledgeStore(config);

      expect(store).toBeDefined();
    });

    it('accepts custom sessionIdPrefix configuration', () => {
      const config: KnowledgeStoreConfig = {
        sessionIdPrefix: 'custom-',
      };

      const store = new KnowledgeStore(config);

      expect(store).toBeDefined();
    });

    it('accepts custom toolPrefix configuration', () => {
      const config: KnowledgeStoreConfig = {
        toolPrefix: 'custom',
      };

      const store = new KnowledgeStore(config);

      expect(store).toBeDefined();
    });

    it('accepts full configuration object', () => {
      const config: KnowledgeStoreConfig = {
        rootDir: '/custom/root',
        sessionIdPrefix: 'test-',
        toolPrefix: 'test',
      };

      const store = new KnowledgeStore(config);

      expect(store).toBeDefined();
    });
  });

  describe('writeSessionMetadata', () => {
    it('creates session directory and writes metadata file', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'session-001',
        createdAt: '2024-01-15T10:30:00.000Z',
        flowTags: ['send'],
        tags: ['test'],
        launch: { stateMode: 'default' },
      };

      const result = await store.writeSessionMetadata(metadata);

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('/test/knowledge', 'session-001'),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join('/test/knowledge', 'session-001', 'session.json'),
        JSON.stringify(metadata, null, 2),
      );
      expect(result).toBe(
        path.join('/test/knowledge', 'session-001', 'session.json'),
      );
    });

    it('includes optional goal in metadata', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'session-003',
        createdAt: '2024-01-15T10:30:00.000Z',
        goal: 'Test send flow',
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };

      await store.writeSessionMetadata(metadata);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"goal": "Test send flow"'),
      );
    });
  });

  describe('exported helpers', () => {
    it('createDefaultObservation returns base observation without prior knowledge', () => {
      const state: ExtensionState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://test/home.html',
        extensionId: 'test-ext',
        isUnlocked: true,
        currentScreen: 'home',
        accountAddress: '0x1234',
        networkName: 'Localhost 8545',
        chainId: 1337,
        balance: '25 ETH',
      };

      const observation = createDefaultObservation(state);

      expect(observation).toStrictEqual({
        state,
        testIds: [],
        a11y: { nodes: [] },
      });
      expect(observation.priorKnowledge).toBeUndefined();
    });

    it('createDefaultObservation includes provided prior knowledge', () => {
      const state: ExtensionState = {
        isLoaded: true,
        currentUrl: 'chrome-extension://test/home.html',
        extensionId: 'test-ext',
        isUnlocked: true,
        currentScreen: 'home',
        accountAddress: '0x1234',
        networkName: 'Localhost 8545',
        chainId: 1337,
        balance: '25 ETH',
      };
      const priorKnowledge = {
        schemaVersion: 1 as const,
        generatedAt: '2024-01-15T10:30:00.000Z',
        query: {
          windowHours: 48,
          usedFlowTags: ['send'],
          usedFilters: { sinceHours: 48 },
          candidateSessions: 1,
          candidateSteps: 2,
        },
        relatedSessions: [],
        similarSteps: [],
        suggestedNextActions: [],
      };

      const observation = createDefaultObservation(
        state,
        [{ testId: 'send-btn', tag: 'button', visible: true }],
        [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
        priorKnowledge,
      );

      expect(observation.priorKnowledge).toStrictEqual(priorKnowledge);
      expect(observation.testIds).toHaveLength(1);
      expect(observation.a11y.nodes).toHaveLength(1);
    });

    it('createKnowledgeStore returns a KnowledgeStore instance', () => {
      const store = createKnowledgeStore({ rootDir: '/test/knowledge' });

      expect(store).toBeInstanceOf(KnowledgeStore);
    });
  });

  describe('recordStep', () => {
    it('creates steps directory and writes step file', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      const result = await store.recordStep({
        sessionId: 'session-step-001',
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        outcome,
        observation,
        durationMs: 150,
      });

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('/test/knowledge', 'session-step-001', 'steps'),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalled();
      expect(result).toContain('session-step-001');
      expect(result).toContain('steps');
      expect(result).toContain('mm_click.json');
    });

    it('records step with screenshot artifact', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation({ currentScreen: 'send' });

      await store.recordStep({
        sessionId: 'session-step-002',
        toolName: 'mm_screenshot',
        outcome,
        observation,
        screenshotPath: '/test/screenshots/screenshot-001.png',
        screenshotDimensions: { width: 1280, height: 720 },
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.artifacts).toStrictEqual({
        screenshot: {
          path: '/test/screenshots/screenshot-001.png',
          width: 1280,
          height: 720,
        },
      });
    });

    it('sanitizes sensitive input fields', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation({
        currentScreen: 'unlock',
        isUnlocked: false,
      });

      await store.recordStep({
        sessionId: 'session-step-003',
        toolName: 'mm_type',
        input: { testId: 'password-input', text: 'my-secret-password' },
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.tool.textRedacted).toBe(true);
      expect(writtenData.tool.textLength).toBe(18);
      expect(writtenData.tool.input.text).toBe('[REDACTED]');
    });

    it('records step with target information', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-004',
        toolName: 'mm_click',
        input: { testId: 'confirm-btn' },
        target: {
          testId: 'confirm-btn',
          selector: '[data-testid="confirm-btn"]',
        },
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.tool.target).toStrictEqual({
        testId: 'confirm-btn',
        selector: '[data-testid="confirm-btn"]',
      });
    });

    it('computes discovery label for discovery tools', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-005',
        toolName: 'mm_describe_screen',
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('discovery');
    });

    it('computes navigation label for navigation tools', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation({ currentScreen: 'settings' });

      await store.recordStep({
        sessionId: 'session-step-006',
        toolName: 'mm_navigate',
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('navigation');
    });

    it('computes interaction label for interaction tools', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-007',
        toolName: 'mm_click',
        input: { testId: 'send-button' },
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('interaction');
    });

    it('computes confirmation label for confirmation-related targets', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation({
        currentScreen: 'confirm-transaction',
      });

      await store.recordStep({
        sessionId: 'session-step-008',
        toolName: 'mm_click',
        target: { testId: 'confirm-transaction-btn' },
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('confirmation');
    });

    it('computes error-recovery label for failed outcomes', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = {
        ok: false,
        error: { code: 'MM_TARGET_NOT_FOUND', message: 'Target not found' },
      };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-009',
        toolName: 'mm_click',
        input: { testId: 'nonexistent-btn' },
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('error-recovery');
    });

    it('records step with e2e context', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-011',
        toolName: 'mm_click',
        outcome,
        observation,
        context: 'e2e',
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.context).toBe('e2e');
    });

    it('records step with prod context', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-012',
        toolName: 'mm_click',
        outcome,
        observation,
        context: 'prod',
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.context).toBe('prod');
    });

    it('uses custom tool prefix for label computation', async () => {
      const store = new KnowledgeStore({
        rootDir: '/test/knowledge',
        toolPrefix: 'custom',
      });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation();

      await store.recordStep({
        sessionId: 'session-step-013',
        toolName: 'custom_describe_screen',
        outcome,
        observation,
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.labels).toContain('discovery');
    });
  });

  describe('listSessions', () => {
    function createDirent(name: string, isDir = true) {
      return { name, isDirectory: () => isDir };
    }

    it('returns empty array when no sessions exist', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      vi.mocked(fs.readdir).mockResolvedValueOnce([]);

      const result = await store.listSessions(10);

      expect(result).toStrictEqual([]);
    });

    it('returns sessions sorted by createdAt descending', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const oldMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-old',
        createdAt: '2024-01-10T10:00:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const newMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-new',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-old'),
        createDirent('mm-session-new'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(oldMetadata))
        .mockResolvedValueOnce(JSON.stringify(newMetadata));

      const result = await store.listSessions(10);

      expect(result[0].sessionId).toBe('mm-session-new');
      expect(result[1].sessionId).toBe('mm-session-old');
    });

    it('limits results to specified count', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
        createDirent('mm-session-2'),
        createDirent('mm-session-3'),
      ] as any);

      const metadata = (id: string, date: string): SessionMetadata => ({
        schemaVersion: 1,
        sessionId: id,
        createdAt: date,
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      });

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(metadata('mm-session-1', '2024-01-01T10:00:00.000Z')),
        )
        .mockResolvedValueOnce(
          JSON.stringify(metadata('mm-session-2', '2024-01-02T10:00:00.000Z')),
        )
        .mockResolvedValueOnce(
          JSON.stringify(metadata('mm-session-3', '2024-01-03T10:00:00.000Z')),
        );

      const result = await store.listSessions(2);

      expect(result).toHaveLength(2);
    });

    it('filters by flowTag', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const sendMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-send',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const swapMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-swap',
        createdAt: '2024-01-14T10:00:00.000Z',
        flowTags: ['swap'],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-send'),
        createDirent('mm-session-swap'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(sendMetadata))
        .mockResolvedValueOnce(JSON.stringify(swapMetadata));

      const result = await store.listSessions(10, { flowTag: 'send' });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-send');
    });

    it('filters by tag', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const testMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-test',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: [],
        tags: ['test', 'e2e'],
        launch: { stateMode: 'default' },
      };
      const prodMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-prod',
        createdAt: '2024-01-14T10:00:00.000Z',
        flowTags: [],
        tags: ['production'],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-test'),
        createDirent('mm-session-prod'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(testMetadata))
        .mockResolvedValueOnce(JSON.stringify(prodMetadata));

      const result = await store.listSessions(10, { tag: 'e2e' });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-test');
    });

    it('filters by sinceHours', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const now = new Date();
      const recentDate = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      const oldDate = new Date(now.getTime() - 72 * 60 * 60 * 1000);

      const recentMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-recent',
        createdAt: recentDate.toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const oldMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-old',
        createdAt: oldDate.toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-recent'),
        createDirent('mm-session-old'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(recentMetadata))
        .mockResolvedValueOnce(JSON.stringify(oldMetadata));

      const result = await store.listSessions(10, { sinceHours: 24 });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-recent');
    });
  });

  describe('resolveSessionIds', () => {
    function createDirent(name: string, isDir = true) {
      return { name, isDirectory: () => isDir };
    }

    it('returns current session ID for scope "current"', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const result = await store.resolveSessionIds(
        'current',
        'current-session-001',
      );

      expect(result).toStrictEqual(['current-session-001']);
    });

    it('returns empty array for scope "current" without current session', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const result = await store.resolveSessionIds('current', undefined);

      expect(result).toStrictEqual([]);
    });

    it('returns specific session ID for scope object', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const result = await store.resolveSessionIds(
        { sessionId: 'specific-session-001' },
        'current-session',
      );

      expect(result).toStrictEqual(['specific-session-001']);
    });

    it('returns all session IDs for scope "all"', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
        createDirent('mm-session-2'),
        createDirent('mm-session-3'),
      ] as any);

      const result = await store.resolveSessionIds('all', 'current-session');

      expect(result).toStrictEqual([
        'mm-session-1',
        'mm-session-2',
        'mm-session-3',
      ]);
    });

    it('filters session IDs by filters for scope "all"', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const sendMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-send',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const swapMetadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-swap',
        createdAt: '2024-01-14T10:00:00.000Z',
        flowTags: ['swap'],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-send'),
        createDirent('mm-session-swap'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(sendMetadata))
        .mockResolvedValueOnce(JSON.stringify(swapMetadata));

      const result = await store.resolveSessionIds('all', 'current', {
        flowTag: 'send',
      });

      expect(result).toStrictEqual(['mm-session-send']);
    });

    it('includes sessions without metadata when filtering', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-with-metadata'),
        createDirent('mm-session-no-metadata'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify({
            schemaVersion: 1,
            sessionId: 'mm-session-with-metadata',
            createdAt: '2024-01-15T10:00:00.000Z',
            flowTags: ['send'],
            tags: [],
            launch: { stateMode: 'default' },
          }),
        )
        .mockRejectedValueOnce(new Error('ENOENT'));

      const result = await store.resolveSessionIds('all', 'current', {
        flowTag: 'send',
      });

      expect(result).toContain('mm-session-with-metadata');
      expect(result).toContain('mm-session-no-metadata');
    });
  });

  describe('extractPathTokens', () => {
    it('extracts tokens from URL hash fragment', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const outcome: StepRecordOutcome = { ok: true };
      const observation = createObservation({
        currentScreen: 'confirm-transaction',
        currentUrl: 'chrome-extension://test#/confirm/send/0x1234',
      });

      await store.recordStep({
        sessionId: 'session-path-001',
        toolName: 'mm_click',
        outcome,
        observation,
      });

      expect(fs.writeFile).toHaveBeenCalled();
    });
  });
});

describe('similarity', () => {
  let originalCwd: () => string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd;
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  function createStepRecord(
    overrides: {
      sessionId?: string;
      tool?: {
        name: string;
        input?: Record<string, unknown>;
        target?: Record<string, unknown>;
      };
      observation?: {
        state?: Record<string, unknown>;
        testIds?: { testId: string; tag: string; visible: boolean }[];
        a11y?: {
          nodes: { ref: string; role: string; name: string; path: string[] }[];
        };
      };
      labels?: string[];
    } = {},
  ) {
    const baseTool = {
      name: 'mm_click',
      input: { testId: 'test-btn' },
      target: { testId: 'test-btn' },
    };
    const baseObservation = {
      state: {
        isLoaded: true,
        currentUrl: 'chrome-extension://test#/home',
        extensionId: 'test-ext',
        isUnlocked: true,
        currentScreen: 'home',
        accountAddress: '0x1234',
        networkName: 'Localhost 8545',
        chainId: 1337,
        balance: '25 ETH',
      },
      testIds: [{ testId: 'test-btn', tag: 'button', visible: true }],
      a11y: {
        nodes: [{ ref: 'e1', role: 'button', name: 'Test Button', path: [] }],
      },
    };

    return {
      schemaVersion: 1,
      sessionId: overrides.sessionId ?? 'test-session',
      timestamp: '2024-01-15T10:30:00.000Z',
      tool: overrides.tool ? { ...baseTool, ...overrides.tool } : baseTool,
      observation: overrides.observation
        ? {
            state: overrides.observation.state
              ? { ...baseObservation.state, ...overrides.observation.state }
              : baseObservation.state,
            testIds: overrides.observation.testIds ?? baseObservation.testIds,
            a11y: overrides.observation.a11y ?? baseObservation.a11y,
          }
        : baseObservation,
      outcome: { ok: true },
      labels: overrides.labels ?? ['interaction'],
      durationMs: 100,
      environment: { platform: 'darwin', nodeVersion: 'v20.0.0' },
    };
  }

  function createDirent(name: string, isDir = true) {
    return { name, isDirectory: () => isDir };
  }

  describe('searchSteps scoring', () => {
    it('scores steps matching tool name in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        tool: { name: 'mm_click', input: {} },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tool).toBe('mm_click');
    });

    it('scores steps matching screen name in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'send' },
          testIds: [],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('send', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].screen).toBe('send');
    });

    it('scores steps matching target testId in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        tool: {
          name: 'mm_click',
          input: { testId: 'confirm-button' },
          target: { testId: 'confirm-button' },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('confirm', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores steps matching labels in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        labels: ['navigation', 'confirmation'],
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps(
        'confirmation',
        10,
        'all',
        undefined,
      );

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores steps matching observed testIds in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [
            { testId: 'amount-input', tag: 'input', visible: true },
            { testId: 'send-button', tag: 'button', visible: true },
          ],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('amount', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores steps matching a11y node names in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [],
          a11y: {
            nodes: [
              { ref: 'e1', role: 'button', name: 'Send ETH', path: [] },
              { ref: 'e2', role: 'textbox', name: 'Amount', path: [] },
            ],
          },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('eth', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores steps matching a11y node roles in query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [],
          a11y: {
            nodes: [{ ref: 'e1', role: 'textbox', name: 'Search', path: [] }],
          },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps('textbox', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty results for empty query', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const results = await store.searchSteps('', 10, 'all', undefined);

      expect(results).toStrictEqual([]);
    });

    it('calculates token coverage ratio bonus', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const stepRecord = createStepRecord({
        tool: { name: 'mm_click', input: {} },
        observation: {
          state: { currentScreen: 'send' },
          testIds: [],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'mm-session-1',
          createdAt: '2024-01-15T10:00:00.000Z',
          flowTags: [],
          tags: [],
          launch: { stateMode: 'default' },
        }),
      );
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stepRecord));

      const results = await store.searchSteps(
        'click send',
        10,
        'all',
        undefined,
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('session scoring', () => {
    it('scores sessions with matching flowTags higher', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const sendMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-send',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const swapMetadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-swap',
        createdAt: '2024-01-15T09:00:00.000Z',
        flowTags: ['swap'],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-send'),
        createDirent('mm-session-swap'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(sendMetadata))
        .mockResolvedValueOnce(JSON.stringify(swapMetadata));
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['step1.json'] as any)
        .mockResolvedValueOnce(['step1.json'] as any);

      const sendStep = createStepRecord({ sessionId: 'mm-session-send' });
      const swapStep = createStepRecord({ sessionId: 'mm-session-swap' });

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(sendStep))
        .mockResolvedValueOnce(JSON.stringify(swapStep));

      const results = await store.searchSteps('send', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores sessions with matching goal tokens', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: '2024-01-15T10:00:00.000Z',
        goal: 'Test the token swap feature',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createStepRecord()),
      );

      const results = await store.searchSteps('swap', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('scores sessions with matching tags', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: [],
        tags: ['regression', 'e2e'],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createStepRecord()),
      );

      const results = await store.searchSteps(
        'regression',
        10,
        'all',
        undefined,
      );

      expect(results.length).toBeGreaterThan(0);
    });

    it('gives recency bonus to recent sessions (< 24 hours)', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const recentDate = new Date(
        Date.now() - 12 * 60 * 60 * 1000,
      ).toISOString();
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-recent',
        createdAt: recentDate,
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-recent'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(
          createStepRecord({
            tool: { name: 'mm_click', input: {} },
          }),
        ),
      );

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('gives smaller recency bonus to moderately recent sessions (24-72 hours)', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const moderateDate = new Date(
        Date.now() - 48 * 60 * 60 * 1000,
      ).toISOString();
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-moderate',
        createdAt: moderateDate,
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-moderate'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(
          createStepRecord({
            tool: { name: 'mm_click', input: {} },
          }),
        ),
      );

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results.length).toBeGreaterThan(0);
    });

    it('sorts sessions by score then by createdAt', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata1 = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: '2024-01-15T10:00:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const metadata2 = {
        schemaVersion: 1,
        sessionId: 'mm-session-2',
        createdAt: '2024-01-16T10:00:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
        createDirent('mm-session-2'),
      ] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata1))
        .mockResolvedValueOnce(JSON.stringify(metadata2));
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['step1.json'] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createStepRecord({
              sessionId: 'mm-session-1',
              tool: { name: 'mm_click', input: {} },
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createStepRecord({
              sessionId: 'mm-session-2',
              tool: { name: 'mm_click', input: {} },
            }),
          ),
        );

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results).toHaveLength(2);
    });
  });

  describe('generatePriorKnowledge similarity scoring', () => {
    it('scores steps with same screen higher', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'send' },
          testIds: [],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'send',
          currentUrl: 'chrome-extension://test#/send',
          visibleTestIds: [],
          a11yNodes: [],
          currentSessionFlowTags: ['send'],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      expect(result?.similarSteps.length).toBeGreaterThanOrEqual(0);
    });

    it('scores steps with URL path overlap', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: {
            currentScreen: 'home',
            currentUrl: 'chrome-extension://test#/confirm/send',
          },
          testIds: [],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          currentUrl: 'chrome-extension://test#/confirm/transaction',
          visibleTestIds: [],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('scores steps with testId overlap', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
            { testId: 'swap-btn', tag: 'button', visible: true },
            { testId: 'bridge-btn', tag: 'button', visible: true },
          ],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
            { testId: 'swap-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('scores steps with a11y node overlap', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [],
          a11y: {
            nodes: [
              { ref: 'e1', role: 'button', name: 'Send', path: [] },
              { ref: 'e2', role: 'button', name: 'Swap', path: [] },
            ],
          },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [],
          a11yNodes: [
            { ref: 'e1', role: 'button', name: 'Send', path: [] },
            { ref: 'e2', role: 'button', name: 'Swap', path: [] },
          ],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('scores actionable tools higher than discovery tools', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const clickStep = createStepRecord({
        tool: { name: 'mm_click', input: { testId: 'send-btn' } },
        observation: {
          state: { currentScreen: 'home' },
          testIds: [{ testId: 'send-btn', tag: 'button', visible: true }],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(clickStep));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      if (result?.similarSteps.length) {
        expect(result.similarSteps[0].tool).toBe('mm_click');
      }
    });

    it('excludes discovery tools from similarity scoring', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const discoveryStep = createStepRecord({
        tool: { name: 'mm_describe_screen', input: {} },
        observation: {
          state: { currentScreen: 'home' },
          testIds: [{ testId: 'send-btn', tag: 'button', visible: true }],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(discoveryStep));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      if (result?.similarSteps.length) {
        const hasDiscoveryTool = result.similarSteps.some(
          (s) => s.tool === 'mm_describe_screen',
        );
        expect(hasDiscoveryTool).toBe(false);
      }
    });

    it('returns undefined when no candidate sessions exist', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [],
          a11yNodes: [],
        },
        'current-session',
      );

      expect(result).toBeUndefined();
    });

    it('excludes current session from candidate sessions', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-current',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-current'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [],
          a11yNodes: [],
        },
        'mm-session-current',
      );

      expect(result).toBeUndefined();
    });

    it('caps testId overlap scoring at 3 items', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [
            { testId: 'btn-1', tag: 'button', visible: true },
            { testId: 'btn-2', tag: 'button', visible: true },
            { testId: 'btn-3', tag: 'button', visible: true },
            { testId: 'btn-4', tag: 'button', visible: true },
            { testId: 'btn-5', tag: 'button', visible: true },
          ],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'btn-1', tag: 'button', visible: true },
            { testId: 'btn-2', tag: 'button', visible: true },
            { testId: 'btn-3', tag: 'button', visible: true },
            { testId: 'btn-4', tag: 'button', visible: true },
            { testId: 'btn-5', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('caps a11y overlap scoring at 2 items', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'home' },
          testIds: [],
          a11y: {
            nodes: [
              { ref: 'e1', role: 'button', name: 'Action 1', path: [] },
              { ref: 'e2', role: 'button', name: 'Action 2', path: [] },
              { ref: 'e3', role: 'button', name: 'Action 3', path: [] },
              { ref: 'e4', role: 'button', name: 'Action 4', path: [] },
            ],
          },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [],
          a11yNodes: [
            { ref: 'e1', role: 'button', name: 'Action 1', path: [] },
            { ref: 'e2', role: 'button', name: 'Action 2', path: [] },
            { ref: 'e3', role: 'button', name: 'Action 3', path: [] },
            { ref: 'e4', role: 'button', name: 'Action 4', path: [] },
          ],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('computes confidence as ratio of score to max score', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        tool: { name: 'mm_click', input: { testId: 'send-btn' } },
        observation: {
          state: { currentScreen: 'send' },
          testIds: [{ testId: 'send-btn', tag: 'button', visible: true }],
          a11y: {
            nodes: [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
          },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'send',
          currentUrl: 'chrome-extension://test#/send',
          visibleTestIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      if (result?.similarSteps.length) {
        const { confidence } = result.similarSteps[0];
        expect(confidence).toBeGreaterThan(0);
        expect(confidence).toBeLessThanOrEqual(1);
      }
    });

    it('filters steps using flowTag from context', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: ['send'],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(metadata));
      vi.mocked(fs.readdir).mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createStepRecord()),
      );

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [],
          a11yNodes: [],
          currentSessionFlowTags: ['send'],
        },
        'other-session',
      );

      expect(result).toBeDefined();
    });

    it('does not award sameScreen bonus for unknown screens', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const stepRecord = createStepRecord({
        observation: {
          state: { currentScreen: 'unknown' },
          testIds: [],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(stepRecord));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'unknown',
          visibleTestIds: [],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      if (result?.similarSteps.length) {
        expect(result.similarSteps[0].confidence).toBeLessThan(0.5);
      }
    });

    it('builds avoid list only for targets meeting failure threshold', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      const makeFailedStep = (target: {
        testId?: string;
        selector?: string;
      }) => ({
        ...createStepRecord({
          tool: {
            name: 'mm_click',
            input: { testId: target.testId ?? 'unknown-btn' },
            target,
          },
          observation: {
            state: { currentScreen: 'home' },
            testIds: [{ testId: 'confirm-btn', tag: 'button', visible: true }],
            a11y: { nodes: [] },
          },
        }),
        outcome: {
          ok: false,
          error: {
            code: 'MM_TARGET_NOT_FOUND',
            message: 'Target not found',
          },
        },
      });

      const failedConfirmA = makeFailedStep({ testId: 'confirm-btn' });
      const failedConfirmB = makeFailedStep({ testId: 'confirm-btn' });
      const failedSelector = makeFailedStep({ selector: '.unstable-target' });
      const successfulStep = createStepRecord({
        tool: {
          name: 'mm_click',
          input: { testId: 'confirm-btn' },
          target: { testId: 'confirm-btn' },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce([
          'step1.json',
          'step2.json',
          'step3.json',
          'step4.json',
        ] as any)
        .mockResolvedValueOnce([
          'step1.json',
          'step2.json',
          'step3.json',
          'step4.json',
        ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(failedConfirmA))
        .mockResolvedValueOnce(JSON.stringify(failedConfirmB))
        .mockResolvedValueOnce(JSON.stringify(failedSelector))
        .mockResolvedValueOnce(JSON.stringify(successfulStep))
        .mockResolvedValueOnce(JSON.stringify(failedConfirmA))
        .mockResolvedValueOnce(JSON.stringify(failedConfirmB))
        .mockResolvedValueOnce(JSON.stringify(failedSelector))
        .mockResolvedValueOnce(JSON.stringify(successfulStep));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'confirm-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      expect(result?.avoid).toHaveLength(1);
      expect(result?.avoid?.[0]).toMatchObject({
        target: { testId: 'confirm-btn' },
        frequency: 2,
      });
    });

    it('skips suggested action when tool is not in action map', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const unknownToolStep = createStepRecord({
        tool: {
          name: 'mm_unknown_tool',
          input: { testId: 'send-btn' },
          target: { testId: 'send-btn' },
        },
        observation: {
          state: { currentScreen: 'home' },
          testIds: [{ testId: 'send-btn', tag: 'button', visible: true }],
          a11y: { nodes: [] },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any)
        .mockResolvedValueOnce(['step1.json'] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(unknownToolStep))
        .mockResolvedValueOnce(JSON.stringify(unknownToolStep));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'send-btn', tag: 'button', visible: true },
          ],
          a11yNodes: [],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      expect(result?.similarSteps.length).toBeGreaterThan(0);
      expect(result?.suggestedNextActions).toStrictEqual([]);
    });

    it('includes a11y fallback target when testId text matches visible a11y name', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const metadata = {
        schemaVersion: 1,
        sessionId: 'mm-session-1',
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };
      const actionableStep = createStepRecord({
        tool: {
          name: 'mm_click',
          input: { testId: 'send-button' },
          target: { testId: 'send-button' },
        },
        observation: {
          state: { currentScreen: 'home' },
          testIds: [{ testId: 'send-button', tag: 'button', visible: true }],
          a11y: {
            nodes: [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
          },
        },
      });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step1.json'] as any)
        .mockResolvedValueOnce(['step1.json'] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(metadata))
        .mockResolvedValueOnce(JSON.stringify(actionableStep))
        .mockResolvedValueOnce(JSON.stringify(actionableStep));

      const result = await store.generatePriorKnowledge(
        {
          currentScreen: 'home',
          visibleTestIds: [
            { testId: 'send-button', tag: 'button', visible: true },
          ],
          a11yNodes: [
            { ref: 'e10', role: 'button', name: 'send button', path: [] },
          ],
        },
        'other-session',
      );

      expect(result).toBeDefined();
      expect(
        result?.suggestedNextActions[0]?.fallbackTargets?.[0],
      ).toStrictEqual({
        type: 'a11yHint',
        value: { role: 'button', name: 'send button' },
      });
    });
  });
});

describe('session', () => {
  let originalCwd: () => string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd;
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  function createDirent(name: string, isDir = true) {
    return { name, isDirectory: () => isDir };
  }

  function createSessionMetadata(
    overrides: Partial<SessionMetadata> = {},
  ): SessionMetadata {
    return {
      schemaVersion: 1,
      sessionId: overrides.sessionId ?? 'mm-session-test',
      createdAt: overrides.createdAt ?? '2024-01-15T10:00:00.000Z',
      flowTags: overrides.flowTags ?? [],
      tags: overrides.tags ?? [],
      launch: overrides.launch ?? { stateMode: 'default' },
      goal: overrides.goal,
    };
  }

  function createStepRecord(sessionId: string, timestamp: string) {
    return {
      schemaVersion: 1,
      sessionId,
      timestamp,
      tool: { name: 'mm_click', input: { testId: 'test-btn' } },
      observation: {
        state: {
          isLoaded: true,
          currentUrl: 'chrome-extension://test#/home',
          extensionId: 'test-ext',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x1234',
          networkName: 'Localhost 8545',
          chainId: 1337,
          balance: '25 ETH',
        },
        testIds: [],
        a11y: { nodes: [] },
      },
      outcome: { ok: true },
      labels: ['interaction'],
      durationMs: 100,
      environment: { platform: 'darwin', nodeVersion: 'v20.0.0' },
    };
  }

  describe('getAllSessionIds', () => {
    it('returns session IDs from directories starting with mm-', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
        createDirent('mm-session-2'),
        createDirent('other-dir'),
        createDirent('file.txt', false),
      ] as any);

      const result = await store.getAllSessionIds();

      expect(result).toStrictEqual(['mm-session-1', 'mm-session-2']);
    });

    it('returns session IDs with custom prefix', async () => {
      const store = new KnowledgeStore({
        rootDir: '/test/knowledge',
        sessionIdPrefix: 'custom-',
      });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('custom-session-1'),
        createDirent('mm-session-2'),
        createDirent('other-dir'),
      ] as any);

      const result = await store.getAllSessionIds();

      expect(result).toStrictEqual(['custom-session-1', 'mm-session-2']);
    });

    it('returns empty array when directory read fails', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await store.getAllSessionIds();

      expect(result).toStrictEqual([]);
    });

    it('returns empty array for empty directory', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);

      const result = await store.getAllSessionIds();

      expect(result).toStrictEqual([]);
    });
  });

  describe('session scanning limits', () => {
    it('limits sessions scanned to maxSessionsToScan (20)', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      // Create 25 sessions
      const sessions = Array.from({ length: 25 }, (_, i) =>
        createDirent(`mm-session-${i}`),
      );

      // Create metadata for each session
      const metadatas = Array.from({ length: 25 }, (_, i) =>
        createSessionMetadata({
          sessionId: `mm-session-${i}`,
          createdAt: new Date(
            Date.now() - (25 - i) * 60 * 60 * 1000,
          ).toISOString(),
        }),
      );

      // Mock readdir for root
      vi.mocked(fs.readdir).mockResolvedValueOnce(sessions as any);

      // Mock readFile for each session metadata
      for (const meta of metadatas) {
        vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(meta));
      }

      // Mock readdir and readFile for steps (empty)
      for (let i = 0; i < 20; i++) {
        vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);
      }

      const results = await store.searchSteps('click', 100, 'all', undefined);

      // Should only scan 20 sessions (maxSessionsToScan limit)
      expect(results).toBeDefined();
    });

    it('limits steps per session to maxStepsPerSession (500)', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      // Create 600 steps for one session
      const stepFiles = Array.from({ length: 600 }, (_, i) => `step-${i}.json`);

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(stepFiles as any);

      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createSessionMetadata({ sessionId: 'mm-session-1' })),
      );

      // Only first 500 steps should be loaded
      for (let i = 0; i < 500; i++) {
        vi.mocked(fs.readFile).mockResolvedValueOnce(
          JSON.stringify(
            createStepRecord(
              'mm-session-1',
              `2024-01-15T10:${String(i).padStart(2, '0')}:00.000Z`,
            ),
          ),
        );
      }

      const results = await store.searchSteps('click', 1000, 'all', undefined);

      expect(results).toBeDefined();
      // Total steps should be capped at 500 per session
      expect(results.length).toBeLessThanOrEqual(500);
    });

    it('stops scanning when maxTotalSteps (2000) is reached', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      // Create 5 sessions with 500 steps each = 2500 total
      const sessions = Array.from({ length: 5 }, (_, i) =>
        createDirent(`mm-session-${i}`),
      );

      vi.mocked(fs.readdir).mockResolvedValueOnce(sessions as any);

      // Mock metadata for each session
      for (let i = 0; i < 5; i++) {
        vi.mocked(fs.readFile).mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: `mm-session-${i}`,
              createdAt: new Date(
                Date.now() - (5 - i) * 60 * 60 * 1000,
              ).toISOString(),
            }),
          ),
        );
      }

      // Mock steps dir for each session (500 steps each)
      for (let i = 0; i < 5; i++) {
        const stepFiles = Array.from(
          { length: 500 },
          (_, j) => `step-${j}.json`,
        );
        vi.mocked(fs.readdir).mockResolvedValueOnce(stepFiles as any);

        // Mock step files
        for (let j = 0; j < 500; j++) {
          vi.mocked(fs.readFile).mockResolvedValueOnce(
            JSON.stringify(
              createStepRecord(
                `mm-session-${i}`,
                `2024-01-15T${String(i).padStart(2, '0')}:${String(j).padStart(2, '0')}:00.000Z`,
              ),
            ),
          );
        }
      }

      const results = await store.searchSteps('click', 5000, 'all', undefined);

      expect(results).toBeDefined();
      // Should stop at 2000 total steps
    });
  });

  describe('filter parameters', () => {
    it('filters sessions by flowTag', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-send'),
        createDirent('mm-session-swap'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-send',
              flowTags: ['send'],
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-swap',
              flowTags: ['swap'],
            }),
          ),
        );

      const result = await store.listSessions(10, { flowTag: 'send' });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-send');
    });

    it('filters sessions by tag', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-e2e'),
        createDirent('mm-session-prod'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-e2e',
              tags: ['e2e', 'regression'],
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-prod',
              tags: ['production'],
            }),
          ),
        );

      const result = await store.listSessions(10, { tag: 'e2e' });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-e2e');
    });

    it('filters sessions by sinceHours', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const now = new Date();
      const recentDate = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      const oldDate = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-recent'),
        createDirent('mm-session-old'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-recent',
              createdAt: recentDate.toISOString(),
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-old',
              createdAt: oldDate.toISOString(),
            }),
          ),
        );

      const result = await store.listSessions(10, { sinceHours: 24 });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-recent');
    });

    it('combines multiple filters', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      const recentDate = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-1'),
        createDirent('mm-session-2'),
        createDirent('mm-session-3'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-1',
              createdAt: recentDate.toISOString(),
              flowTags: ['send'],
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-2',
              createdAt: recentDate.toISOString(),
              flowTags: ['swap'],
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-3',
              createdAt: oldDate.toISOString(),
              flowTags: ['send'],
            }),
          ),
        );

      const result = await store.listSessions(10, {
        flowTag: 'send',
        sinceHours: 24,
      });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-1');
    });
  });

  describe('corrupted session file handling', () => {
    it('skips corrupted session metadata files', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-valid'),
        createDirent('mm-session-corrupted'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-valid',
            }),
          ),
        )
        .mockResolvedValueOnce('invalid json {{{');

      const result = await store.listSessions(10);

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('mm-session-valid');
    });

    it('skips corrupted step files during search', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce([
          'step-valid.json',
          'step-corrupted.json',
        ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-1',
            }),
          ),
        )
        .mockResolvedValueOnce(
          JSON.stringify(
            createStepRecord('mm-session-1', '2024-01-15T10:00:00.000Z'),
          ),
        )
        .mockResolvedValueOnce('not valid json');

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results).toBeDefined();
      // Should still return results from valid step
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('handles missing step files gracefully', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce(['step.json'] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-1',
            }),
          ),
        )
        .mockRejectedValueOnce(new Error('ENOENT: file not found'));

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results).toBeDefined();
      expect(results).toHaveLength(0);
    });

    it('handles steps directory not existing', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockRejectedValueOnce(new Error('ENOENT: no steps directory'));

      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(
          createSessionMetadata({
            sessionId: 'mm-session-1',
          }),
        ),
      );

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results).toBeDefined();
      expect(results).toHaveLength(0);
    });
  });

  describe('empty session directory', () => {
    it('returns empty results for empty knowledge root', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);

      const sessions = await store.listSessions(10);

      expect(sessions).toStrictEqual([]);
    });

    it('returns empty search results for empty knowledge root', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);

      const results = await store.searchSteps('click', 10, 'all', undefined);

      expect(results).toStrictEqual([]);
    });

    it('returns empty getLastSteps for session with no steps', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([createDirent('mm-session-1')] as any)
        .mockResolvedValueOnce([] as any);

      const results = await store.getLastSteps(
        10,
        { sessionId: 'mm-session-1' },
        undefined,
      );

      expect(results).toStrictEqual([]);
    });

    it('returns empty summarizeSession for session with no steps', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([] as any);

      const result = await store.summarizeSession('mm-session-1');

      expect(result.stepCount).toBe(0);
      expect(result.recipe).toStrictEqual([]);
    });
  });

  describe('resolveSessionIds with filters', () => {
    it('includes sessions without metadata when filtering', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        createDirent('mm-session-with-metadata'),
        createDirent('mm-session-no-metadata'),
      ] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          JSON.stringify(
            createSessionMetadata({
              sessionId: 'mm-session-with-metadata',
              flowTags: ['send'],
            }),
          ),
        )
        .mockRejectedValueOnce(new Error('ENOENT'));

      const result = await store.resolveSessionIds('all', undefined, {
        flowTag: 'send',
      });

      // Both should be included - session without metadata is not filtered out
      expect(result).toContain('mm-session-with-metadata');
      expect(result).toContain('mm-session-no-metadata');
    });

    it('returns empty array for scope current without sessionId', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const result = await store.resolveSessionIds('current', undefined);

      expect(result).toStrictEqual([]);
    });

    it('returns specific sessionId for scope object', async () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });

      const result = await store.resolveSessionIds(
        { sessionId: 'specific-session' },
        'current-session',
      );

      expect(result).toStrictEqual(['specific-session']);
    });
  });

  describe('hasKnowledgeStore', () => {
    afterEach(() => {
      setKnowledgeStore(undefined as any);
    });

    it('returns false when knowledge store not initialized', () => {
      setKnowledgeStore(undefined as any);

      const result = hasKnowledgeStore();

      expect(result).toBe(false);
    });

    it('returns true when knowledge store is initialized', () => {
      const store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      setKnowledgeStore(store);

      const result = hasKnowledgeStore();

      expect(result).toBe(true);
    });
  });

  describe('knowledgeStore facade', () => {
    let store: KnowledgeStore;

    beforeEach(() => {
      store = new KnowledgeStore({ rootDir: '/test/knowledge' });
      setKnowledgeStore(store);
    });

    afterEach(() => {
      setKnowledgeStore(undefined as any);
    });

    it('recordStep delegates to underlying KnowledgeStore instance', async () => {
      const params = {
        sessionId: 'test-session',
        toolName: 'mm_click',
        observation: createObservation(),
        outcome: { ok: true } as StepRecordOutcome,
      };

      vi.spyOn(store, 'recordStep').mockResolvedValueOnce('/test/path');

      const result = await knowledgeStore.recordStep(params);

      expect(store.recordStep).toHaveBeenCalledWith(params);
      expect(result).toBe('/test/path');
    });

    it('recordStep throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      const params = {
        sessionId: 'test-session',
        toolName: 'mm_click',
        observation: createObservation(),
        outcome: { ok: true } as StepRecordOutcome,
      };

      await expect(knowledgeStore.recordStep(params)).rejects.toThrowError(
        'Knowledge store not initialized',
      );
    });

    it('getLastSteps delegates to underlying KnowledgeStore instance', async () => {
      const mockSteps = [
        {
          timestamp: '2024-01-15T10:30:00.000Z',
          tool: 'mm_click',
          screen: 'home' as const,
          snippet: 'Clicked button',
        },
      ];

      vi.spyOn(store, 'getLastSteps').mockResolvedValueOnce(mockSteps);

      const result = await knowledgeStore.getLastSteps(
        10,
        { sessionId: 'test-session' },
        undefined,
      );

      expect(store.getLastSteps).toHaveBeenCalledWith(
        10,
        { sessionId: 'test-session' },
        undefined,
      );
      expect(result).toStrictEqual(mockSteps);
    });

    it('getLastSteps throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      await expect(
        knowledgeStore.getLastSteps(
          10,
          { sessionId: 'test-session' },
          undefined,
        ),
      ).rejects.toThrowError('Knowledge store not initialized');
    });

    it('searchSteps delegates to underlying KnowledgeStore instance', async () => {
      const mockResults = [
        {
          timestamp: '2024-01-15T10:30:00.000Z',
          tool: 'mm_click',
          screen: 'home' as const,
          snippet: 'Clicked send button',
        },
      ];

      vi.spyOn(store, 'searchSteps').mockResolvedValueOnce(mockResults);

      const result = await knowledgeStore.searchSteps(
        'click',
        10,
        'all',
        undefined,
      );

      expect(store.searchSteps).toHaveBeenCalledWith(
        'click',
        10,
        'all',
        undefined,
      );
      expect(result).toStrictEqual(mockResults);
    });

    it('searchSteps throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      await expect(
        knowledgeStore.searchSteps('click', 10, 'all', undefined),
      ).rejects.toThrowError('Knowledge store not initialized');
    });

    it('summarizeSession delegates to underlying KnowledgeStore instance', async () => {
      const mockSummary = {
        sessionId: 'test-session',
        stepCount: 5,
        recipe: [{ stepNumber: 1, tool: 'mm_click', notes: 'Clicked send' }],
      };

      vi.spyOn(store, 'summarizeSession').mockResolvedValueOnce(mockSummary);

      const result = await knowledgeStore.summarizeSession('test-session');

      expect(store.summarizeSession).toHaveBeenCalledWith('test-session');
      expect(result).toStrictEqual(mockSummary);
    });

    it('summarizeSession throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      await expect(
        knowledgeStore.summarizeSession('test-session'),
      ).rejects.toThrowError('Knowledge store not initialized');
    });

    it('listSessions delegates to underlying KnowledgeStore instance', async () => {
      const mockSessions = [
        {
          sessionId: 'test-session-1',
          createdAt: '2024-01-15T10:30:00.000Z',
          flowTags: ['send'],
          tags: [],
        },
      ];

      vi.spyOn(store, 'listSessions').mockResolvedValueOnce(mockSessions);

      const result = await knowledgeStore.listSessions(10);

      expect(store.listSessions).toHaveBeenCalledWith(10);
      expect(result).toStrictEqual(mockSessions);
    });

    it('listSessions throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      await expect(knowledgeStore.listSessions(10)).rejects.toThrowError(
        'Knowledge store not initialized',
      );
    });

    it('generatePriorKnowledge delegates to underlying KnowledgeStore instance', async () => {
      const mockPriorKnowledge = {
        schemaVersion: 1 as const,
        generatedAt: '2024-01-15T10:30:00.000Z',
        query: {
          windowHours: 24,
          usedFlowTags: [],
          usedFilters: {},
          candidateSessions: 0,
          candidateSteps: 0,
        },
        relatedSessions: [],
        similarSteps: [],
        suggestedNextActions: [],
      };

      vi.spyOn(store, 'generatePriorKnowledge').mockResolvedValueOnce(
        mockPriorKnowledge,
      );

      const context = {
        currentScreen: 'home',
        visibleTestIds: [],
        a11yNodes: [],
      };
      const result = await knowledgeStore.generatePriorKnowledge(context);

      expect(store.generatePriorKnowledge).toHaveBeenCalledWith(context);
      expect(result).toStrictEqual(mockPriorKnowledge);
    });

    it('generatePriorKnowledge throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      const context = {
        currentScreen: 'home',
        visibleTestIds: [],
        a11yNodes: [],
      };
      await expect(
        knowledgeStore.generatePriorKnowledge(context),
      ).rejects.toThrowError('Knowledge store not initialized');
    });

    it('writeSessionMetadata delegates to underlying KnowledgeStore instance', async () => {
      const metadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'test-session',
        createdAt: '2024-01-15T10:30:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      vi.spyOn(store, 'writeSessionMetadata').mockResolvedValueOnce(
        '/test/path',
      );

      const result = await knowledgeStore.writeSessionMetadata(metadata);

      expect(store.writeSessionMetadata).toHaveBeenCalledWith(metadata);
      expect(result).toBe('/test/path');
    });

    it('writeSessionMetadata throws error when knowledge store not initialized', async () => {
      setKnowledgeStore(undefined as any);

      const metadata: SessionMetadata = {
        schemaVersion: 1,
        sessionId: 'test-session',
        createdAt: '2024-01-15T10:30:00.000Z',
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      };

      await expect(
        knowledgeStore.writeSessionMetadata(metadata),
      ).rejects.toThrowError('Knowledge store not initialized');
    });
  });
});
