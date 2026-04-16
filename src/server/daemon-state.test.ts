/* eslint-disable n/no-unsupported-features/node-builtins */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  writeDaemonState,
  readDaemonState,
  removeDaemonState,
  acquireStartupLock,
  releaseStartupLock,
  isDaemonAlive,
  isDaemonVersionMatch,
  generateNonce,
} from './daemon-state.js';
import pkg from '../../package.json';
import type { DaemonState } from '../types/http.js';

const tmpDir = path.join(os.tmpdir(), `mm-daemon-state-test-${Date.now()}`);

const mockState: DaemonState = {
  port: 12345,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nonce: 'test-nonce-abc',
  version: pkg.version,
  subPorts: { serviceA: 3001, serviceB: 3002 },
};

describe('daemon-state', () => {
  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('writeDaemonState / readDaemonState', () => {
    it('writes and reads state atomically', async () => {
      await writeDaemonState(tmpDir, mockState);
      const read = await readDaemonState(tmpDir);
      expect(read).toStrictEqual(mockState);
    });

    it('overwrites existing state', async () => {
      await writeDaemonState(tmpDir, mockState);
      const updated: DaemonState = { ...mockState, port: 99999 };
      await writeDaemonState(tmpDir, updated);
      const read = await readDaemonState(tmpDir);
      expect(read?.port).toBe(99999);
    });
  });

  describe('readDaemonState', () => {
    it('returns null when file does not exist', async () => {
      const result = await readDaemonState(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      await fs.writeFile(path.join(tmpDir, '.mm-server'), 'not-json', 'utf-8');
      const result = await readDaemonState(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe('removeDaemonState', () => {
    it('removes the state file', async () => {
      await writeDaemonState(tmpDir, mockState);
      await removeDaemonState(tmpDir);
      const result = await readDaemonState(tmpDir);
      expect(result).toBeNull();
    });

    it('does not throw when file does not exist', async () => {
      expect(await removeDaemonState(tmpDir)).toBeUndefined();
    });
  });

  describe('isDaemonAlive', () => {
    it('returns false for an unreachable port', async () => {
      const alive = await isDaemonAlive({ ...mockState, port: 1 });
      expect(alive).toBe(false);
    });

    it('returns false when response.ok is false', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
      } as Response);

      const alive = await isDaemonAlive(mockState);

      expect(alive).toBe(false);
    });

    it('returns false when nonce does not match', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ nonce: 'different-nonce' }),
      } as unknown as Response);

      const alive = await isDaemonAlive({
        ...mockState,
        nonce: 'expected-nonce',
      });

      expect(alive).toBe(false);
    });
  });

  describe('acquireStartupLock / releaseStartupLock', () => {
    it('creates the lock file and writes the current pid', async () => {
      const acquired = await acquireStartupLock(tmpDir);

      expect(acquired).toBe(true);
      expect(
        await fs.readFile(path.join(tmpDir, '.mm-server.lock'), 'utf-8'),
      ).toBe(`${process.pid}\n`);
    });

    it('returns false when another process holds a fresh lock', async () => {
      await fs.writeFile(
        path.join(tmpDir, '.mm-server.lock'),
        `${process.pid}\n`,
      );

      const acquired = await acquireStartupLock(tmpDir);

      expect(acquired).toBe(false);
    });

    it('reclaims a stale lock by age', async () => {
      const lockPath = path.join(tmpDir, '.mm-server.lock');
      const staleTime = new Date(Date.now() - 31_000);

      await fs.writeFile(lockPath, `${process.pid}\n`);
      await fs.utimes(lockPath, staleTime, staleTime);

      const acquired = await acquireStartupLock(tmpDir);

      expect(acquired).toBe(true);
      expect(await fs.readFile(lockPath, 'utf-8')).toBe(`${process.pid}\n`);
    });

    it('reclaims a stale lock for a dead pid', async () => {
      const lockPath = path.join(tmpDir, '.mm-server.lock');

      await fs.writeFile(lockPath, '999999\n');

      const acquired = await acquireStartupLock(tmpDir);

      expect(acquired).toBe(true);
      expect(await fs.readFile(lockPath, 'utf-8')).toBe(`${process.pid}\n`);
    });

    it('returns false when stale lock check errors', async () => {
      await fs.writeFile(path.join(tmpDir, '.mm-server.lock'), '12345\n');
      await fs.chmod(path.join(tmpDir, '.mm-server.lock'), 0o000);

      const acquired = await acquireStartupLock(tmpDir);

      expect(acquired).toBe(false);
    });

    it('throws when lock creation fails with a non-EEXIST error', async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });

      await expect(acquireStartupLock(tmpDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('removes the lock file', async () => {
      const lockPath = path.join(tmpDir, '.mm-server.lock');

      await fs.writeFile(lockPath, `${process.pid}\n`);
      await releaseStartupLock(tmpDir);

      await expect(fs.access(lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('ignores ENOENT when releasing the lock', async () => {
      expect(await releaseStartupLock(tmpDir)).toBeUndefined();
    });

    it('throws when lock release fails with a non-ENOENT error', async () => {
      await fs.mkdir(path.join(tmpDir, '.mm-server.lock'));

      await expect(releaseStartupLock(tmpDir)).rejects.toMatchObject({
        code: 'EPERM',
      });
    });
  });

  describe('isDaemonVersionMatch', () => {
    it('returns true when version matches package.json version', () => {
      expect(isDaemonVersionMatch(mockState)).toBe(true);
    });

    it('returns false when version differs', () => {
      expect(isDaemonVersionMatch({ ...mockState, version: '0.0.0' })).toBe(
        false,
      );
    });

    it('returns false when version is absent (pre-version-tracking daemon)', () => {
      const { version: _, ...stateWithoutVersion } = mockState;
      expect(isDaemonVersionMatch(stateWithoutVersion as DaemonState)).toBe(
        false,
      );
    });
  });

  describe('generateNonce', () => {
    it('returns a non-empty string', () => {
      const nonce = generateNonce();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);
    });

    it('returns unique values on successive calls', () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a).not.toBe(b);
    });
  });
});
