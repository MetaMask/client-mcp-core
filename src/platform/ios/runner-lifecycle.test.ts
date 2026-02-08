import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

import { startRunner, stopRunner, waitForReady } from './runner-lifecycle.js';

const mockSpawn = vi.mocked(spawn);
const mockReaddir = vi.mocked(readdir) as unknown as ReturnType<typeof vi.fn>;

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  Object.defineProperty(proc, 'pid', { value: 12345, writable: true });
  return proc;
}

describe('runner-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopRunner();
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

      proc.stdout!.emit(
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
      ]);
    });

    it('rejects when no .xctestrun file found', async () => {
      mockReaddir.mockResolvedValue(['somefile.txt', 'other.json']);

      await expect(
        startRunner({
          derivedDataPath: '/derived',
          destination: 'platform=iOS Simulator,id=AAA-111',
        }),
      ).rejects.toThrow('No .xctestrun file found');
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

      await expect(portPromise).rejects.toThrow(
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

      await expect(portPromise).rejects.toThrow('spawn ENOENT');
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

      await expect(portPromise).rejects.toThrow(
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

      proc.stdout!.emit('data', Buffer.from('AGENT_DEVICE_RUNNER_PORT=1111\n'));
      proc.stdout!.emit('data', Buffer.from('AGENT_DEVICE_RUNNER_PORT=2222\n'));

      const port = await portPromise;

      expect(port).toBe(1111);
    });
  });

  describe('stopRunner', () => {
    it('kills the runner process', async () => {
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

      proc.stdout!.emit('data', Buffer.from('AGENT_DEVICE_RUNNER_PORT=9876\n'));
      await portPromise;

      stopRunner();

      expect(proc.kill).toHaveBeenCalled();
    });

    it('does nothing when no runner is active', () => {
      expect(() => stopRunner()).not.toThrow();
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
