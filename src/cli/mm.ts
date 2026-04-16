#!/usr/bin/env node
import { cosmiconfig } from 'cosmiconfig';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import pkg from '../../package.json';
import {
  acquireStartupLock,
  isDaemonAlive,
  isDaemonVersionMatch,
  readDaemonState,
  releaseStartupLock,
  removeDaemonState,
} from '../server/daemon-state.js';
import type { DaemonState } from '../types/http.js';

const COMMAND_TIMEOUTS_MS: Record<string, number> = {
  launch: 120_000,
  cleanup: 30_000,
  default: 30_000,
};

const AUTO_START_COMMANDS = new Set(['launch', 'serve']);

const DAEMON_POLL_INTERVAL_MS = 200;
const DAEMON_POLL_MAX_ATTEMPTS = 50; // 50 * 200ms = 10s
const SEND_MAX_RETRIES = 3;
const SEND_RETRY_BASE_DELAY_MS = 200;
const CONFIG_MODULE_NAME = 'mm-client-cli';

/**
 * Configuration shape for mm-client-cli config files.
 * Used in mm-client-cli.config.ts or equivalent.
 */
export type MmClientCliConfig = {
  /** Path to the daemon entry point (TypeScript or JavaScript file). */
  daemon: string;
  /** TypeScript runner to use. Defaults to 'tsx'. */
  runtime?: string;
};

type DaemonConfig = {
  daemonPath: string;
  runtime: string;
};

/**
 * Extracts and consumes the `--project <path>` flag from argv, returning
 * the remaining args and the extracted project path (if any).
 *
 * @param argv - Raw CLI arguments (after the node/script entries).
 * @returns The remaining arguments and the optional project path.
 */
export function extractProjectFlag(argv: string[]): {
  args: string[];
  projectPath: string | undefined;
} {
  const idx = argv.indexOf('--project');
  if (idx < 0) {
    return { args: argv, projectPath: undefined };
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith('--')) {
    process.stderr.write('Error: --project requires a path value\n');
    process.exit(1);
  }
  const remaining = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
  return { args: remaining, projectPath: value };
}

/**
 * Resolves the target project root directory using the following precedence:
 *   1. `--project <path>` CLI flag
 *   2. `MM_PROJECT` environment variable
 *   3. `git rev-parse --show-toplevel` (current working directory)
 *
 * Both explicit sources accept absolute or relative paths (resolved from cwd).
 * The resolved path is normalized via `fs.realpath` to handle symlinks.
 *
 * @param projectFlag - The value of `--project`, if provided.
 * @returns The absolute, real path to the project root.
 */
