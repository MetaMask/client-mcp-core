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
const startupLocks = new Map<string, Promise<number>>();

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
const RUNNER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2000;
const RUNNER_KILL_ESCALATION_TIMEOUT_MS = 3000;

/**
 * Append text to a bounded in-memory log buffer.
 *
 * @param buffer - Existing buffered text.
 * @param text - New text chunk to append.
 * @returns The merged buffer trimmed to the maximum configured size.
 */
function appendToBuffer(buffer: string, text: string): string {
  const merged = buffer + text;
  if (merged.length <= MAX_LOG_BUFFER_CHARS) {
    return merged;
  }
  return merged.slice(-MAX_LOG_BUFFER_CHARS);
}

/**
 * Return the last non-empty lines from a text buffer.
 *
 * @param text - Text buffer to summarize.
 * @param lines - Maximum number of lines to return.
 * @returns Tail text or `<empty>` when no content exists.
 */
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

/**
 * Sanitize an xcodebuild destination for use in a log file name.
 *
 * @param destination - Raw simulator destination string.
 * @returns Filesystem-safe destination label.
 */
function sanitizeDestination(destination: string): string {
  return destination.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120);
}

/**
 * Create the per-run xcodebuild log file path.
 *
 * @param destination - xcodebuild destination string.
 * @param logDir - Optional directory for runner logs.
 * @returns Absolute log file path.
 */
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

/**
 * Append a timestamped runner log chunk to disk.
 *
 * @param logPath - Runner log file path.
 * @param stream - Source stream label for the chunk.
 * @param chunk - Log text to append.
 */
async function appendLog(
  logPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  chunk: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${stream}] `;
  await appendFile(logPath, `${prefix}${chunk}`);
}

/**
 * Build an error with runner log path and recent stdout/stderr tails.
 *
 * @param reason - Human-readable startup failure reason.
 * @param logPath - Full log path for detailed diagnostics.
 * @param stdoutBuffer - Captured stdout buffer.
 * @param stderrBuffer - Captured stderr buffer.
 * @returns Error containing startup diagnostics.
 */
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
 * Remove a tracked runner entry when it still matches the provided process.
 *
 * @param destination - xcodebuild destination key.
 * @param process - Optional child process expected for the entry.
 */
function deleteRunnerEntry(destination: string, process?: ChildProcess): void {
  const current = runnerProcesses.get(destination);
  if (!current) {
    return;
  }
  if (!process || current.process === process) {
    runnerProcesses.delete(destination);
  }
}

/**
 * Ask a runner to shut down via its HTTP command endpoint.
 *
 * @param entry - Tracked runner process and port.
 */
async function sendShutdownCommand(entry: RunnerEntry): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${entry.port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'shutdown' }),
      signal: AbortSignal.timeout(RUNNER_GRACEFUL_SHUTDOWN_TIMEOUT_MS),
    });
  } catch {
    /* ignore – best-effort graceful shutdown */
  }
}

/**
 * Terminate a runner process, escalating from SIGTERM to SIGKILL if needed.
 *
 * @param entry - Tracked runner process to stop.
 * @param destination - Destination key associated with the runner.
 */
async function killProcessWithEscalation(
  entry: RunnerEntry,
  destination: string,
): Promise<void> {
  const proc = entry.process;

  if (proc.exitCode !== null || proc.signalCode !== null) {
    deleteRunnerEntry(destination, proc);
    return;
  }

  await new Promise<void>((resolve) => {
    const escalationTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* process may already have exited */
      }
    }, RUNNER_KILL_ESCALATION_TIMEOUT_MS);

    proc.once('close', () => {
      clearTimeout(escalationTimer);
      deleteRunnerEntry(destination, proc);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(escalationTimer);
      deleteRunnerEntry(destination, proc);
      resolve();
    }
  });
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
  registerCleanupHandlers();

  const { destination } = options;
  const existing = startupLocks.get(destination);
  if (existing) {
    return existing;
  }

  const promise = startRunnerImpl(options).finally(() => {
    startupLocks.delete(destination);
  });
  startupLocks.set(destination, promise);
  return promise;
}

/**
 * Start a new runner process after build artifacts have been prepared.
 *
 * @param options - Runner startup options including DerivedData and destination.
 * @returns Port emitted by the runner when it becomes ready.
 */
async function startRunnerImpl(options: RunnerOptions): Promise<number> {
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

    // Track the process immediately so stopRunner/stopAllRunners can
    // kill it during the startup window before port emission.
    runnerProcesses.set(destination, { process: proc, port: 0, logPath });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const error = createRunnerStartError(
          `Runner did not emit port within ${timeoutMs}ms`,
          logPath,
          stdoutBuffer,
          stderrBuffer,
        );
        // Escalated kill (SIGTERM → wait → SIGKILL) to prevent orphaned
        // xcodebuild processes. The runner hasn't been registered yet
        // (port never received), so use a temporary entry.
        const entry: RunnerEntry = { process: proc, port: 0, logPath };
        killProcessWithEscalation(entry, destination)
          .catch(() => undefined)
          .finally(() => reject(error));
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
        deleteRunnerEntry(destination, proc);
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
      deleteRunnerEntry(destination, proc);
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
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
      await sendShutdownCommand(entry);
      await killProcessWithEscalation(entry, destination);
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
    await sendShutdownCommand(entry);
    await killProcessWithEscalation(entry, key);
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

let _cleanupRegistered = false;

/**
 * Register process signal handlers to prevent zombie xcodebuild processes.
 *
 * Idempotent — safe to call multiple times. Automatically called by startRunner().
 * SIGINT/SIGTERM: graceful stopAllRunners() then re-raise.
 * exit: synchronous SIGKILL (cannot await in exit handler).
 */
export function registerCleanupHandlers(): void {
  if (_cleanupRegistered) {
    return;
  }
  _cleanupRegistered = true;

  let shutdownStarted = false;

  const gracefulShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    stopAllRunners()
      .catch(() => undefined)
      .finally(() => {
        process.kill(process.pid, signal);
      });
  };

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('exit', () => {
    for (const [destination, entry] of runnerProcesses.entries()) {
      try {
        if (
          entry.process.exitCode === null &&
          entry.process.signalCode === null
        ) {
          entry.process.kill('SIGKILL');
        }
      } catch {
        /* best-effort */
      }
      runnerProcesses.delete(destination);
    }
  });
}
