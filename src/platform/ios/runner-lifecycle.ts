/**
 * XCUITest runner lifecycle management.
 *
 * Handles starting and stopping the xcodebuild test runner process,
 * which hosts the agent-device HTTP server inside the iOS test runner.
 *
 * The runner outputs `AGENT_DEVICE_RUNNER_PORT=<port>` on stdout when ready.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RunnerEntry = { process: ChildProcess; port: number; logPath: string };
const runnerProcesses = new Map<string, RunnerEntry>();

export type RunnerOptions = {
  derivedDataPath: string;
  destination: string;
  timeoutMs?: number;
  logDir?: string;
};

const PORT_PATTERN = /AGENT_DEVICE_RUNNER_PORT=(\d+)/u;
const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_LOG_DIR = join(tmpdir(), 'metamask-mobile-xcuitest-logs');
const MAX_LOG_BUFFER_CHARS = 128_000;
const TAIL_LINES = 20;

function appendToBuffer(buffer: string, text: string): string {
  const merged = buffer + text;
  if (merged.length <= MAX_LOG_BUFFER_CHARS) {
    return merged;
  }
  return merged.slice(-MAX_LOG_BUFFER_CHARS);
}

function tail(text: string, lines: number = TAIL_LINES): string {
  const relevant = text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (relevant.length === 0) {
    return '<empty>';
  }
  return relevant.slice(-lines).join('\n');
}

function sanitizeDestination(destination: string): string {
  return destination.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120);
}

async function createRunnerLogFilePath(
  destination: string,
  logDir?: string,
): Promise<string> {
  const baseDir = logDir ?? DEFAULT_LOG_DIR;
  await mkdir(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const safeDestination = sanitizeDestination(destination);
  return join(baseDir, `xcuitest-runner-${stamp}-${safeDestination}.log`);
}

async function appendLog(
  logPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  chunk: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${stream}] `;
  await appendFile(logPath, `${prefix}${chunk}`);
}

function createRunnerStartError(
  reason: string,
  logPath: string,
  stdoutBuffer: string,
  stderrBuffer: string,
): Error {
  const stdoutTail = tail(stdoutBuffer);
  const stderrTail = tail(stderrBuffer);
  return new Error(
    `${reason}\n` +
      `Runner log: ${logPath}\n` +
      `stdout tail:\n${stdoutTail}\n` +
      `stderr tail:\n${stderrTail}`,
  );
}

/**
 * Locate the .xctestrun file inside the derived data directory.
 *
 * @param derivedDataPath - Path to Xcode derived data directory.
 * @returns Full path to the .xctestrun file.
 */
async function findXctestrunFile(derivedDataPath: string): Promise<string> {
  const buildProductsDir = join(derivedDataPath, 'Build', 'Products');
  const files = await readdir(buildProductsDir);
  const xctestrunFile = files.find((file) => file.endsWith('.xctestrun'));

  if (!xctestrunFile) {
    throw new Error(`No .xctestrun file found in ${buildProductsDir}`);
  }

  return join(buildProductsDir, xctestrunFile);
}

/**
 * Start the XCUITest runner process.
 *
 * Spawns `xcodebuild test-without-building` and waits for the runner
 * to print the port number to stdout. Returns the port on success.
 *
 * @param options - Runner start options including destination and timeout.
 * @returns Promise resolving to the runner port.
 * @throws If the runner does not emit a port within the timeout
 * @throws If the runner process exits before emitting a port
 * @throws If no .xctestrun file is found in derivedDataPath
 */
