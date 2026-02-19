import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startRunner, stopRunner, waitForReady } from './runner-lifecycle.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

const mockSpawn = vi.mocked(spawn);
const mockReaddir = vi.mocked(readdir) as unknown as ReturnType<typeof vi.fn>;
const mockMkdir = vi.mocked(mkdir) as unknown as ReturnType<typeof vi.fn>;
const mockAppendFile = vi.mocked(appendFile) as unknown as ReturnType<
  typeof vi.fn
>;

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = () => true;
  vi.spyOn(proc, 'kill');
  Object.defineProperty(proc, 'pid', { value: 12345, writable: true });
  return proc;
}

function getStdout(proc: ChildProcess): Readable {
  if (!proc.stdout) {
    throw new Error('Expected stdout to be defined');
  }
  return proc.stdout;
}

describe('runner-lifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockAppendFile.mockResolvedValue(undefined);
    await stopRunner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('startRunner', () => {
    it('spawns xcodebuild and resolves with port from stdout', async () => {
      mockReaddir.mockResolvedValue([
        'Test_iphonesimulator17.4-arm64.xctestrun',
      ]);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 5000,
      });

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      getStdout(proc).emit(
        'data',
        Buffer.from('Starting...\nAGENT_DEVICE_RUNNER_PORT=9876\n'),
      );

      const port = await portPromise;

      expect(port).toBe(9876);
      expect(mockSpawn).toHaveBeenCalledWith('xcodebuild', [
        'test-without-building',
        '-xctestrun',
        '/derived/Build/Products/Test_iphonesimulator17.4-arm64.xctestrun',
        '-destination',
        'platform=iOS Simulator,id=AAA-111',
        '-parallel-testing-enabled',
        'NO',
        '-test-timeouts-enabled',
        'NO',
      ]);
    });

    it('rejects when no .xctestrun file found', async () => {
      mockReaddir.mockResolvedValue(['somefile.txt', 'other.json']);

      await expect(
        startRunner({
          derivedDataPath: '/derived',
          destination: 'platform=iOS Simulator,id=AAA-111',
        }),
      ).rejects.toThrowError('No .xctestrun file found');
    });

    it('rejects when process exits before emitting port', async () => {
      mockReaddir.mockResolvedValue(['Test.xctestrun']);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 5000,
      });

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      proc.emit('close', 1);

      await expect(portPromise).rejects.toThrowError(
        'Runner exited with code 1 before emitting port',
      );
    });

    it('rejects when process emits error', async () => {
      mockReaddir.mockResolvedValue(['Test.xctestrun']);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 5000,
      });

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      proc.emit('error', new Error('spawn ENOENT'));

      await expect(portPromise).rejects.toThrowError('spawn ENOENT');
    });

    it('rejects on timeout when port is never emitted', async () => {
      mockReaddir.mockResolvedValue(['Test.xctestrun']);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 200,
      });

      await expect(portPromise).rejects.toThrowError(
        'Runner did not emit port within 200ms',
      );
      expect(proc.kill).toHaveBeenCalled();
    }, 10_000);

    it('ignores stdout data after port is found', async () => {
      mockReaddir.mockResolvedValue(['Test.xctestrun']);
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 5000,
      });

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      getStdout(proc).emit(
        'data',
        Buffer.from('AGENT_DEVICE_RUNNER_PORT=1111\n'),
      );
      getStdout(proc).emit(
        'data',
        Buffer.from('AGENT_DEVICE_RUNNER_PORT=2222\n'),
      );

      const port = await portPromise;

      expect(port).toBe(1111);
    });
  });

  describe('stopRunner', () => {
    it('kills the runner process', async () => {
      mockReaddir.mockResolvedValue(['Test.xctestrun']);
      const proc = createMockProcess();
      Object.defineProperty(proc, 'exitCode', { value: null, writable: true });
      Object.defineProperty(proc, 'signalCode', {
        value: null,
        writable: true,
      });
      vi.mocked(proc.kill).mockImplementationOnce(() => {
        proc.emit('close', 0);
        return true;
      });
      mockSpawn.mockReturnValue(proc);

      const portPromise = startRunner({
        derivedDataPath: '/derived',
        destination: 'platform=iOS Simulator,id=AAA-111',
        timeoutMs: 5000,
      });

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalled();
      });

      getStdout(proc).emit(
        'data',
        Buffer.from('AGENT_DEVICE_RUNNER_PORT=9876\n'),
      );
      await portPromise;

      await stopRunner();

      expect(proc.kill).toHaveBeenCalled();
    });

    it('does nothing when no runner is active', async () => {
      expect(await stopRunner()).toBeUndefined();
    });
  });

  describe('waitForReady', () => {
    it('returns true when health check succeeds immediately', async () => {
      const healthCheck = vi.fn().mockResolvedValue(true);

      const result = await waitForReady(healthCheck, 5000);

      expect(result).toBe(true);
      expect(healthCheck).toHaveBeenCalledOnce();
    });

    it('polls until health check succeeds', async () => {
      const healthCheck = vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await waitForReady(healthCheck, 10_000);

      expect(result).toBe(true);
      expect(healthCheck).toHaveBeenCalledTimes(3);
    });

    it('returns false on timeout', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false);

      const result = await waitForReady(healthCheck, 100);

      expect(result).toBe(false);
    });

    it('handles health check throwing errors', async () => {
      const healthCheck = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(true);

      const result = await waitForReady(healthCheck, 10_000);

      expect(result).toBe(true);
      expect(healthCheck).toHaveBeenCalledTimes(2);
    });
  });
});