export async function resolveWorktreeRoot(
  projectFlag: string | undefined,
): Promise<string> {
  const explicit = projectFlag ?? process.env.MM_PROJECT;

  if (explicit) {
    const resolved = path.resolve(process.cwd(), explicit);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch {
      process.stderr.write(`Error: project path does not exist: ${resolved}\n`);
      process.exit(1);
    }

    try {
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) {
        process.stderr.write(
          `Error: project path is not a directory: ${real}\n`,
        );
        process.exit(1);
      }
    } catch {
      process.stderr.write(`Error: cannot access project path: ${real}\n`);
      process.exit(1);
    }

    return real;
  }

  try {
    return execSync('git rev-parse --show-toplevel', {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    process.stderr.write(
      'Error: not in a git repository. Use --project <path> or set MM_PROJECT to target a project.\n',
    );
    return process.exit(1);
  }
}

/**
 * CLI entry point that parses arguments and routes to the appropriate handler.
 */
export async function main(): Promise<void> {
  const { args: remainingArgs, projectPath } = extractProjectFlag(
    process.argv.slice(2),
  );

  if (
    remainingArgs.length === 0 ||
    remainingArgs[0] === '--help' ||
    remainingArgs[0] === '-h'
  ) {
    printHelp();
    process.exit(0);
  }

  const worktreeRoot = await resolveWorktreeRoot(projectPath);
  const args = remainingArgs;
  const command = args[0];

  // mm serve manages daemon lifecycle directly (no discovery needed)
  if (command === 'serve') {
    const background = args.includes('--background');
    await handleServe(worktreeRoot, background);
    return;
  }

  // Discover existing daemon or auto-start for launch
  const daemonState = await discoverDaemon(worktreeRoot, command);

  if (command === 'launch') {
    const launchArgs = parseLaunchArgs(args.slice(1));
    await sendRequest(daemonState.port, 'POST', '/launch', launchArgs);
    return;
  }

  if (command === 'cleanup') {
    const shutdown = args.includes('--shutdown');
    await sendRequest(daemonState.port, 'POST', '/cleanup', {});
    if (shutdown) {
      await shutdownDaemon(worktreeRoot, daemonState);
    }
    return;
  }

  await routeCommand(command, args.slice(1), daemonState.port);
}

/**
 * Resolves `--within` scoping from CLI arguments.
 *
 * @param args - The CLI arguments to scan.
 * @returns A within target object, or undefined if `--within` is absent.
 */
export function resolveWithinFromArgs(
  args: string[],
): { a11yRef: string } | { testId: string } | { selector: string } | undefined {
  const withinIdx = args.indexOf('--within');
  if (withinIdx < 0) {
    return undefined;
  }
  const val = args[withinIdx + 1];
  if (!val || val.startsWith('--')) {
    process.stderr.write('Error: --within requires a value\n');
    process.exit(1);
  }

  // "testid:value" → testId, "selector:value" → selector, otherwise auto-detect
  if (val.startsWith('testid:')) {
    return { testId: val.slice('testid:'.length) };
  }
  if (val.startsWith('selector:')) {
    return { selector: val.slice('selector:'.length) };
  }
  return /^e[0-9]+$/u.test(val) ? { a11yRef: val } : { testId: val };
}

/**
 * Resolves element targeting from CLI arguments. Supports three targeting modes:
 * --selector <css>  → CSS selector (explicit)
 * --testid <id>     → data-testid value (explicit)
 * positional arg    → a11yRef if /^e\d+$/, otherwise testId (auto-detected)
 *
 * @param args - The CLI arguments after the command name.
 * @returns An object with exactly one of `a11yRef`, `testId`, or `selector`.
 */
export function resolveTargetFromArgs(
  args: string[],
): { a11yRef: string } | { testId: string } | { selector: string } {
  const selectorIdx = args.indexOf('--selector');
  if (selectorIdx >= 0) {
    const val = args[selectorIdx + 1];
    if (!val || val.startsWith('--')) {
      process.stderr.write('Error: --selector requires a value\n');
      process.exit(1);
    }
    return { selector: val };
  }

  const testIdIdx = args.indexOf('--testid');
  if (testIdIdx >= 0) {
    const val = args[testIdIdx + 1];
    if (!val || val.startsWith('--')) {
      process.stderr.write('Error: --testid requires a value\n');
      process.exit(1);
    }
    return { testId: val };
  }

  const target = args[0];
  if (!target) {
    process.stderr.write('Error: element target is required\n');
    process.exit(1);
  }
  return /^e[0-9]+$/u.test(target) ? { a11yRef: target } : { testId: target };
}

/**
 * Returns the positional target argument from a CLI args list,
 * skipping any --flag/value pairs.
 *
 * @param args - The CLI arguments to scan.
 * @returns The first non-flag argument, or undefined.
 */
export function getPositionalTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i += 1;
      continue;
    }
    return args[i];
  }
  return undefined;
}

/**
 * Routes a CLI command to the appropriate daemon HTTP endpoint.
 *
 * @param command - The CLI command to route.
 * @param args - Additional arguments for the command.
 * @param port - The daemon HTTP server port.
 */