export async function startRunner(options: RunnerOptions): Promise<number> {
  const { destination } = options;

  // Stop any existing runner for this destination before starting a new one
  if (runnerProcesses.has(destination)) {
    await stopRunner(destination);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const xctestrunPath = await findXctestrunFile(options.derivedDataPath);
  const logPath = await createRunnerLogFilePath(destination, options.logDir);
  await appendLog(
    logPath,
    'meta',
    `startRunner destination=${destination} timeoutMs=${timeoutMs}\n`,
  );

  return new Promise<number>((resolve, reject) => {
    const proc = spawn('xcodebuild', [
      'test-without-building',
      '-xctestrun',
      xctestrunPath,
      '-destination',
      destination,
      '-parallel-testing-enabled',
      'NO',
      '-test-timeouts-enabled',
      'NO',
    ]);

    let resolved = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        runnerProcesses.delete(destination);
        reject(
          createRunnerStartError(
            `Runner did not emit port within ${timeoutMs}ms`,
            logPath,
            stdoutBuffer,
            stderrBuffer,
          ),
        );
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendLog(logPath, 'stdout', text).catch(() => undefined);
      if (resolved) {
        return;
      }
      stdoutBuffer = appendToBuffer(stdoutBuffer, text);
      const match = PORT_PATTERN.exec(stdoutBuffer);
      if (match?.[1]) {
        resolved = true;
        clearTimeout(timer);
        const port = Number(match[1]);
        runnerProcesses.set(destination, { process: proc, port, logPath });
        appendLog(logPath, 'meta', `runner ready port=${port}\n`).catch(
          () => undefined,
        );
        resolve(port);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer = appendToBuffer(stderrBuffer, text);
      appendLog(logPath, 'stderr', text).catch(() => undefined);
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        runnerProcesses.delete(destination);
        reject(
          createRunnerStartError(
            `Runner process error: ${error.message}`,
            logPath,
            stdoutBuffer,
            stderrBuffer,
          ),
        );
      }
    });

    proc.on('close', (code) => {
      appendLog(logPath, 'meta', `runner close code=${String(code)}\n`).catch(
        () => undefined,
      );
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        runnerProcesses.delete(destination);
        reject(
          createRunnerStartError(
            `Runner exited with code ${code ?? 'unknown'} before emitting port`,
            logPath,
            stdoutBuffer,
            stderrBuffer,
          ),
        );
      }
    });
  });
}

/**
 * Stop a runner process by destination, or all runners if none specified.
 *
 * Sends a graceful shutdown command before killing the process.
 *
 * @param destination - Specific destination to stop, or undefined to stop all.
 */
export async function stopRunner(destination?: string): Promise<void> {
  if (destination) {
    const entry = runnerProcesses.get(destination);
    if (entry) {
      try {
        await fetch(`http://127.0.0.1:${entry.port}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'shutdown' }),
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        /* ignore – best-effort graceful shutdown */
      }
      entry.process.kill();
      runnerProcesses.delete(destination);
    }
  } else {
    await stopAllRunners();
  }
}

/**
 * Stop all active runner processes.
 *
 * Sends a graceful shutdown command to each before killing.
 */
export async function stopAllRunners(): Promise<void> {
  const entries = [...runnerProcesses.entries()];
  for (const [key, entry] of entries) {
    try {
      await fetch(`http://127.0.0.1:${entry.port}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'shutdown' }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* ignore – best-effort graceful shutdown */
    }
    entry.process.kill();
    runnerProcesses.delete(key);
  }
}

/**
 * Poll a health endpoint until the runner is ready or the timeout expires.
 *
 * @param healthCheckFn - Async function that returns true when the runner is healthy.
 *                        Typically `() => xcuiTestClient.healthCheck()`.
 * @param timeoutMs - Maximum time to wait (default: 10000ms)
 * @returns true if the runner became ready, false on timeout
 */
export async function waitForReady(
  healthCheckFn: () => Promise<boolean>,
  timeoutMs: number = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const healthy = await healthCheckFn();
      if (healthy) {
        return true;
      }
    } catch {
      // Health check failed, keep polling
    }

    await new Promise((resolve) =>
      setTimeout(resolve, HEALTH_POLL_INTERVAL_MS),
    );
  }

  return false;
}
