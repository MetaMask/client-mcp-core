/* eslint-disable n/no-unsupported-features/node-builtins */
/* eslint-disable n/no-process-env */
/* eslint-disable n/no-sync */
/* eslint-disable require-atomic-updates */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  extractProjectFlag,
  resolveTargetFromArgs,
  getPositionalTarget,
  isTransientError,
  parseIntFlag,
  parseStringFlag,
  parseLaunchArgs,
  printHelp,
  resolveRuntime,
  sendRequest,
  routeCommand,
  resolveWorktreeRoot,
  readDaemonConfig,
  shutdownDaemon,
  waitForDaemon,
  discoverDaemon,
  autoStartDaemon,
  handleServe,
  sleep,
  main,
} from './mm.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('/mock/worktree\n')),
  spawn: vi.fn(() => {
    const child = {
      unref: vi.fn(),
      on: vi.fn(
        (event: string, handler: (code: number | null) => void) =>
          event === 'exit' && setTimeout(() => handler(0), 10),
      ),
    };
    return child;
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: vi.fn(async (p: string) => p),
    stat: vi.fn(async () => ({ isDirectory: () => true })),
    readFile: vi.fn(async () =>
      JSON.stringify({ mm: { daemon: './daemon.ts', runtime: 'tsx' } }),
    ),
  };
});

vi.mock('../server/daemon-state.js', () => ({
  readDaemonState: vi.fn(async () => null),
  isDaemonAlive: vi.fn(async () => false),
  isDaemonVersionMatch: vi.fn(() => true),
  removeDaemonState: vi.fn(async () => {}),
  acquireStartupLock: vi.fn(async () => true),
  releaseStartupLock: vi.fn(async () => {}),
}));

let exitSpy: MockInstance;
let stderrSpy: MockInstance;
let stdoutSpy: MockInstance;

// eslint-disable-next-line vitest/require-top-level-describe
beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

// eslint-disable-next-line vitest/require-top-level-describe
afterEach(() => {
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('extractProjectFlag', () => {
  it('returns args unchanged when no --project flag', () => {
    const result = extractProjectFlag(['launch', '--force']);
    expect(result).toStrictEqual({
      args: ['launch', '--force'],
      projectPath: undefined,
    });
  });

  it('extracts project path and removes flag from args', () => {
    const result = extractProjectFlag([
      '--project',
      '/path/to/project',
      'launch',
    ]);
    expect(result).toStrictEqual({
      args: ['launch'],
      projectPath: '/path/to/project',
    });
  });

  it('handles --project in the middle of args', () => {
    const result = extractProjectFlag([
      'launch',
      '--project',
      '/my/path',
      '--force',
    ]);
    expect(result).toStrictEqual({
      args: ['launch', '--force'],
      projectPath: '/my/path',
    });
  });

  it('exits when --project has no value', () => {
    expect(() => extractProjectFlag(['--project'])).toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --project requires a path value\n',
    );
  });

  it('exits when --project value starts with --', () => {
    expect(() => extractProjectFlag(['--project', '--force'])).toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --project requires a path value\n',
    );
  });
});

describe('resolveTargetFromArgs', () => {
  it('returns selector for --selector flag', () => {
    expect(resolveTargetFromArgs(['--selector', '.my-button'])).toStrictEqual({
      selector: '.my-button',
    });
  });

  it('returns testId for --testid flag', () => {
    expect(resolveTargetFromArgs(['--testid', 'my-btn'])).toStrictEqual({
      testId: 'my-btn',
    });
  });

  it('returns a11yRef for e-number patterns', () => {
    expect(resolveTargetFromArgs(['e3'])).toStrictEqual({ a11yRef: 'e3' });
    expect(resolveTargetFromArgs(['e123'])).toStrictEqual({ a11yRef: 'e123' });
  });

  it('returns testId for non-e-number strings', () => {
    expect(resolveTargetFromArgs(['submit-button'])).toStrictEqual({
      testId: 'submit-button',
    });
    expect(resolveTargetFromArgs(['eabc'])).toStrictEqual({
      testId: 'eabc',
    });
  });

  it('exits when --selector has no value', () => {
    expect(() => resolveTargetFromArgs(['--selector'])).toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --selector requires a value\n',
    );
  });

  it('exits when --selector value starts with --', () => {
    expect(() => resolveTargetFromArgs(['--selector', '--other'])).toThrowError(
      'process.exit',
    );
  });

  it('exits when --testid has no value', () => {
    expect(() => resolveTargetFromArgs(['--testid'])).toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --testid requires a value\n',
    );
  });

  it('exits when no target provided', () => {
    expect(() => resolveTargetFromArgs([])).toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: element target is required\n',
    );
  });
});