export async function routeCommand(
  command: string,
  args: string[],
  port: number,
): Promise<void> {
  switch (command) {
    case 'status':
      await sendRequest(port, 'GET', '/status', null);
      break;
    case 'click': {
      const target = getPositionalTarget(args);
      if (
        !target &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        process.stderr.write(
          'Usage: mm click <ref> [--selector <css>] [--testid <id>] [--within <scope>]\n',
        );
        process.exit(1);
      }
      const clickWithin = resolveWithinFromArgs(args);
      await sendRequest(port, 'POST', '/tool/click', {
        ...resolveTargetFromArgs(args),
        ...(clickWithin ? { within: clickWithin } : {}),
      });
      break;
    }
    case 'type': {
      const typeTarget = getPositionalTarget(args);
      if (
        !typeTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        process.stderr.write(
          'Usage: mm type <ref> <text> [--selector <css>] [--testid <id>] [--within <scope>]\n',
        );
        process.exit(1);
      }
      let textArgIdx = 1;
      if (args.includes('--selector')) {
        textArgIdx = args.indexOf('--selector') + 2;
      } else if (args.includes('--testid')) {
        textArgIdx = args.indexOf('--testid') + 2;
      }
      const text = args[textArgIdx] ?? args[1];
      if (text === undefined) {
        process.stderr.write('Usage: mm type <ref> <text>\n');
        process.exit(1);
      }
      const typeWithin = resolveWithinFromArgs(args);
      await sendRequest(port, 'POST', '/tool/type', {
        ...resolveTargetFromArgs(args),
        text,
        ...(typeWithin ? { within: typeWithin } : {}),
      });
      break;
    }
    case 'describe-screen':
      await sendRequest(port, 'POST', '/tool/describe_screen', {});
      break;
    case 'screenshot': {
      const nameIdx = args.indexOf('--name');
      const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
      await sendRequest(port, 'POST', '/tool/screenshot', name ? { name } : {});
      break;
    }
    case 'wait-for': {
      const waitTarget = getPositionalTarget(args);
      if (
        !waitTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        process.stderr.write(
          'Usage: mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]\n',
        );
        process.exit(1);
      }
      const timeoutMs = parseIntFlag(args, '--timeout');
      const waitWithin = resolveWithinFromArgs(args);
      await sendRequest(port, 'POST', '/tool/wait_for', {
        ...resolveTargetFromArgs(args),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(waitWithin ? { within: waitWithin } : {}),
      });
      break;
    }
    case 'navigate':
      if (!args[0]) {
        process.stderr.write('Usage: mm navigate <url>\n');
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/navigate', {
        screen: 'url',
        url: args[0],
      });
      break;
    case 'navigate-home':
      await sendRequest(port, 'POST', '/tool/navigate', { screen: 'home' });
      break;
    case 'navigate-settings':
      await sendRequest(port, 'POST', '/tool/navigate', {
        screen: 'settings',
      });
      break;
    case 'get-state':
      await sendRequest(port, 'POST', '/tool/get_state', {});
      break;
    case 'get-context':
      await sendRequest(port, 'POST', '/tool/get_context', {});
      break;
    case 'set-context':
      if (!args[0] || (args[0] !== 'e2e' && args[0] !== 'prod')) {
        process.stderr.write('Usage: mm set-context <e2e|prod>\n');
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/set_context', {
        context: args[0],
      });
      break;
    case 'build': {
      const buildForce = args.includes('--force');
      await sendRequest(port, 'POST', '/tool/build', {
        ...(buildForce ? { force: true } : {}),
      });
      break;
    }
    case 'wait-for-notification': {
      const notifTimeout = parseIntFlag(args, '--timeout');
      await sendRequest(port, 'POST', '/tool/wait_for_notification', {
        ...(notifTimeout === undefined ? {} : { timeoutMs: notifTimeout }),
      });
      break;
    }
    case 'switch-to-tab': {
      const tabRole = parseStringFlag(args, '--role');
      const tabUrl = parseStringFlag(args, '--url');
      if (!tabRole && !tabUrl) {
        process.stderr.write(
          'Usage: mm switch-to-tab --role <role> | --url <url>\n',
        );
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/switch_to_tab', {
        ...(tabRole ? { role: tabRole } : {}),
        ...(tabUrl ? { url: tabUrl } : {}),
      });
      break;
    }
    case 'close-tab': {
      const closeRole = parseStringFlag(args, '--role');
      const closeUrl = parseStringFlag(args, '--url');
      if (!closeRole && !closeUrl) {
        process.stderr.write(
          'Usage: mm close-tab --role <role> | --url <url>\n',
        );
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/close_tab', {
        ...(closeRole ? { role: closeRole } : {}),
        ...(closeUrl ? { url: closeUrl } : {}),
      });
      break;
    }
    case 'clipboard': {
      const clipAction = args[0];
      if (!clipAction || (clipAction !== 'read' && clipAction !== 'write')) {
        process.stderr.write('Usage: mm clipboard <read|write> [text]\n');
        process.exit(1);
      }
      if (clipAction === 'write' && !args[1]) {
        process.stderr.write('Usage: mm clipboard write <text>\n');
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/clipboard', {
        action: clipAction,
        ...(clipAction === 'write' ? { text: args[1] } : {}),
      });
      break;
    }
    case 'seed-contract': {
      if (!args[0]) {
        process.stderr.write(
          'Usage: mm seed-contract <name> [--hardfork <fork>]\n',
        );
        process.exit(1);
      }
      const hardfork = parseStringFlag(args, '--hardfork');
      await sendRequest(port, 'POST', '/tool/seed_contract', {
        contractName: args[0],
        ...(hardfork ? { hardfork } : {}),
      });
      break;
    }
    case 'seed-contracts': {
      const contractNames = args.filter(
        (a) =>
          !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--hardfork',
      );
      if (contractNames.length === 0) {
        process.stderr.write(
          'Usage: mm seed-contracts <name1> <name2> ... [--hardfork <fork>]\n',
        );
        process.exit(1);
      }
      const seedHardfork = parseStringFlag(args, '--hardfork');
      await sendRequest(port, 'POST', '/tool/seed_contracts', {
        contracts: contractNames,
        ...(seedHardfork ? { hardfork: seedHardfork } : {}),
      });
      break;
    }
    case 'get-contract-address':
      if (!args[0]) {
        process.stderr.write('Usage: mm get-contract-address <name>\n');
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/get_contract_address', {
        contractName: args[0],
      });
      break;
    case 'list-contracts':
      await sendRequest(port, 'POST', '/tool/list_contracts', {});
      break;
    case 'list-testids': {
      const testIdLimit = parseIntFlag(args, '--limit');
      await sendRequest(port, 'POST', '/tool/list_testids', {
        ...(testIdLimit === undefined ? {} : { limit: testIdLimit }),
      });
      break;
    }
    case 'accessibility-snapshot': {
      const rootSelector = parseStringFlag(args, '--root');
      await sendRequest(port, 'POST', '/tool/accessibility_snapshot', {
        ...(rootSelector ? { rootSelector } : {}),
      });
      break;
    }
    case 'knowledge-search':
      if (!args[0]) {
        process.stderr.write('Usage: mm knowledge-search <query>\n');
        process.exit(1);
      }
      await sendRequest(port, 'POST', '/tool/knowledge_search', {
        query: args[0],
      });
      break;
    case 'knowledge-last':
      await sendRequest(port, 'POST', '/tool/knowledge_last', {});
      break;
    case 'knowledge-sessions':
      await sendRequest(port, 'POST', '/tool/knowledge_sessions', {});
      break;
    case 'knowledge-summarize': {
      const summarizeSession = parseStringFlag(args, '--session');
      await sendRequest(port, 'POST', '/tool/knowledge_summarize', {
        ...(summarizeSession ? { scope: { sessionId: summarizeSession } } : {}),
      });
      break;
    }
    case 'run-steps':
      if (!args[0]) {
        process.stderr.write(
          'Usage: mm run-steps \'{"steps":[{"tool":"click","args":{"a11yRef":"e1"}}]}\'\n',
        );
        process.exit(1);
      }
      try {
        await sendRequest(
          port,
          'POST',
          '/tool/run_steps',
          JSON.parse(args[0]) as Record<string, unknown>,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          process.stderr.write(`Error: invalid JSON — ${error.message}\n`);
          process.exit(1);
        }
        /* istanbul ignore next -- non-SyntaxError path depends on delegated failures */
        throw error;
      }
      break;
    default:
      process.stderr.write(
        `Error: unknown command '${command}'. Run 'mm --help' for usage.\n`,
      );
      process.exit(1);
  }
}

