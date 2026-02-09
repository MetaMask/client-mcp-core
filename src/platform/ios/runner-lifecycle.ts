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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

type RunnerEntry = { process: ChildProcess; port: number };
const runnerProcesses = new Map<string, RunnerEntry>();

export type RunnerOptions = {
  derivedDataPath: string;
  destination: string;
  timeoutMs?: number;
};

const PORT_PATTERN = /AGENT_DEVICE_RUNNER_PORT=(\d+)/u;
const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

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

  return new Promise<number>((resolve, reject) => {
    const proc = spawn('xcodebuild', [
      'test-without-building',
      '-xctestrun',
      xctestrunPath,
      '-destination',
      destination,
    ]);

    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        runnerProcesses.delete(destination);
        reject(new Error(`Runner did not emit port within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (resolved) {
        return;
      }
      const text = chunk.toString();
      const match = PORT_PATTERN.exec(text);
      if (match?.[1]) {
        resolved = true;
        clearTimeout(timer);
        const port = Number(match[1]);
        runnerProcesses.set(destination, { process: proc, port });
        resolve(port);
      }
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        runnerProcesses.delete(destination);
        reject(error);
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        runnerProcesses.delete(destination);
        reject(
          new Error(
            `Runner exited with code ${code ?? 'unknown'} before emitting port`,
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