describe('getPositionalTarget', () => {
  it('returns first non-flag argument', () => {
    expect(getPositionalTarget(['e1', '--timeout', '5000'])).toBe('e1');
  });

  it('skips flag-value pairs', () => {
    expect(getPositionalTarget(['--timeout', '5000', 'e1'])).toBe('e1');
  });

  it('returns undefined for empty args', () => {
    expect(getPositionalTarget([])).toBeUndefined();
  });

  it('returns undefined when only flags present', () => {
    expect(getPositionalTarget(['--timeout', '5000'])).toBeUndefined();
  });
});

describe('isTransientError', () => {
  it('returns true for ECONNREFUSED', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for EPIPE', () => {
    expect(isTransientError(new Error('EPIPE'))).toBe(true);
  });

  it('returns true for UND_ERR_SOCKET', () => {
    expect(isTransientError(new Error('UND_ERR_SOCKET'))).toBe(true);
  });

  it('returns true for fetch failed', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isTransientError(new Error('timeout'))).toBe(false);
    expect(isTransientError(new Error('404 not found'))).toBe(false);
  });
});

describe('parseIntFlag', () => {
  it('returns parsed integer value', () => {
    expect(parseIntFlag(['--timeout', '5000'], '--timeout')).toBe(5000);
  });

  it('returns undefined when flag is absent', () => {
    expect(parseIntFlag(['--other', '5000'], '--timeout')).toBeUndefined();
  });

  it('returns undefined for NaN values', () => {
    expect(parseIntFlag(['--timeout', 'abc'], '--timeout')).toBeUndefined();
  });

  it('returns undefined when no value follows flag', () => {
    expect(parseIntFlag(['--timeout'], '--timeout')).toBeUndefined();
  });
});

describe('parseStringFlag', () => {
  it('returns string value', () => {
    expect(parseStringFlag(['--role', 'extension'], '--role')).toBe(
      'extension',
    );
  });

  it('returns undefined when flag is absent', () => {
    expect(parseStringFlag(['--other', 'val'], '--role')).toBeUndefined();
  });

  it('returns undefined when value starts with --', () => {
    expect(parseStringFlag(['--role', '--other'], '--role')).toBeUndefined();
  });

  it('returns undefined when no value follows', () => {
    expect(parseStringFlag(['--role'], '--role')).toBeUndefined();
  });
});

describe('parseLaunchArgs', () => {
  it('returns empty object for no args', () => {
    expect(parseLaunchArgs([])).toStrictEqual({});
  });

  it('parses --force flag', () => {
    expect(parseLaunchArgs(['--force'])).toStrictEqual({ force: true });
  });

  it('parses --state value', () => {
    expect(parseLaunchArgs(['--state', 'onboarding'])).toStrictEqual({
      stateMode: 'onboarding',
    });
  });

  it('parses --extension-path value', () => {
    expect(parseLaunchArgs(['--extension-path', '/ext'])).toStrictEqual({
      extensionPath: '/ext',
    });
  });

  it('parses --goal value', () => {
    expect(parseLaunchArgs(['--goal', 'test swap'])).toStrictEqual({
      goal: 'test swap',
    });
  });

  it('parses --flow-tags as comma-separated array', () => {
    expect(parseLaunchArgs(['--flow-tags', 'send, swap'])).toStrictEqual({
      flowTags: ['send', 'swap'],
    });
  });

  it('parses multiple flags together', () => {
    expect(
      parseLaunchArgs(['--state', 'default', '--force', '--goal', 'test it']),
    ).toStrictEqual({
      stateMode: 'default',
      force: true,
      goal: 'test it',
    });
  });

  it('exits for --state without value', () => {
    expect(() => parseLaunchArgs(['--state'])).toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --state requires a value (default|onboarding|custom)\n',
    );
  });

  it('exits for --state with flag as value', () => {
    expect(() => parseLaunchArgs(['--state', '--force'])).toThrowError(
      'process.exit',
    );
  });

  it('exits for --extension-path without value', () => {
    expect(() => parseLaunchArgs(['--extension-path'])).toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --extension-path requires a value\n',
    );
  });

  it('exits for --goal without value', () => {
    expect(() => parseLaunchArgs(['--goal'])).toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --goal requires a value\n');
  });

  it('exits for --flow-tags without value', () => {
    expect(() => parseLaunchArgs(['--flow-tags'])).toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --flow-tags requires a comma-separated value\n',
    );
  });

  it('writes warning for unknown flags', () => {
    parseLaunchArgs(['--unknown']);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Warning: unknown launch flag '--unknown'\n",
    );
  });
});

