import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import pkg from '../../package.json';
import type { DaemonState } from '../types/http.js';

const DAEMON_STATE_FILE = '.mm-server';
const DAEMON_STATE_TMP_FILE = '.mm-server.tmp';
const DAEMON_LOCK_FILE = '.mm-server.lock';
const LOCK_STALE_MS = 30_000;

/**
 * Writes daemon state atomically using rename pattern.
 * Writes to .mm-server.tmp first, then renames to .mm-server.
 *
 * @param worktreeRoot - Absolute path to the git worktree root.
 * @param state - The daemon state to persist.
 */
export async function writeDaemonState(
  worktreeRoot: string,
  state: DaemonState,
): Promise<void> {
  const tmpPath = path.join(worktreeRoot, DAEMON_STATE_TMP_FILE);
  const finalPath = path.join(worktreeRoot, DAEMON_STATE_FILE);
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tmpPath, finalPath);
}

/**
 * Reads daemon state from .mm-server file.
 * Returns null if file doesn't exist, JSON is invalid, or required fields are missing.
 *
 * @param worktreeRoot - Absolute path to the git worktree root.
 * @returns The parsed daemon state, or null if unavailable.
 */
export async function readDaemonState(
  worktreeRoot: string,
): Promise<DaemonState | null> {
  const filePath = path.join(worktreeRoot, DAEMON_STATE_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      typeof parsed.port !== 'number' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

/**
 * Removes the .mm-server file.
 * Silently ignores if file doesn't exist.
 *
 * @param worktreeRoot - Absolute path to the git worktree root.
 */
export async function removeDaemonState(worktreeRoot: string): Promise<void> {
  const filePath = path.join(worktreeRoot, DAEMON_STATE_FILE);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Checks if a daemon is alive by sending GET /health and verifying the nonce.
 * Returns false if connection refused, timeout, or nonce mismatch.
 *
 * @param state - The daemon state containing port and nonce to verify.
 * @returns Whether the daemon is responding and matches the expected nonce.
 */
export async function isDaemonAlive(state: DaemonState): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { nonce?: string };
      return body.nonce === state.nonce;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Checks whether the daemon's package version matches the current CLI version.
 * Returns false if the daemon state has no version (pre-version-tracking daemon).
 *
 * @param state - The daemon state to check.
 * @returns Whether the versions match.
 */
export function isDaemonVersionMatch(state: DaemonState): boolean {
  return state.version === pkg.version;
}

/**
 * Generates a new random nonce for daemon identification.
 *
 * @returns A UUID string.
 */
export function generateNonce(): string {
  return randomUUID();
}

/**
 * Acquires an exclusive startup lock for the worktree.
 * Uses O_CREAT | O_EXCL to atomically create the lock file — if it already
 * exists, checks whether the lock is stale (dead PID or older than 30s)
 * and reclaims it if so.
 *
 * @param worktreeRoot - Absolute path to the git worktree root.
 * @returns true if the lock was acquired, false if another process holds it.
 */
export async function acquireStartupLock(
  worktreeRoot: string,
): Promise<boolean> {
  const lockPath = path.join(worktreeRoot, DAEMON_LOCK_FILE);
  try {
    // eslint-disable-next-line no-bitwise
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
    const fd = await fs.open(lockPath, flags);
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (await isLockStale(lockPath)) {
        try {
          await fs.unlink(lockPath);
        } catch {
          return false;
        }
        return acquireStartupLock(worktreeRoot);
      }
      return false;
    }
    throw error;
  }
}

/**
 * Checks whether a lock file is stale by examining PID liveness and file age.
 *
 * @param lockPath - Absolute path to the lock file.
 * @returns true if the lock holder is dead or the file is older than LOCK_STALE_MS.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(lockPath, 'utf-8'),
      fs.stat(lockPath),
    ]);

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > LOCK_STALE_MS) {
      return true;
    }

    const pid = parseInt(content.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Releases the startup lock for the worktree.
 * Silently ignores if the lock file doesn't exist.
 *
 * @param worktreeRoot - Absolute path to the git worktree root.
 */
export async function releaseStartupLock(worktreeRoot: string): Promise<void> {
  const lockPath = path.join(worktreeRoot, DAEMON_LOCK_FILE);
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