/**
 * Checks whether a fetch error is transient and worth retrying.
 * Only network-level failures are retried — HTTP responses (even errors) are not.
 *
 * @param error - The caught error from a fetch attempt.
 * @returns Whether the error is transient.
 */
export function isTransientError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('EPIPE') ||
    message.includes('UND_ERR_SOCKET') ||
    message.includes('fetch failed')
  );
}

/**
 * Sends an HTTP request to the daemon and prints the response.
 * Retries transient network errors (ECONNREFUSED, ECONNRESET, etc.)
 * with linear backoff up to SEND_MAX_RETRIES times.
 *
 * @param port - The daemon HTTP server port.
 * @param method - The HTTP method to use.
 * @param requestPath - The URL path for the request.
 * @param body - The request body payload, or null for no body.
 */
export async function sendRequest(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
): Promise<void> {
  const commandName = requestPath.split('/').pop() ?? '';
  const timeout =
    COMMAND_TIMEOUTS_MS[commandName] ?? COMMAND_TIMEOUTS_MS.default;

  let lastError: unknown;

  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(SEND_RETRY_BASE_DELAY_MS * attempt);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {};
      if (body !== null) {
        headers['Content-Type'] = 'application/json';
      }
      const options: RequestInit = {
        method,
        signal: controller.signal,
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      };
      const response = await fetch(
        `http://127.0.0.1:${port}${requestPath}`,
        options,
      );
      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data.ok === false) {
        const errorData = data.error as { message?: string } | undefined;
        process.stderr.write(
          `Error: ${errorData?.message ?? 'Request failed'}\n`,
        );
        process.exit(1);
      }

      const result = data.result ?? data;
      const observations = data.observations as
        | Record<string, unknown>
        | undefined;
      let output: unknown = result;
      if (observations) {
        const base =
          typeof result === 'object' && result !== null
            ? (result as Record<string, unknown>)
            : { result };
        output = { ...base, observations };
      }
      if (typeof output === 'string') {
        process.stdout.write(`${output}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      }
      return;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        process.stderr.write(`Error: request timed out after ${timeout}ms\n`);
        process.exit(1);
      }

      if (isTransientError(error) && attempt < SEND_MAX_RETRIES) {
        lastError = error;
        continue;
      }

      process.stderr.write(`Error: ${String(error)}\n`);
      process.exit(1);
    } finally {
      clearTimeout(timer);
    }
  }

  process.stderr.write(
    `Error: request failed after ${SEND_MAX_RETRIES + 1} attempts: ${String(lastError)}\n`,
  );
  process.exit(1);
}

/**
 * Discovers a running daemon or auto-starts one for eligible commands.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param command - The CLI command being executed.
 * @returns The daemon state with connection details.
 */
export async function discoverDaemon(
  worktreeRoot: string,
  command: string,
): Promise<DaemonState> {
  let state = await readDaemonState(worktreeRoot);

  if (state) {
    const alive = await isDaemonAlive(state);
    if (alive) {
      if (isDaemonVersionMatch(state)) {
        return state;
      }

      process.stderr.write(
        `Daemon version mismatch (running: ${state.version ?? 'unknown'}, cli: ${pkg.version}). Restarting...\n`,
      );
      await shutdownDaemon(worktreeRoot, state);
      state = null;
    } else {
      await removeDaemonState(worktreeRoot);
      state = null;
    }
  }

  if (!AUTO_START_COMMANDS.has(command)) {
    process.stderr.write(
      'Error: no daemon running. Run `mm launch` to start.\n',
    );
    process.exit(1);
  }

  return autoStartDaemon(worktreeRoot);
}

/**
 * Spawns a new daemon process and waits for it to become ready.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @returns The daemon state once it is alive.
 */
export async function autoStartDaemon(
  worktreeRoot: string,
): Promise<DaemonState> {
  const locked = await acquireStartupLock(worktreeRoot);
  if (!locked) {
    return waitForDaemon(worktreeRoot);
  }

  try {
    const existingState = await readDaemonState(worktreeRoot);
    if (existingState && (await isDaemonAlive(existingState))) {
      return existingState;
    }

    const config = await readDaemonConfig(worktreeRoot);
    const runtimeBin = resolveRuntime(worktreeRoot, config.runtime);

    const child = spawn(runtimeBin, [config.daemonPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: worktreeRoot,
    });
    child.unref();

    return await waitForDaemon(worktreeRoot);
  } finally {
    await releaseStartupLock(worktreeRoot);
  }
}

/**
 * Starts the daemon in foreground or background mode.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param background - Whether to run the daemon as a detached background process.
 */
export async function handleServe(
  worktreeRoot: string,
  background: boolean,
): Promise<void> {
  const existing = await readDaemonState(worktreeRoot);
  if (existing && (await isDaemonAlive(existing))) {
    process.stderr.write(
      `Error: daemon already running on port ${existing.port} (PID ${existing.pid})\n`,
    );
    process.exit(1);
  }

  if (existing) {
    await removeDaemonState(worktreeRoot);
  }

  const config = await readDaemonConfig(worktreeRoot);
  const runtimeBin = resolveRuntime(worktreeRoot, config.runtime);

  if (background) {
    const child = spawn(runtimeBin, [config.daemonPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: worktreeRoot,
    });
    child.unref();

    const state = await waitForDaemon(worktreeRoot);
    process.stdout.write(
      `Daemon started on port ${state.port} (PID ${state.pid})\n`,
    );
    return;
  }

  const child = spawn(runtimeBin, [config.daemonPath], {
    stdio: 'inherit',
    cwd: worktreeRoot,
  });

  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

/**
 * Reads the daemon configuration using cosmiconfig file discovery.
 *
 * Searches for configuration files (e.g., mm-client-cli.config.ts)
 * starting from the worktree root directory.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @returns The daemon path and runtime configuration.
 */
export async function readDaemonConfig(
  worktreeRoot: string,
): Promise<DaemonConfig> {
  const explorer = cosmiconfig(CONFIG_MODULE_NAME, {
    searchPlaces: [
      `${CONFIG_MODULE_NAME}.config.ts`,
      `${CONFIG_MODULE_NAME}.config.js`,
      `${CONFIG_MODULE_NAME}.config.cjs`,
      `${CONFIG_MODULE_NAME}.config.mjs`,
      `.${CONFIG_MODULE_NAME}rc`,
      `.${CONFIG_MODULE_NAME}rc.json`,
      `.${CONFIG_MODULE_NAME}rc.yaml`,
      `.${CONFIG_MODULE_NAME}rc.yml`,
      `.${CONFIG_MODULE_NAME}rc.js`,
      `.${CONFIG_MODULE_NAME}rc.ts`,
      `.${CONFIG_MODULE_NAME}rc.cjs`,
    ],
    stopDir: worktreeRoot,
  });

  const result = await explorer.search(worktreeRoot);

  if (!result || result.isEmpty) {
    process.stderr.write(
      `Error: No mm-client-cli config found. Create ${CONFIG_MODULE_NAME}.config.ts in your project root.\n`,
    );
    process.exit(1);
  }

  const config = result.config as MmClientCliConfig;
  if (!config.daemon) {
    process.stderr.write(
      `Error: No daemon entry point configured. Add 'daemon' to ${result.filepath}.\n`,
    );
    process.exit(1);
  }

  return {
    daemonPath: config.daemon,
    runtime: config.runtime ?? 'tsx',
  };
}

/**
 * Resolves the runtime binary path for spawning the daemon.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param runtime - The runtime name from configuration.
 * @returns The absolute path to the runtime binary.
 */
export function resolveRuntime(worktreeRoot: string, runtime: string): string {
  if (runtime === 'node') {
    return 'node';
  }

  const binPath = path.join(worktreeRoot, 'node_modules', '.bin', runtime);
  if (!existsSync(binPath)) {
    process.stderr.write(
      `Error: Runtime '${runtime}' not found at ${binPath}. Install it or set "mm.runtime" in package.json.\n`,
    );
    process.exit(1);
  }
  return binPath;
}

/**
 * Polls for daemon state until the daemon is alive or times out.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @returns The daemon state once the daemon is responsive.
 */
export async function waitForDaemon(
  worktreeRoot: string,
): Promise<DaemonState> {
  for (let i = 0; i < DAEMON_POLL_MAX_ATTEMPTS; i++) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    const state = await readDaemonState(worktreeRoot);
    if (state && (await isDaemonAlive(state))) {
      return state;
    }
  }
  throw new Error('Daemon failed to start within 10 seconds');
}

/**
 * Terminates the daemon process and removes its state file.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param state - The current daemon state containing the PID.
 */
export async function shutdownDaemon(
  worktreeRoot: string,
  state: DaemonState,
): Promise<void> {
  if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
  }
  await removeDaemonState(worktreeRoot);
}

/**
 * Delays execution for the specified duration.
 *
 * @param ms - The number of milliseconds to wait.
 * @returns A promise that resolves after the delay.
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a numeric flag value from a CLI argument list.
 *
 * @param args - The raw CLI arguments to search.
 * @param flag - The flag name to look for (e.g., '--timeout').
 * @returns The parsed integer value, or undefined if the flag is absent or invalid.
 */
export function parseIntFlag(args: string[], flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return undefined;
  }
  const parsed = parseInt(args[idx + 1], 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Parses a string flag value from a CLI argument list.
 *
 * @param args - The raw CLI arguments to search.
 * @param flag - The flag name to look for (e.g., '--role').
 * @returns The string value, or undefined if the flag is absent.
 */
export function parseStringFlag(
  args: string[],
  flag: string,
): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || !args[idx + 1] || args[idx + 1].startsWith('--')) {
    return undefined;
  }
  return args[idx + 1];
}

/**
 * Parses launch command arguments into a key-value object.
 *
 * @param args - The raw CLI arguments after the command name.
 * @returns The parsed launch options.
 */
export function parseLaunchArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const knownFlags = new Set([
    '--state',
    '--extension-path',
    '--goal',
    '--force',
    '--flow-tags',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') {
      result.force = true;
    } else if (arg === '--state') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        process.stderr.write(
          'Error: --state requires a value (default|onboarding|custom)\n',
        );
        process.exit(1);
      }
      result.stateMode = args[i];
    } else if (arg === '--extension-path') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        process.stderr.write('Error: --extension-path requires a value\n');
        process.exit(1);
      }
      result.extensionPath = args[i];
    } else if (arg === '--goal') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        process.stderr.write('Error: --goal requires a value\n');
        process.exit(1);
      }
      result.goal = args[i];
    } else if (arg === '--flow-tags') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        process.stderr.write(
          'Error: --flow-tags requires a comma-separated value\n',
        );
        process.exit(1);
      }
      result.flowTags = args[i].split(',').map((tag) => tag.trim());
    } else if (arg.startsWith('--') && !knownFlags.has(arg)) {
      process.stderr.write(`Warning: unknown launch flag '${arg}'\n`);
    }
  }
  return result;
}

/**
 * Prints CLI usage information to stdout.
 */
export function printHelp(): void {
  process.stdout.write(`mm — MetaMask CLI

Usage: mm [--project <path>] <command> [options]

Global Options:
  --project <path>    Target a specific project directory (absolute or relative).
                      Overrides MM_PROJECT and git-based discovery.

Environment Variables:
  MM_PROJECT          Default project directory when --project is not provided.
                      Falls back to the current git worktree root.

Lifecycle:
  mm launch [--state default|onboarding|custom] [--extension-path <path>] [--goal <text>] [--force] [--flow-tags <tags>]
  mm cleanup [--shutdown]
  mm status
  mm serve [--background]
  mm build [--force]

Interaction:
  mm click <ref> [--selector <css>] [--testid <id>] [--within <scope>]
  mm type <ref> <text> [--selector <css>] [--testid <id>] [--within <scope>]
  mm describe-screen
  mm screenshot [--name <name>]
  mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]
  mm wait-for-notification [--timeout <ms>]
  mm clipboard <read|write> [text]

Navigation:
  mm navigate <url>
  mm navigate-home
  mm navigate-settings
  mm switch-to-tab --role <role> | --url <url>
  mm close-tab --role <role> | --url <url>

Discovery:
  mm list-testids [--limit <n>]
  mm accessibility-snapshot [--root <selector>]

State & Context:
  mm get-state
  mm get-context
  mm set-context <e2e|prod>

Knowledge:
  mm knowledge-search <query>
  mm knowledge-last
  mm knowledge-sessions
  mm knowledge-summarize [--session <id>]

Contracts (E2E only):
  mm seed-contract <name> [--hardfork <fork>]
  mm seed-contracts <name1> <name2> ... [--hardfork <fork>]
  mm get-contract-address <name>
  mm list-contracts

Batching:
  mm run-steps <json>

Examples:
  mm launch                                          (from inside project)
  mm --project ../metamask-extension launch          (from parent folder)
  MM_PROJECT=/path/to/extension mm describe-screen   (via env var)
`);
}

/* istanbul ignore next -- CLI entry point, tested via exported functions */
/* istanbul ignore next -- top-level fatal handler is not exercised in tests */
const handleFatalCliError = (error: unknown): void => {
  process.stderr.write(`Fatal: ${String(error)}\n`);
  process.exit(1);
};

/* istanbul ignore next -- CLI entry point, tested via exported functions */
if (process.env.VITEST === undefined) {
  main().catch(handleFatalCliError);
}