describe('printHelp', () => {
  it('writes help text to stdout', () => {
    printHelp();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = (stdoutSpy.mock.calls[0] as string[])[0];
    expect(output).toContain('mm — MetaMask CLI');
    expect(output).toContain('Usage:');
    expect(output).toContain('mm launch');
  });
});

describe('resolveRuntime', () => {
  it('returns node for node runtime', () => {
    expect(resolveRuntime('/root', 'node')).toBe('node');
  });

  it('returns bin path when runtime exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const result = resolveRuntime('/root', 'tsx');
    expect(result).toBe(path.join('/root', 'node_modules', '.bin', 'tsx'));
  });

  it('exits when runtime binary not found', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => resolveRuntime('/root', 'tsx')).toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Runtime 'tsx' not found"),
    );
  });
});

describe('sleep', () => {
  it('resolves after delay', async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    expect(await promise).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('shutdownDaemon', () => {
  it('sends SIGTERM and removes state', async () => {
    const { removeDaemonState } = await import('../server/daemon-state.js');
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(vi.fn() as unknown as typeof process.kill);

    await shutdownDaemon('/root', {
      port: 3000,
      pid: 12345,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    });

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(removeDaemonState).toHaveBeenCalledWith('/root');
    killSpy.mockRestore();
  });

  it('ignores kill errors for dead processes', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
    }) as unknown as typeof process.kill);

    await shutdownDaemon('/root', {
      port: 3000,
      pid: 12345,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    });

    expect(killSpy).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('skips kill when pid is falsy', async () => {
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(vi.fn() as unknown as typeof process.kill);

    await shutdownDaemon('/root', {
      port: 3000,
      pid: 0,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    });

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

describe('readDaemonConfig', () => {
  it('reads and parses mm config from package.json', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mm: { daemon: './my-daemon.ts', runtime: 'tsx' },
      }),
    );

    const result = await readDaemonConfig('/project');

    expect(result).toStrictEqual({
      daemonPath: './my-daemon.ts',
      runtime: 'tsx',
    });
  });

  it('defaults runtime to tsx when not specified', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ mm: { daemon: './d.ts' } }),
    );

    const result = await readDaemonConfig('/project');

    expect(result.runtime).toBe('tsx');
  });

  it('exits when package.json cannot be read', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));

    await expect(readDaemonConfig('/project')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cannot read package.json'),
    );
  });

  it('exits when mm.daemon is not configured', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({}));

    await expect(readDaemonConfig('/project')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No daemon entry point configured'),
    );
  });
});

describe('resolveWorktreeRoot', () => {
  it('resolves path from --project flag', async () => {
    vi.mocked(fs.realpath).mockResolvedValueOnce('/resolved/path');
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
    } as any);

    const result = await resolveWorktreeRoot('/some/path');
    expect(result).toBe('/resolved/path');
  });

  it('resolves path from MM_PROJECT env when no flag', async () => {
    const origEnv = process.env.MM_PROJECT;
    process.env.MM_PROJECT = '/env/path';

    vi.mocked(fs.realpath).mockResolvedValueOnce('/env/path');
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
    } as any);

    const result = await resolveWorktreeRoot(undefined);
    expect(result).toBe('/env/path');

    process.env.MM_PROJECT = origEnv;
  });

  it('exits when path does not exist', async () => {
    vi.mocked(fs.realpath).mockRejectedValueOnce(new Error('ENOENT'));

    await expect(resolveWorktreeRoot('/bad/path')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('project path does not exist'),
    );
  });

  it('exits when path is not a directory', async () => {
    vi.mocked(fs.realpath).mockResolvedValueOnce('/some/file.txt');
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => false,
    } as any);

    await expect(resolveWorktreeRoot('/some/file.txt')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('project path is not a directory'),
    );
  });

  it('exits when stat fails', async () => {
    vi.mocked(fs.realpath).mockResolvedValueOnce('/some/path');
    vi.mocked(fs.stat).mockRejectedValueOnce(new Error('EACCES'));

    await expect(resolveWorktreeRoot('/some/path')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot access project path'),
    );
  });

  it('falls back to git worktree when no explicit path', async () => {
    const origEnv = process.env.MM_PROJECT;
    delete process.env.MM_PROJECT;

    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('/git/root\n'));

    const result = await resolveWorktreeRoot(undefined);
    expect(result).toBe('/git/root');

    process.env.MM_PROJECT = origEnv;
  });

  it('exits when not in a git repository', async () => {
    const origEnv = process.env.MM_PROJECT;
    delete process.env.MM_PROJECT;

    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not a git repo');
    });

    await expect(resolveWorktreeRoot(undefined)).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not in a git repository'),
    );

    process.env.MM_PROJECT = origEnv;
  });
});

