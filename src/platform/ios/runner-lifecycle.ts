/**
 * XCUITest runner lifecycle management.
 *
 * Handles starting and stopping the xcodebuild test runner process,
 * which hosts the agent-device HTTP server inside the iOS test runner.
 *
 * The runner outputs `AGENT_DEVICE_RUNNER_PORT=<port>` on stdout when ready.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

let runnerProcess: ChildProcess | undefined;

export type RunnerOptions = {
  derivedDataPath: string;
  destination: string;
  timeoutMs?: number;
};

const PORT_PATTERN = /AGENT_DEVICE_RUNNER_PORT=(\d+)/u;
const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

async function findXctestrunFile(derivedDataPath: string): Promise<string> {
  const buildProductsDir = join(derivedDataPath, 'Build', 'Products');
  const files = await readdir(buildProductsDir);
  const xctestrunFile = files.find((f) => f.endsWith('.xctestrun'));

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
 * @throws If the runner does not emit a port within the timeout
 * @throws If the runner process exits before emitting a port
 * @throws If no .xctestrun file is found in derivedDataPath
 */
export async function startRunner(options: RunnerOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const xctestrunPath = await findXctestrunFile(options.derivedDataPath);

  return new Promise<number>((resolve, reject) => {
    const proc = spawn('xcodebuild', [
      'test-without-building',
      '-xctestrun',
      xctestrunPath,
      '-destination',
      options.destination,
    ]);

    runnerProcess = proc;

    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
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
        resolve(Number(match[1]));
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `Runner exited with code ${code ?? 'unknown'} before emitting port`,
          ),
        );
      }
    });
  });
}

export function stopRunner(): void {
  if (runnerProcess) {
    runnerProcess.kill();
    runnerProcess = undefined;
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