describe('sendRequest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends GET request and prints JSON result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { status: 'running' } }),
    } as Response);

    await sendRequest(3000, 'GET', '/status', null);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/status',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('sends POST request with JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: 'launched' }),
    } as Response);

    await sendRequest(3000, 'POST', '/launch', { state: 'default' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/launch',
      expect.objectContaining({
        method: 'POST',
        body: '{"state":"default"}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('prints string results directly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: 'simple string' }),
    } as Response);

    await sendRequest(3000, 'GET', '/status', null);

    expect(stdoutSpy).toHaveBeenCalledWith('simple string\n');
  });

  it('exits on error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({
        ok: false,
        error: { message: 'No session' },
      }),
    } as Response);

    await expect(
      sendRequest(3000, 'POST', '/tool/click', {}),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith('Error: No session\n');
  });

  it('exits on ok:false in response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        error: { message: 'Tool failed' },
      }),
    } as Response);

    await expect(
      sendRequest(3000, 'POST', '/tool/click', {}),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith('Error: Tool failed\n');
  });

  it('retries transient errors', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error('ECONNREFUSED');
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: 'ok' }),
      } as Response;
    });

    await sendRequest(3000, 'GET', '/health', null);

    expect(attempts).toBe(3);
  });

  it('exits after max retries for transient errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      sendRequest(3000, 'GET', '/health', null),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('exits immediately for non-transient errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('some other error'),
    );

    await expect(
      sendRequest(3000, 'GET', '/health', null),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('some other error'),
    );
  });

  it('exits on request timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(sendRequest(3000, 'POST', '/launch', {})).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('request timed out'),
    );
  });

  it('falls back to data when no result key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 'running' }),
    } as Response);

    await sendRequest(3000, 'GET', '/status', null);

    expect(stdoutSpy).toHaveBeenCalled();
    const output = (stdoutSpy.mock.calls[0] as string[])[0];
    expect(output).toContain('running');
  });

  it('falls back to "Request failed" when error has no message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false }),
    } as Response);

    await expect(sendRequest(3000, 'POST', '/tool/x', {})).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith('Error: Request failed\n');
  });
});

describe('routeCommand', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes status to GET /status', async () => {
    await routeCommand('status', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('routes click with a11y ref', async () => {
    await routeCommand('click', ['e3'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/click',
      expect.objectContaining({
        body: JSON.stringify({ a11yRef: 'e3' }),
      }),
    );
  });

  it('routes click with --selector', async () => {
    await routeCommand('click', ['--selector', '.btn'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/click',
      expect.objectContaining({
        body: JSON.stringify({ selector: '.btn' }),
      }),
    );
  });

  it('exits when click has no target', async () => {
    await expect(routeCommand('click', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: mm click'),
    );
  });

  it('routes type with ref and text', async () => {
    await routeCommand('type', ['e1', 'hello'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/type',
      expect.objectContaining({
        body: JSON.stringify({ a11yRef: 'e1', text: 'hello' }),
      }),
    );
  });

  it('routes type with --testid', async () => {
    await routeCommand('type', ['--testid', 'input', 'text'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/type',
      expect.objectContaining({
        body: JSON.stringify({ testId: 'input', text: 'text' }),
      }),
    );
  });

  it('exits when type has no target', async () => {
    await expect(routeCommand('type', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('exits when type has no text', async () => {
    await expect(routeCommand('type', ['e1'], 3000)).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith('Usage: mm type <ref> <text>\n');
  });

  it('routes describe-screen', async () => {
    await routeCommand('describe-screen', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/describe_screen',
      expect.anything(),
    );
  });

  it('routes screenshot', async () => {
    await routeCommand('screenshot', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/screenshot',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes screenshot with --name', async () => {
    await routeCommand('screenshot', ['--name', 'my-shot'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/screenshot',
      expect.objectContaining({
        body: JSON.stringify({ name: 'my-shot' }),
      }),
    );
  });

  it('routes wait-for with ref', async () => {
    await routeCommand('wait-for', ['e5'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/wait_for',
      expect.objectContaining({
        body: JSON.stringify({ a11yRef: 'e5' }),
      }),
    );
  });

  it('routes wait-for with --timeout', async () => {
    await routeCommand('wait-for', ['e5', '--timeout', '10000'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/wait_for',
      expect.objectContaining({
        body: JSON.stringify({ a11yRef: 'e5', timeoutMs: 10000 }),
      }),
    );
  });

  it('exits when wait-for has no target', async () => {
    await expect(routeCommand('wait-for', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes navigate with url', async () => {
    await routeCommand('navigate', ['http://example.com'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/navigate',
      expect.objectContaining({
        body: JSON.stringify({ screen: 'url', url: 'http://example.com' }),
      }),
    );
  });

  it('exits when navigate has no url', async () => {
    await expect(routeCommand('navigate', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes navigate-home', async () => {
    await routeCommand('navigate-home', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/navigate',
      expect.objectContaining({
        body: JSON.stringify({ screen: 'home' }),
      }),
    );
  });

  it('routes navigate-settings', async () => {
    await routeCommand('navigate-settings', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/navigate',
      expect.objectContaining({
        body: JSON.stringify({ screen: 'settings' }),
      }),
    );
  });

  it('routes get-state', async () => {
    await routeCommand('get-state', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/get_state',
      expect.anything(),
    );
  });

  it('routes get-context', async () => {
    await routeCommand('get-context', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/get_context',
      expect.anything(),
    );
  });

  it('routes set-context with e2e', async () => {
    await routeCommand('set-context', ['e2e'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/set_context',
      expect.objectContaining({
        body: JSON.stringify({ context: 'e2e' }),
      }),
    );
  });

  it('routes set-context with prod', async () => {
    await routeCommand('set-context', ['prod'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/set_context',
      expect.objectContaining({
        body: JSON.stringify({ context: 'prod' }),
      }),
    );
  });

  it('exits when set-context has invalid value', async () => {
    await expect(
      routeCommand('set-context', ['other'], 3000),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Usage: mm set-context <e2e|prod>\n',
    );
  });

  it('exits when set-context has no value', async () => {
    await expect(routeCommand('set-context', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes build', async () => {
    await routeCommand('build', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/build',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes build with --force', async () => {
    await routeCommand('build', ['--force'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/build',
      expect.objectContaining({
        body: JSON.stringify({ force: true }),
      }),
    );
  });

  it('routes wait-for-notification', async () => {
    await routeCommand('wait-for-notification', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/wait_for_notification',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes wait-for-notification with --timeout', async () => {
    await routeCommand('wait-for-notification', ['--timeout', '5000'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/wait_for_notification',
      expect.objectContaining({
        body: JSON.stringify({ timeoutMs: 5000 }),
      }),
    );
  });

  it('routes switch-to-tab with --role', async () => {
    await routeCommand('switch-to-tab', ['--role', 'extension'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/switch_to_tab',
      expect.objectContaining({
        body: JSON.stringify({ role: 'extension' }),
      }),
    );
  });

  it('routes switch-to-tab with --url', async () => {
    await routeCommand('switch-to-tab', ['--url', 'http://dapp.io'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/switch_to_tab',
      expect.objectContaining({
        body: JSON.stringify({ url: 'http://dapp.io' }),
      }),
    );
  });

  it('exits when switch-to-tab has no flags', async () => {
    await expect(routeCommand('switch-to-tab', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes close-tab with --role', async () => {
    await routeCommand('close-tab', ['--role', 'dapp'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/close_tab',
      expect.objectContaining({
        body: JSON.stringify({ role: 'dapp' }),
      }),
    );
  });

  it('routes close-tab with --url', async () => {
    await routeCommand('close-tab', ['--url', 'http://x.io'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/close_tab',
      expect.objectContaining({
        body: JSON.stringify({ url: 'http://x.io' }),
      }),
    );
  });

  it('exits when close-tab has no flags', async () => {
    await expect(routeCommand('close-tab', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes clipboard read', async () => {
    await routeCommand('clipboard', ['read'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/clipboard',
      expect.objectContaining({
        body: JSON.stringify({ action: 'read' }),
      }),
    );
  });

  it('routes clipboard write with text', async () => {
    await routeCommand('clipboard', ['write', 'hello'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/clipboard',
      expect.objectContaining({
        body: JSON.stringify({ action: 'write', text: 'hello' }),
      }),
    );
  });

  it('exits when clipboard has invalid action', async () => {
    await expect(
      routeCommand('clipboard', ['invalid'], 3000),
    ).rejects.toThrowError('process.exit');
  });

  it('exits when clipboard has no action', async () => {
    await expect(routeCommand('clipboard', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('exits when clipboard write has no text', async () => {
    await expect(
      routeCommand('clipboard', ['write'], 3000),
    ).rejects.toThrowError('process.exit');
  });

  it('routes seed-contract', async () => {
    await routeCommand('seed-contract', ['hst'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/seed_contract',
      expect.objectContaining({
        body: JSON.stringify({ contractName: 'hst' }),
      }),
    );
  });

  it('routes seed-contract with --hardfork', async () => {
    await routeCommand(
      'seed-contract',
      ['hst', '--hardfork', 'shanghai'],
      3000,
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/seed_contract',
      expect.objectContaining({
        body: JSON.stringify({ contractName: 'hst', hardfork: 'shanghai' }),
      }),
    );
  });

  it('exits when seed-contract has no name', async () => {
    await expect(routeCommand('seed-contract', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes seed-contracts with multiple names', async () => {
    await routeCommand('seed-contracts', ['hst', 'nfts'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/seed_contracts',
      expect.objectContaining({
        body: JSON.stringify({ contracts: ['hst', 'nfts'] }),
      }),
    );
  });

  it('routes seed-contracts with --hardfork', async () => {
    await routeCommand(
      'seed-contracts',
      ['hst', '--hardfork', 'shanghai'],
      3000,
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/seed_contracts',
      expect.objectContaining({
        body: expect.stringContaining('"hardfork":"shanghai"'),
      }),
    );
  });

  it('exits when seed-contracts has no names', async () => {
    await expect(routeCommand('seed-contracts', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('routes get-contract-address', async () => {
    await routeCommand('get-contract-address', ['hst'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/get_contract_address',
      expect.objectContaining({
        body: JSON.stringify({ contractName: 'hst' }),
      }),
    );
  });

  it('exits when get-contract-address has no name', async () => {
    await expect(
      routeCommand('get-contract-address', [], 3000),
    ).rejects.toThrowError('process.exit');
  });

  it('routes list-contracts', async () => {
    await routeCommand('list-contracts', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/list_contracts',
      expect.anything(),
    );
  });

  it('routes list-testids', async () => {
    await routeCommand('list-testids', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/list_testids',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes list-testids with --limit', async () => {
    await routeCommand('list-testids', ['--limit', '50'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/list_testids',
      expect.objectContaining({
        body: JSON.stringify({ limit: 50 }),
      }),
    );
  });

  it('routes accessibility-snapshot', async () => {
    await routeCommand('accessibility-snapshot', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/accessibility_snapshot',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes accessibility-snapshot with --root', async () => {
    await routeCommand('accessibility-snapshot', ['--root', '#main'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/accessibility_snapshot',
      expect.objectContaining({
        body: JSON.stringify({ rootSelector: '#main' }),
      }),
    );
  });

  it('routes knowledge-search', async () => {
    await routeCommand('knowledge-search', ['send flow'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/knowledge_search',
      expect.objectContaining({
        body: JSON.stringify({ query: 'send flow' }),
      }),
    );
  });

  it('exits when knowledge-search has no query', async () => {
    await expect(
      routeCommand('knowledge-search', [], 3000),
    ).rejects.toThrowError('process.exit');
  });

  it('routes knowledge-last', async () => {
    await routeCommand('knowledge-last', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/knowledge_last',
      expect.anything(),
    );
  });

  it('routes knowledge-sessions', async () => {
    await routeCommand('knowledge-sessions', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/knowledge_sessions',
      expect.anything(),
    );
  });

  it('routes knowledge-summarize', async () => {
    await routeCommand('knowledge-summarize', [], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/knowledge_summarize',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it('routes knowledge-summarize with --session', async () => {
    await routeCommand('knowledge-summarize', ['--session', 'sid'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/knowledge_summarize',
      expect.objectContaining({
        body: JSON.stringify({ scope: { sessionId: 'sid' } }),
      }),
    );
  });

  it('routes run-steps with JSON input', async () => {
    const input = JSON.stringify({
      steps: [{ tool: 'click', args: { a11yRef: 'e1' } }],
    });
    await routeCommand('run-steps', [input], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/run_steps',
      expect.objectContaining({ body: input }),
    );
  });

  it('exits when run-steps has no input', async () => {
    await expect(routeCommand('run-steps', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
  });

  it('exits when run-steps has invalid JSON', async () => {
    await expect(
      routeCommand('run-steps', ['{bad json}'], 3000),
    ).rejects.toThrowError('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid JSON'),
    );
  });

  it('exits for unknown command', async () => {
    await expect(routeCommand('unknown-cmd', [], 3000)).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown command 'unknown-cmd'"),
    );
  });
});

describe('discoverDaemon', () => {
  it('returns existing alive daemon with matching version', async () => {
    const { readDaemonState, isDaemonAlive, isDaemonVersionMatch } =
      await import('../server/daemon-state.js');
    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      version: '1.0.0',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);
    vi.mocked(isDaemonVersionMatch).mockReturnValueOnce(true);

    const result = await discoverDaemon('/root', 'click');
    expect(result).toStrictEqual(mockState);
  });

  it('restarts daemon on version mismatch', async () => {
    const {
      readDaemonState,
      isDaemonAlive,
      isDaemonVersionMatch,
      removeDaemonState,
    } = await import('../server/daemon-state.js');

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(vi.fn() as unknown as typeof process.kill);

    const oldState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      version: '0.0.1',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(oldState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);
    vi.mocked(isDaemonVersionMatch).mockReturnValueOnce(false);

    await expect(discoverDaemon('/root', 'click')).rejects.toThrowError(
      'process.exit',
    );

    expect(removeDaemonState).toHaveBeenCalledWith('/root');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Daemon version mismatch'),
    );

    killSpy.mockRestore();
  });

  it('auto-starts daemon for launch command when no daemon running', async () => {
    const {
      readDaemonState,
      isDaemonAlive,
      acquireStartupLock,
      releaseStartupLock,
    } = await import('../server/daemon-state.js');

    vi.mocked(readDaemonState).mockResolvedValueOnce(null);

    vi.mocked(acquireStartupLock).mockResolvedValueOnce(true);

    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    const result = await discoverDaemon('/root', 'launch');

    expect(result).toStrictEqual(mockState);
    expect(releaseStartupLock).toHaveBeenCalledWith('/root');
  });

  it('removes stale daemon state when not alive', async () => {
    const { readDaemonState, isDaemonAlive, removeDaemonState } =
      await import('../server/daemon-state.js');
    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(false);

    await expect(discoverDaemon('/root', 'click')).rejects.toThrowError(
      'process.exit',
    );

    expect(removeDaemonState).toHaveBeenCalledWith('/root');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('no daemon running'),
    );
  });

  it('exits for non-auto-start commands when no daemon', async () => {
    const { readDaemonState } = await import('../server/daemon-state.js');
    vi.mocked(readDaemonState).mockResolvedValueOnce(null);

    await expect(discoverDaemon('/root', 'status')).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('no daemon running'),
    );
  });
});

describe('waitForDaemon', () => {
  it('returns daemon state when daemon becomes alive', async () => {
    const { readDaemonState, isDaemonAlive } =
      await import('../server/daemon-state.js');
    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    vi.useFakeTimers();
    const promise = waitForDaemon('/root');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(result).toStrictEqual(mockState);
  });

  it('throws when daemon fails to start within timeout', async () => {
    const { readDaemonState } = await import('../server/daemon-state.js');
    vi.mocked(readDaemonState).mockResolvedValue(null);

    vi.useFakeTimers();
    const promise = waitForDaemon('/root').catch((error: Error) => error);
    for (let i = 0; i < 55; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Daemon failed to start');
    vi.useRealTimers();
  });
});

describe('main', () => {
  it('prints help when no args', async () => {
    const origArgv = process.argv;
    process.argv = ['node', 'mm'];

    await expect(main()).rejects.toThrowError('process.exit');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('mm —'));

    process.argv = origArgv;
  });

  it('prints help for --help flag', async () => {
    const origArgv = process.argv;
    process.argv = ['node', 'mm', '--help'];

    await expect(main()).rejects.toThrowError('process.exit');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));

    process.argv = origArgv;
  });

  it('prints help for -h flag', async () => {
    const origArgv = process.argv;
    process.argv = ['node', 'mm', '-h'];

    await expect(main()).rejects.toThrowError('process.exit');

    process.argv = origArgv;
  });
});

describe('type command --selector/--testid text resolution', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes type with --selector and text after selector', async () => {
    await routeCommand('type', ['--selector', '.input', 'hello world'], 3000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/tool/type',
      expect.objectContaining({
        body: JSON.stringify({
          selector: '.input',
          text: 'hello world',
        }),
      }),
    );
  });
});

describe('handleServe', () => {
  it('exits when daemon is already running', async () => {
    const { readDaemonState, isDaemonAlive } =
      await import('../server/daemon-state.js');
    vi.mocked(readDaemonState).mockResolvedValueOnce({
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    });
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    await expect(handleServe('/root', false)).rejects.toThrowError(
      'process.exit',
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('daemon already running'),
    );
  });

  it('starts daemon in background mode', async () => {
    const { readDaemonState, isDaemonAlive } =
      await import('../server/daemon-state.js');
    const { spawn } = await import('node:child_process');

    vi.mocked(readDaemonState).mockResolvedValueOnce(null);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ mm: { daemon: './daemon.ts', runtime: 'node' } }),
    );

    const mockState = {
      port: 4000,
      pid: 456,
      nonce: 'xyz',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    vi.useFakeTimers();
    const promise = handleServe('/root', true);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    await promise;
    vi.useRealTimers();

    expect(spawn).toHaveBeenCalledWith('node', ['./daemon.ts'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: '/root',
    });
    expect(stdoutSpy).toHaveBeenCalledWith(
      'Daemon started on port 4000 (PID 456)\n',
    );
  });

  it('cleans stale state before starting', async () => {
    const { readDaemonState, isDaemonAlive, removeDaemonState } =
      await import('../server/daemon-state.js');
    const staleState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(staleState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(false);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ mm: { daemon: './d.ts', runtime: 'node' } }),
    );

    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdio: 'inherit',
      on: vi.fn((event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          setTimeout(() => handler(0), 10);
        }
      }),
    } as any);

    const promise = handleServe('/root', false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await promise;

    expect(removeDaemonState).toHaveBeenCalledWith('/root');
  });
});

describe('autoStartDaemon', () => {
  it('returns existing daemon if one appeared after locking', async () => {
    const {
      acquireStartupLock,
      readDaemonState,
      isDaemonAlive,
      releaseStartupLock,
    } = await import('../server/daemon-state.js');

    vi.mocked(acquireStartupLock).mockResolvedValueOnce(true);

    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState).mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    const result = await autoStartDaemon('/root');

    expect(result).toStrictEqual(mockState);
    expect(releaseStartupLock).toHaveBeenCalledWith('/root');
  });

  it('spawns daemon when no existing daemon is found', async () => {
    const {
      acquireStartupLock,
      readDaemonState,
      isDaemonAlive,
      releaseStartupLock,
    } = await import('../server/daemon-state.js');
    const { spawn } = await import('node:child_process');

    vi.mocked(acquireStartupLock).mockResolvedValueOnce(true);
    vi.mocked(readDaemonState).mockResolvedValueOnce(null);

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ mm: { daemon: './daemon.ts', runtime: 'node' } }),
    );

    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    vi.useFakeTimers();
    const promise = autoStartDaemon('/root');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(spawn).toHaveBeenCalledWith('node', ['./daemon.ts'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: '/root',
    });
    expect(releaseStartupLock).toHaveBeenCalledWith('/root');
    expect(result).toStrictEqual(mockState);
  });

  it('waits when lock is held by another process', async () => {
    const { acquireStartupLock, readDaemonState, isDaemonAlive } =
      await import('../server/daemon-state.js');

    vi.mocked(acquireStartupLock).mockResolvedValueOnce(false);

    const mockState = {
      port: 3000,
      pid: 123,
      nonce: 'abc',
      startedAt: '2024-01-01',
      subPorts: { anvil: 8545, fixture: 8546, mock: 8547 },
    };
    vi.mocked(readDaemonState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockState);
    vi.mocked(isDaemonAlive).mockResolvedValueOnce(true);

    vi.useFakeTimers();
    const promise = autoStartDaemon('/root');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(result).toStrictEqual(mockState);
  });
});
