#!/usr/bin/env node
import { cosmiconfig } from 'cosmiconfig';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import pkg from '../../package.json';
import {
  acquireStartupLock,
  isDaemonAlive,
  isDaemonVersionMatch,
  readDaemonState,
  releaseStartupLock,
  removeDaemonState,
} from '../server/daemon-state.js';
import {
  defaultHintForError,
  ErrorCodes,
  exitCodeForError,
  isRetryableError,
} from '../tools/types/errors.js';
import { BEST_EFFORT_CLEANUP_TIMEOUT_MS } from '../tools/utils/constants.js';
import type { DaemonState } from '../types/http.js';
import { computeTimeoutBudget } from '../utils/timeout-budget.js';
import { OBSERVE_LEVELS } from '../validation/observe-level.js';
import type { ObserveLevel } from '../validation/observe-level.js';

const COMMAND_TIMEOUTS_MS: Record<string, number> = {
  launch: 120_000,
  cleanup: 30_000,
  cdp: 35_000,
  default: 30_000,
};

const AUTO_START_COMMANDS = new Set(['launch', 'serve']);

const DAEMON_POLL_INTERVAL_MS = 200;
const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MAX_ATTEMPTS =
  DAEMON_START_TIMEOUT_MS / DAEMON_POLL_INTERVAL_MS;
const SEND_MAX_RETRIES = 3;
const SEND_RETRY_BASE_DELAY_MS = 200;
const CONFIG_MODULE_NAME = 'mm-client-cli';
const SUPPORTED_RUNTIMES = new Set(['node', 'tsx']);

/**
 * Configuration shape for mm-client-cli config files.
 * Used in mm-client-cli.config.ts or equivalent.
 */
export type MmClientCliConfig = {
  /** Path to the daemon entry point (TypeScript or JavaScript file). */
  daemon: string;
  /** Runtime used to start the daemon. Defaults to 'tsx'. */
  runtime?: 'node' | 'tsx';
};

type DaemonConfig = {
  daemonPath: string;
  runtime: 'node' | 'tsx';
};

type RuntimeCommand = {
  command: string;
  getArgs: (daemonPath: string) => string[];
};

/**
 * An error with a code, thrown by the CLI or rebuilt from a daemon error
 * response. {@link fail} prints it.
 */
export class CliError extends Error {
  readonly code: string;

  readonly hint: string | undefined;

  readonly meta: unknown;

  /**
   * @param code - The error code (an `ErrorCodes` value, a daemon code or a
   * consumer `MM_*` code).
   * @param message - A human-readable description.
   * @param options - Optional details.
   * @param options.hint - What to do next.
   * @param options.meta - The daemon's request timing, when it answered.
   */
  constructor(
    code: string,
    message: string,
    options?: { hint?: string; meta?: unknown },
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = options?.hint;
    this.meta = options?.meta;
  }
}

/**
 * Ends the CLI with a failure: prints one JSON line on stdout,
 * `{"ok":false,"error":{"code","message","hint"?,"retryable"},"meta"?}`, and
 * exits with the code that {@link exitCodeForError} gives for `code`. On a
 * terminal stderr it also prints `Error: <message>` for the human reader.
 * Every non-zero exit of the CLI goes through this function.
 *
 * @param code - The error code.
 * @param message - A human-readable description.
 * @param options - Optional details.
 * @param options.hint - What to do next. Defaults to the code's default hint.
 * @param options.meta - The daemon's request timing, when it answered.
 * @returns Never; the process exits.
 */
export function fail(
  code: string,
  message: string,
  options?: { hint?: string; meta?: unknown },
): never {
  const hint = options?.hint ?? defaultHintForError(code);
  const body = {
    ok: false,
    error: {
      code,
      message,
      ...(hint === undefined ? {} : { hint }),
      retryable: isRetryableError(code),
    },
    ...(options?.meta === undefined ? {} : { meta: options.meta }),
  };
  process.stdout.write(`${formatJsonOutput(body)}\n`);
  if (process.stderr.isTTY) {
    process.stderr.write(`Error: ${message}\n`);
  }
  return process.exit(exitCodeForError(code));
}

/**
 * Ends the CLI with a usage or validation failure (`MM_INVALID_INPUT`,
 * exit 2).
 *
 * @param message - What is wrong, or the usage line.
 * @returns Never; the process exits.
 */
export function failUsage(message: string): never {
  return fail(ErrorCodes.MM_INVALID_INPUT, message);
}

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
    failUsage('--project requires a path value');
  }
  const remaining = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
  return { args: remaining, projectPath: value };
}

/**
 * Extracts and consumes the global `--observe <none|diff|full>` flag from
 * argv, returning the remaining args and the level (if any).
 *
 * @param argv - Raw CLI arguments (after the node/script entries).
 * @returns The remaining arguments and the optional observe level.
 */
export function extractObserveFlag(argv: string[]): {
  args: string[];
  observe: ObserveLevel | undefined;
} {
  const idx = argv.indexOf('--observe');
  if (idx < 0) {
    return { args: argv, observe: undefined };
  }
  const value = argv[idx + 1];
  if (!OBSERVE_LEVELS.includes(value as ObserveLevel)) {
    failUsage(`--observe requires one of: ${OBSERVE_LEVELS.join(', ')}`);
  }
  const remaining = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
  return { args: remaining, observe: value as ObserveLevel };
}

let globalObserveLevel: ObserveLevel | undefined;

/**
 * Sets the `--observe` level that {@link sendRequest} adds to every tool,
 * `/launch` and `/cleanup` request body.
 *
 * @param level - The level, or undefined to send none (daemon default).
 */
export function setObserveLevel(level: ObserveLevel | undefined): void {
  globalObserveLevel = level;
}

/**
 * Adds the global `--observe` level to a request body. Only POST requests to
 * `/tool/*`, `/launch` and `/cleanup` with a plain-object body get it, and an
 * `observe` already in the body (e.g. in `run-steps` JSON) is kept.
 *
 * @param method - The HTTP method.
 * @param requestPath - The URL path.
 * @param body - The request body.
 * @returns The body, with `observe` added when it applies.
 */
export function applyObserveLevel(
  method: string,
  requestPath: string,
  body: unknown,
): unknown {
  if (
    globalObserveLevel === undefined ||
    method !== 'POST' ||
    !(
      requestPath.startsWith('/tool/') ||
      requestPath === '/launch' ||
      requestPath === '/cleanup'
    ) ||
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) {
    return body;
  }
  return { observe: globalObserveLevel, ...(body as Record<string, unknown>) };
}

/**
 * Extracts and consumes the global `--pretty` flag (every occurrence) from
 * argv.
 *
 * @param argv - Raw CLI arguments (after the node/script entries).
 * @returns The remaining arguments and whether `--pretty` was given.
 */
export function extractPrettyFlag(argv: string[]): {
  args: string[];
  pretty: boolean;
} {
  const args = argv.filter((arg) => arg !== '--pretty');
  return { args, pretty: args.length !== argv.length };
}

/**
 * Decides whether JSON output is indented. Agents read stdout through a pipe
 * and pay for every byte, so the default there is one line per result.
 * Precedence: `--pretty`, then `MM_PRETTY` (`1`/`true` = pretty, `0`/`false`
 * = compact), then pretty only when stdout is a terminal.
 *
 * @param flag - Whether `--pretty` was given.
 * @param env - The `MM_PRETTY` value.
 * @param isTTY - Whether stdout is a terminal.
 * @returns True to indent JSON output.
 */
export function resolvePretty(
  flag: boolean,
  env: string | undefined,
  isTTY: boolean | undefined,
): boolean {
  if (flag) {
    return true;
  }
  const value = env?.trim().toLowerCase();
  if (value === '1' || value === 'true') {
    return true;
  }
  if (value === '0' || value === 'false') {
    return false;
  }
  return isTTY === true;
}

let prettyOutput = false;

/**
 * Sets whether {@link formatJsonOutput} indents JSON.
 *
 * @param pretty - True to indent with 2 spaces.
 */
export function setPrettyOutput(pretty: boolean): void {
  prettyOutput = pretty;
}

/**
 * Serializes a CLI result for stdout: one line by default, indented with 2
 * spaces when pretty output is on (see {@link resolvePretty}).
 *
 * @param output - The value to print.
 * @returns The JSON text, without a trailing newline.
 */
export function formatJsonOutput(output: unknown): string {
  return prettyOutput
    ? JSON.stringify(output, null, 2)
    : JSON.stringify(output);
}

/**
 * Finds the git worktree root without starting a `git` process (about 90 ms
 * per call): walks up from the real cwd to the first directory that has a
 * `.git` entry. `.git` is a directory in a main checkout and a file in a
 * linked worktree or submodule; both count.
 *
 * @returns The worktree root, or undefined when no `.git` entry is found or
 * `GIT_DIR` / `GIT_WORK_TREE` override git's own discovery.
 */
export async function findGitWorktreeRoot(): Promise<string | undefined> {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) {
    return undefined;
  }
  let dir: string;
  try {
    dir = await fs.realpath(process.cwd());
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }
}

/**
 * Resolves the target project root directory using the following precedence:
 *   1. `--project <path>` CLI flag
 *   2. `MM_PROJECT` environment variable
 *   3. the git worktree root of the current working directory: the nearest
 *      `.git` entry (see {@link findGitWorktreeRoot}), else
 *      `git rev-parse --show-toplevel`
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
      failUsage(`project path does not exist: ${resolved}`);
    }

    try {
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) {
        failUsage(`project path is not a directory: ${real}`);
      }
    } catch {
      failUsage(`cannot access project path: ${real}`);
    }

    return real;
  }

  const found = await findGitWorktreeRoot();
  if (found) {
    return found;
  }

  try {
    return execSync('git rev-parse --show-toplevel', {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    return failUsage(
      'not in a git repository. Use --project <path> or set MM_PROJECT to target a project.',
    );
  }
}

/**
 * CLI entry point that parses arguments and routes to the appropriate handler.
 */
export async function main(): Promise<void> {
  const { args: projectlessArgs, projectPath } = extractProjectFlag(
    process.argv.slice(2),
  );
  const { args: observelessArgs, observe } =
    extractObserveFlag(projectlessArgs);
  setObserveLevel(observe);
  const { args: remainingArgs, pretty } = extractPrettyFlag(observelessArgs);
  setPrettyOutput(
    resolvePretty(pretty, process.env.MM_PRETTY, process.stdout.isTTY),
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

  if (command === 'serve') {
    const background = args.includes('--background');
    await handleServe(worktreeRoot, background);
    return;
  }

  if (command === 'stop') {
    const force = args.includes('--force');
    await handleStop(worktreeRoot, force);
    return;
  }

  const daemonState = await discoverDaemon(worktreeRoot, command);

  if (command === 'launch') {
    const launchArgs = parseLaunchArgs(args.slice(1));
    if (typeof launchArgs.extensionPath === 'string') {
      launchArgs.extensionPath = path.resolve(
        worktreeRoot,
        launchArgs.extensionPath,
      );
    }
    if (launchArgs.selfOnboarding === true) {
      Object.assign(launchArgs, await readSelfOnboardingInput(process.stdin));
    }
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
    failUsage('--within requires a value');
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
      failUsage('--selector requires a value');
    }
    return { selector: val };
  }

  const testIdIdx = args.indexOf('--testid');
  if (testIdIdx >= 0) {
    const val = args[testIdIdx + 1];
    if (!val || val.startsWith('--')) {
      failUsage('--testid requires a value');
    }
    return { testId: val };
  }

  const target = getPositionalTarget(args);
  if (!target) {
    failUsage('element target is required');
  }
  return /^e[0-9]+$/u.test(target) ? { a11yRef: target } : { testId: target };
}

/** Interaction flags that consume the next token as their value. */
const VALUE_FLAGS = new Set([
  '--timeout',
  '--selector',
  '--testid',
  '--within',
  '--direction',
  '--maxAttempts',
  '--duration',
  '--distance',
  '--startX',
  '--startY',
  '--x',
  '--y',
]);

/**
 * Returns the positional target argument from a CLI args list,
 * skipping only known --flag/value pairs.  Unknown tokens that
 * start with `--` are treated as positional arguments so that
 * user-supplied text like `"--seed"` is not silently consumed.
 *
 * @param args - The CLI arguments to scan.
 * @returns The first non-flag argument, or undefined.
 */
export function getPositionalTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    return args[i];
  }
  return undefined;
}

/**
 * Returns all positional arguments from a CLI args list,
 * skipping only known --flag/value pairs.  Unknown tokens that
 * start with `--` are treated as positional arguments so that
 * user-supplied text like `"--seed"` is not silently consumed.
 *
 * @param args - The CLI arguments to scan.
 * @returns The non-flag arguments, in order.
 */
export function getPositionalArgs(args: string[]): string[] {
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    positionalArgs.push(args[i]);
  }

  return positionalArgs;
}

/**
 * Sends an interaction tool request with optional timeout and within scope.
 *
 * @param port - The daemon HTTP server port.
 * @param toolPath - The tool endpoint path (e.g. '/tool/click').
 * @param args - The CLI arguments for flag parsing.
 * @param extraBody - Additional body fields to merge into the request.
 */
async function sendInteractionRequest(
  port: number,
  toolPath: string,
  args: string[],
  extraBody?: Record<string, unknown>,
): Promise<void> {
  const timeoutMs = parseIntFlag(args, '--timeout');
  const within = resolveWithinFromArgs(args);

  const body: Record<string, unknown> = {
    ...resolveTargetFromArgs(args),
    ...extraBody,
  };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  if (within) {
    body.within = within;
  }

  await sendRequest(
    port,
    'POST',
    toolPath,
    body,
    timeoutMs === undefined
      ? undefined
      : { requestTimeoutMs: computeTimeoutBudget(timeoutMs).http },
  );
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
        failUsage(
          'Usage: mm click <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>] [--dismiss-keyboard]',
        );
      }
      await sendInteractionRequest(
        port,
        '/tool/click',
        args.filter((arg) => arg !== '--dismiss-keyboard'),
        args.includes('--dismiss-keyboard')
          ? { dismissKeyboard: true }
          : undefined,
      );
      break;
    }
    case 'type': {
      const typeTarget = getPositionalTarget(args);
      const typePositionals = getPositionalArgs(args);
      const hasExplicitTypeTarget =
        args.includes('--selector') || args.includes('--testid');
      if (
        !typeTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        failUsage(
          'Usage: mm type <ref> <text> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]',
        );
      }
      const text = hasExplicitTypeTarget
        ? typePositionals[0]
        : typePositionals[1];
      if (text === undefined) {
        failUsage('Usage: mm type <ref> <text>');
      }
      await sendInteractionRequest(port, '/tool/type', args, { text });
      break;
    }
    case 'get-text': {
      const getTextTarget = getPositionalTarget(args);
      if (
        !getTextTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        failUsage(
          'Usage: mm get-text <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]',
        );
      }
      await sendInteractionRequest(port, '/tool/get_text', args);
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
        failUsage(
          'Usage: mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]',
        );
      }
      await sendInteractionRequest(port, '/tool/wait_for', args);
      break;
    }
    case 'navigate':
      if (!args[0]) {
        failUsage('Usage: mm navigate <url>');
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
        failUsage('Usage: mm set-context <e2e|prod>');
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
      // Support positional arg as role: mm switch-to-tab dapp
      const positionalRole =
        !tabRole && !tabUrl ? getPositionalTarget(args) : undefined;
      const resolvedRole = tabRole ?? positionalRole;
      if (!resolvedRole && !tabUrl) {
        failUsage(
          'Usage: mm switch-to-tab <role> | --role <role> | --url <url>',
        );
      }
      await sendRequest(port, 'POST', '/tool/switch_to_tab', {
        ...(resolvedRole ? { role: resolvedRole } : {}),
        ...(tabUrl ? { url: tabUrl } : {}),
      });
      break;
    }
    case 'close-tab': {
      const closeRole = parseStringFlag(args, '--role');
      const closeUrl = parseStringFlag(args, '--url');
      if (!closeRole && !closeUrl) {
        failUsage('Usage: mm close-tab --role <role> | --url <url>');
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
        failUsage('Usage: mm clipboard <read|write> [text]');
      }
      if (clipAction === 'write' && !args[1]) {
        failUsage('Usage: mm clipboard write <text>');
      }
      await sendRequest(port, 'POST', '/tool/clipboard', {
        action: clipAction,
        ...(clipAction === 'write' ? { text: args[1] } : {}),
      });
      break;
    }
    case 'seed-contract': {
      if (!args[0]) {
        failUsage('Usage: mm seed-contract <name> [--hardfork <fork>]');
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
        failUsage(
          'Usage: mm seed-contracts <name1> <name2> ... [--hardfork <fork>]',
        );
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
        failUsage('Usage: mm get-contract-address <name>');
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
    case 'run-steps':
      if (!args[0]) {
        failUsage(
          'Usage: mm run-steps \'{"steps":[{"tool":"click","args":{"a11yRef":"e1"}}]}\'',
        );
      }
      await sendRequest(
        port,
        'POST',
        '/tool/run_steps',
        parseJsonArgument(args[0], 'run-steps') as Record<string, unknown>,
      );
      break;
    case 'mock-network': {
      await routeMockNetworkCommand(args, port);
      break;
    }
    case 'cdp': {
      const cdpMethod = args[0];
      if (!cdpMethod) {
        failUsage(
          'Usage: mm cdp <method> [params-json] [--timeout <ms>] [--target hermes|android-webview] [--url-filter <substr>] [--metro-port <port>] [--app-id <id>]\n' +
            '  mm cdp Runtime.evaluate \'{"expression":"document.title"}\'\n' +
            '  mm cdp Network.enable\n' +
            '  mm cdp DOM.getDocument \'{"depth":2}\' --timeout 60000\n' +
            '  # mobile (Hermes): --metro-port / --app-id override the Metro target\n' +
            '  mm cdp Runtime.evaluate \'{"expression":"1+1","returnByValue":true}\' --app-id io.metamask\n' +
            '  # mobile (Android WebView): drive the in-app browser DOM\n' +
            '  mm cdp Runtime.evaluate \'{"expression":"document.title"}\' --target android-webview',
        );
      }
      const cdpTimeout = parseIntFlag(args, '--timeout');
      const cdpMetroPort = parseIntFlag(args, '--metro-port');
      const cdpAppId = parseStringFlag(args, '--app-id');
      const cdpTarget = parseStringFlag(args, '--target');
      const cdpUrlFilter = parseStringFlag(args, '--url-filter');
      if (
        cdpTarget !== undefined &&
        cdpTarget !== 'hermes' &&
        cdpTarget !== 'android-webview'
      ) {
        failUsage('--target must be "hermes" or "android-webview"');
      }
      const cdpParamsRaw =
        args[1] !== undefined && !args[1].startsWith('--')
          ? args[1]
          : undefined;
      let cdpParams: Record<string, unknown> | undefined;
      if (cdpParamsRaw) {
        try {
          const parsed: unknown = JSON.parse(cdpParamsRaw);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new TypeError('params must be a plain object');
          }
          cdpParams = parsed as Record<string, unknown>;
        } catch {
          failUsage(`invalid JSON params — expected a JSON object`);
        }
      }
      await sendRequest(port, 'POST', '/tool/cdp', {
        method: cdpMethod,
        ...(cdpParams ? { params: cdpParams } : {}),
        ...(cdpTimeout === undefined ? {} : { timeoutMs: cdpTimeout }),
        ...(cdpMetroPort === undefined ? {} : { metroPort: cdpMetroPort }),
        ...(cdpAppId ? { appId: cdpAppId } : {}),
        ...(cdpTarget ? { target: cdpTarget } : {}),
        ...(cdpUrlFilter ? { urlFilter: cdpUrlFilter } : {}),
      });
      break;
    }
    case 'hermes-targets': {
      const targetsMetroPort = parseIntFlag(args, '--metro-port');
      const targetsAppId = parseStringFlag(args, '--app-id');
      const targetsAll = args.includes('--all');
      await sendRequest(port, 'POST', '/tool/hermes_targets', {
        ...(targetsMetroPort === undefined
          ? {}
          : { metroPort: targetsMetroPort }),
        ...(targetsAppId ? { appId: targetsAppId } : {}),
        ...(targetsAll ? { all: true } : {}),
      });
      break;
    }
    case 'scroll-to-element': {
      const scrollTarget = getPositionalTarget(args);
      if (
        !scrollTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        failUsage(
          'Usage: mm scroll-to-element <ref> [--selector <css>] [--testid <id>] [--direction auto|down|up] [--maxAttempts <n>]',
        );
      }
      const scrollDirection = parseStringFlag(args, '--direction');
      const scrollMaxAttempts = parseIntFlag(args, '--maxAttempts');
      await sendInteractionRequest(port, '/tool/scroll_to_element', args, {
        ...(scrollDirection ? { direction: scrollDirection } : {}),
        ...(scrollMaxAttempts === undefined
          ? {}
          : { maxAttempts: scrollMaxAttempts }),
      });
      break;
    }
    case 'device-swipe': {
      const swipeDirection =
        parseStringFlag(args, '--direction') ?? getPositionalTarget(args);
      if (!swipeDirection) {
        failUsage(
          'Usage: mm device-swipe <up|down|left|right> [--startX <n>] [--startY <n>] [--distance <n>]',
        );
      }
      const swipeStartX = parseIntFlag(args, '--startX');
      const swipeStartY = parseIntFlag(args, '--startY');
      const swipeDistance = parseIntFlag(args, '--distance');
      await sendRequest(port, 'POST', '/tool/device_swipe', {
        direction: swipeDirection,
        ...(swipeStartX === undefined ? {} : { startX: swipeStartX }),
        ...(swipeStartY === undefined ? {} : { startY: swipeStartY }),
        ...(swipeDistance === undefined ? {} : { distance: swipeDistance }),
      });
      break;
    }
    case 'long-press': {
      const longPressTarget = getPositionalTarget(args);
      if (
        !longPressTarget &&
        !args.includes('--selector') &&
        !args.includes('--testid')
      ) {
        failUsage(
          'Usage: mm long-press <ref> [--selector <css>] [--testid <id>] [--duration <ms>]',
        );
      }
      const pressDuration = parseIntFlag(args, '--duration');
      await sendInteractionRequest(port, '/tool/long_press', args, {
        ...(pressDuration === undefined ? {} : { durationMs: pressDuration }),
      });
      break;
    }
    case 'tap-coordinates': {
      const tapPositionals = getPositionalArgs(args);
      const tapXFlag = parseIntFlag(args, '--x');
      const tapYFlag = parseIntFlag(args, '--y');
      const tapX = tapXFlag ?? parseInt(tapPositionals[0], 10);
      const tapY = tapYFlag ?? parseInt(tapPositionals[1], 10);
      if (Number.isNaN(tapX) || Number.isNaN(tapY)) {
        failUsage('Usage: mm tap-coordinates <x> <y>');
      }
      await sendRequest(port, 'POST', '/tool/tap_coordinates', {
        x: tapX,
        y: tapY,
      });
      break;
    }
    case 'dismiss-keyboard':
      await sendRequest(port, 'POST', '/tool/dismiss_keyboard', {});
      break;
    case 'dismiss-alert':
      await sendRequest(port, 'POST', '/tool/dismiss_alert', {
        accept: args.includes('--accept'),
      });
      break;
    case 'get-alert-text':
      await sendRequest(port, 'POST', '/tool/get_alert_text', {});
      break;
    case 'open-app':
      if (!args[0]) {
        failUsage('Usage: mm open-app <bundleId>');
      }
      await sendRequest(port, 'POST', '/tool/open_app', { bundleId: args[0] });
      break;
    case 'close-app':
      if (!args[0]) {
        failUsage('Usage: mm close-app <bundleId>');
      }
      await sendRequest(port, 'POST', '/tool/close_app', { bundleId: args[0] });
      break;
    case 'press-button':
      if (!args[0]) {
        failUsage('Usage: mm press-button <button>');
      }
      await sendRequest(port, 'POST', '/tool/press_button', {
        button: args[0],
      });
      break;
    case 'device-context': {
      const ctxAction = args[0];
      if (!ctxAction || (ctxAction !== 'list' && ctxAction !== 'switch')) {
        failUsage('Usage: mm device-context <list|switch> [name]');
      }
      if (ctxAction === 'switch' && !args[1]) {
        failUsage('Usage: mm device-context switch <name>');
      }
      await sendRequest(port, 'POST', '/tool/device_context', {
        action: ctxAction,
        ...(ctxAction === 'switch' ? { name: args[1] } : {}),
      });
      break;
    }
    case 'device-clipboard': {
      const devClipAction = args[0];
      if (
        !devClipAction ||
        (devClipAction !== 'read' && devClipAction !== 'write')
      ) {
        failUsage('Usage: mm device-clipboard <read|write> [text]');
      }
      if (devClipAction === 'write' && !args[1]) {
        failUsage('Usage: mm device-clipboard write <text>');
      }
      await sendRequest(port, 'POST', '/tool/device_clipboard', {
        action: devClipAction,
        ...(devClipAction === 'write' ? { text: args[1] } : {}),
      });
      break;
    }
    case 'screen-recording': {
      const recAction = args[0];
      if (!recAction || (recAction !== 'start' && recAction !== 'stop')) {
        failUsage('Usage: mm screen-recording <start|stop> [--output <path>]');
      }
      const recOutput = parseStringFlag(args, '--output');
      await sendRequest(port, 'POST', '/tool/screen_recording', {
        action: recAction,
        ...(recAction === 'start' && recOutput
          ? { outputPath: recOutput }
          : {}),
      });
      break;
    }
    case 'device-logs': {
      const logsDuration = parseIntFlag(args, '--duration');
      const logsFilter = parseStringFlag(args, '--filter');
      await sendRequest(port, 'POST', '/tool/device_logs', {
        ...(logsDuration === undefined
          ? {}
          : { durationSeconds: logsDuration }),
        ...(logsFilter ? { filter: logsFilter } : {}),
      });
      break;
    }
    case 'generate-locators':
      await sendRequest(port, 'POST', '/tool/generate_locators', {});
      break;
    default:
      failUsage(`unknown command '${command}'. Run 'mm --help' for usage.`);
  }
}

/**
 * Routes mock-network subcommands to the daemon.
 *
 * @param args - CLI arguments after `mock-network`.
 * @param port - The daemon HTTP server port.
 */
export async function routeMockNetworkCommand(
  args: string[],
  port: number,
): Promise<void> {
  const action = args[0];

  if (action === 'add') {
    const rawRule = args[1];
    if (!rawRule) {
      failUsage("Usage: mm mock-network add '<json-rule-or-config>'");
    }

    const parsed = parseJsonArgument(rawRule, 'mock-network add');
    await sendRequest(port, 'POST', '/tool/mock_network', {
      action: 'add',
      ...normalizeMockNetworkAddPayload(parsed),
    });
    return;
  }

  if (action === 'clear') {
    await sendRequest(port, 'POST', '/tool/mock_network', { action: 'clear' });
    return;
  }

  if (action === 'list') {
    await sendRequest(port, 'POST', '/tool/mock_network', { action: 'list' });
    return;
  }

  if (action === 'requests') {
    const limit = parseIntFlag(args, '--limit');
    await sendRequest(port, 'POST', '/tool/mock_network', {
      action: 'requests',
      ...(limit === undefined ? {} : { limit }),
    });
    return;
  }

  failUsage('Usage: mm mock-network <add|clear|list|requests> [options]');
}

/**
 * Checks whether a failed request is safe to send again: only a refused
 * connection (`ECONNREFUSED`), because the daemon never accepted the request.
 * A reset, broken pipe or socket error can come after the daemon got the
 * request, so a resend could run a click twice; those are not retried.
 * HTTP responses (even errors) are never retried.
 *
 * @param error - The caught error from a fetch attempt.
 * @returns Whether the request can be sent again.
 */
export function isTransientError(error: unknown): boolean {
  const inner = (error as { cause?: { errors?: unknown } } | null | undefined)
    ?.cause?.errors;
  // `localhost` can resolve to several addresses; Node then reports an
  // AggregateError. Retry only when every address refused.
  if (Array.isArray(inner) && inner.length > 0) {
    return inner.every((item) => getNetworkErrorCode(item) === 'ECONNREFUSED');
  }
  return getNetworkErrorCode(error) === 'ECONNREFUSED';
}

/**
 * Checks whether an error is a network failure of the request to the daemon
 * (as opposed to a bad response body or a bug).
 *
 * @param error - The caught error from a fetch attempt.
 * @returns Whether the connection failed.
 */
export function isConnectionError(error: unknown): boolean {
  if (getNetworkErrorCode(error) !== undefined) {
    return true;
  }
  const message = String(error);
  return message.includes('fetch failed') || message.includes('terminated');
}

/**
 * Low-level HTTP transport to the daemon. Single attempt, no retries,
 * no stdout/stderr output, no process.exit.
 *
 * @param port - The daemon HTTP server port.
 * @param method - The HTTP method to use.
 * @param requestPath - The URL path for the request.
 * @param body - The request body payload, or null for no body.
 * @param timeoutMs - Optional override for the abort timeout in milliseconds.
 * @returns The parsed JSON response body.
 */
export async function daemonFetch(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const commandName = requestPath.split('/').pop() ?? '';
  const timeout =
    timeoutMs ??
    COMMAND_TIMEOUTS_MS[commandName] ??
    COMMAND_TIMEOUTS_MS.default;

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
      const errorData = data.error as
        | { code?: unknown; message?: unknown; hint?: unknown }
        | undefined;
      throw new CliError(
        typeof errorData?.code === 'string' && errorData.code !== ''
          ? errorData.code
          : ErrorCodes.MM_INTERNAL_ERROR,
        typeof errorData?.message === 'string'
          ? errorData.message
          : 'Request failed',
        {
          ...(typeof errorData?.hint === 'string'
            ? { hint: errorData.hint }
            : {}),
          ...(data.meta === undefined ? {} : { meta: data.meta }),
        },
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends an HTTP request to the daemon and prints the response.
 * Retries only a refused connection (ECONNREFUSED: the daemon never got the
 * request), with linear backoff up to SEND_MAX_RETRIES times. Any other
 * connection failure fails at once with MM_DAEMON_CONNECTION_LOST, because
 * the daemon may already have run the action.
 *
 * @param port - The daemon HTTP server port.
 * @param method - The HTTP method to use.
 * @param requestPath - The URL path for the request.
 * @param body - The request body payload, or null for no body.
 * @param options - Optional request configuration.
 * @param options.requestTimeoutMs - Timeout in milliseconds for the HTTP request.
 */
export async function sendRequest(
  port: number,
  method: string,
  requestPath: string,
  body: unknown,
  options?: { requestTimeoutMs?: number },
): Promise<void> {
  const commandName = requestPath.split('/').pop() ?? '';
  const timeout =
    options?.requestTimeoutMs ??
    COMMAND_TIMEOUTS_MS[commandName] ??
    COMMAND_TIMEOUTS_MS.default;

  let lastError: unknown;

  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(SEND_RETRY_BASE_DELAY_MS * attempt);
    }

    try {
      const data = await daemonFetch(
        port,
        method,
        requestPath,
        applyObserveLevel(method, requestPath, body),
        timeout,
      );

      const { meta, ...rest } = data;
      const result = rest.result ?? rest;
      const observations = rest.observations as
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
      if (meta !== undefined && typeof output !== 'string') {
        const base =
          typeof output === 'object' &&
          output !== null &&
          !Array.isArray(output)
            ? (output as Record<string, unknown>)
            : { result: output };
        output = { ...base, meta };
      }
      if (typeof output === 'string') {
        process.stdout.write(`${output}\n`);
      } else {
        process.stdout.write(`${formatJsonOutput(output)}\n`);
      }
      return;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        fail(
          ErrorCodes.MM_REQUEST_TIMEOUT,
          `request timed out after ${timeout}ms; state unknown`,
        );
      }

      if (error instanceof CliError) {
        fail(error.code, error.message, {
          ...(error.hint === undefined ? {} : { hint: error.hint }),
          ...(error.meta === undefined ? {} : { meta: error.meta }),
        });
      }

      if (isTransientError(error)) {
        // Refused: the daemon never got the request, so a resend is safe.
        lastError = error;
        continue;
      }

      const errorText = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        const code = getNetworkErrorCode(error);
        fail(
          ErrorCodes.MM_DAEMON_CONNECTION_LOST,
          `connection to the daemon failed${code ? ` (${code})` : ''}: ${errorText}; the action may have run, check state`,
        );
      }
      fail(ErrorCodes.MM_INTERNAL_ERROR, errorText);
    }
  }

  const code = getNetworkErrorCode(lastError) ?? 'ECONNREFUSED';
  fail(
    ErrorCodes.MM_DAEMON_NOT_RUNNING,
    `daemon refused the connection on port ${port} (${code}) after ${SEND_MAX_RETRIES + 1} attempts`,
  );
}

/**
 * Reads the network error code of a failed `fetch`. Node puts it on
 * `error.cause.code` (`String(error)` is only `TypeError: fetch failed`).
 *
 * @param error - The caught error.
 * @returns The code (for example `ECONNREFUSED`), or undefined.
 */
export function getNetworkErrorCode(error: unknown): string | undefined {
  const withCode = error as
    | { code?: unknown; cause?: { code?: unknown } }
    | null
    | undefined;
  const code = withCode?.cause?.code ?? withCode?.code;
  if (typeof code === 'string') {
    return code;
  }
  return /\b(ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET)\b/u.exec(
    String(error),
  )?.[1];
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
    fail(
      ErrorCodes.MM_DAEMON_NOT_RUNNING,
      'no daemon running. Run `mm launch` to start.',
    );
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
    const runtimeCommand = resolveRuntime(worktreeRoot, config.runtime);

    const child = spawn(
      runtimeCommand.command,
      runtimeCommand.getArgs(config.daemonPath),
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: worktreeRoot,
      },
    );
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
    fail(
      ErrorCodes.MM_DAEMON_ALREADY_RUNNING,
      `daemon already running on port ${existing.port} (PID ${existing.pid})`,
    );
  }

  if (existing) {
    await removeDaemonState(worktreeRoot);
  }

  const config = await readDaemonConfig(worktreeRoot);
  const runtimeCommand = resolveRuntime(worktreeRoot, config.runtime);

  if (background) {
    const child = spawn(
      runtimeCommand.command,
      runtimeCommand.getArgs(config.daemonPath),
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: worktreeRoot,
      },
    );
    child.unref();

    const state = await waitForDaemon(worktreeRoot);
    process.stdout.write(
      `Daemon started on port ${state.port} (PID ${state.pid})\n`,
    );
    return;
  }

  const child = spawn(
    runtimeCommand.command,
    runtimeCommand.getArgs(config.daemonPath),
    {
      stdio: 'inherit',
      cwd: worktreeRoot,
    },
  );

  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

/**
 * Stops the daemon, optionally cleaning up the browser session first.
 *
 * Behavior:
 * - No state file: prints "no daemon running" and exits 0 (idempotent).
 * - Daemon alive: sends best-effort POST /cleanup, then calls shutdownDaemon().
 * - State file exists but daemon is dead (stale):
 *   - With --force: removes the stale state file.
 *   - Without --force: prints error suggesting --force, exits 1.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param force - Whether to force-remove stale state files.
 */
export async function handleStop(
  worktreeRoot: string,
  force: boolean,
): Promise<void> {
  const state = await readDaemonState(worktreeRoot);

  if (!state) {
    process.stderr.write('No daemon is running.\n');
    return;
  }

  const alive = await isDaemonAlive(state);

  if (alive) {
    try {
      await daemonFetch(
        state.port,
        'POST',
        '/cleanup',
        {},
        BEST_EFFORT_CLEANUP_TIMEOUT_MS,
      );
    } catch {
      /* best-effort — daemon shutdown proceeds regardless */
    }
    await shutdownDaemon(worktreeRoot, state);
    process.stdout.write(
      `Daemon stopped (was PID ${state.pid} on port ${state.port}).\n`,
    );
    return;
  }

  if (force) {
    await removeDaemonState(worktreeRoot);
    process.stdout.write('Removed stale daemon state.\n');
    return;
  }

  fail(
    ErrorCodes.MM_DAEMON_NOT_RUNNING,
    'daemon is not running but .mm-server state file exists (stale).\n' +
      'Use `mm stop --force` to remove the stale state.',
  );
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
    fail(
      ErrorCodes.MM_INVALID_CONFIG,
      `No mm-client-cli config found. Create ${CONFIG_MODULE_NAME}.config.ts in your project root.`,
    );
  }

  const config = result.config as MmClientCliConfig;
  if (!config.daemon) {
    fail(
      ErrorCodes.MM_INVALID_CONFIG,
      `No daemon entry point configured. Add 'daemon' to ${result.filepath}.`,
    );
  }

  const runtime = config.runtime ?? 'tsx';
  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    fail(
      ErrorCodes.MM_INVALID_CONFIG,
      `Unsupported runtime '${runtime}'. Supported runtimes are 'node' and 'tsx'.`,
    );
  }

  return {
    daemonPath: config.daemon,
    runtime,
  };
}

/**
 * Resolves the supported runtime command for spawning the daemon.
 *
 * @param worktreeRoot - The git worktree root directory.
 * @param runtime - The runtime name from configuration.
 * @returns Spawn metadata for the runtime binary.
 */
export function resolveRuntime(
  worktreeRoot: string,
  runtime: 'node' | 'tsx',
): RuntimeCommand {
  if (runtime === 'node') {
    return { command: 'node', getArgs: (daemonPath) => [daemonPath] };
  }

  if (runtime === 'tsx') {
    try {
      const requireFromProject = createRequire(
        path.join(worktreeRoot, 'package.json'),
      );
      const tsxCli = requireFromProject.resolve('tsx/cli');

      return {
        command: process.execPath,
        getArgs: (daemonPath) => [tsxCli, daemonPath],
      };
    } catch {
      fail(
        ErrorCodes.MM_DEPENDENCIES_MISSING,
        `Runtime 'tsx' is not installed in ${worktreeRoot}. Install it or set "mm.runtime" in package.json.`,
      );
    }
  }

  throw new Error('Unsupported runtime');
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
  throw new CliError(
    ErrorCodes.MM_DAEMON_START_FAILED,
    `Daemon failed to start within ${DAEMON_START_TIMEOUT_MS / 1000} seconds`,
  );
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
 * Parses a JSON CLI argument and exits with a concise error when invalid.
 *
 * @param raw - Raw JSON string.
 * @param label - Human-readable command label for error output.
 * @returns The parsed JSON value.
 */
export function parseJsonArgument(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failUsage(`invalid JSON for ${label} — ${message}`);
  }
}

/**
 * Normalizes a mock-network add payload.
 *
 * @param payload - Parsed JSON payload.
 * @returns A payload accepted by the mock_network tool.
 */
export function normalizeMockNetworkAddPayload(
  payload: unknown,
): { rule: unknown } | { routes: unknown } {
  if (typeof payload === 'object' && payload !== null && 'routes' in payload) {
    return { routes: (payload as { routes: unknown }).routes };
  }

  if (Array.isArray(payload)) {
    return { routes: payload };
  }

  return { rule: payload };
}

const MIN_VAULT_PASSWORD_LENGTH = 8;

/**
 * Reads the input for `mm launch --self-onboarding` from stdin: the secret
 * recovery phrase on the first line and an optional vault password on the
 * second. A terminal stdin is refused. The phrase is returned as 12 or 24
 * single-spaced words; the password is returned verbatim. Neither is ever
 * written to a process stream.
 *
 * @param source - The stream carrying the input. Production uses `process.stdin`.
 * @returns The normalized phrase, plus the password when one was supplied.
 */
export async function readSelfOnboardingInput(
  source: Readable,
): Promise<{ srp: string; password?: string }> {
  if ('isTTY' in source && source.isTTY === true) {
    failUsage('--self-onboarding requires the secret recovery phrase on stdin');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u);
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const [phraseLine = '', password = '', ...extra] = lines;
  if (extra.length > 0) {
    failUsage(
      'self-onboarding stdin takes the phrase and an optional password line only',
    );
  }

  const words = phraseLine
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length !== 12 && words.length !== 24) {
    failUsage(
      'self-onboarding requires a 12 or 24 word secret recovery phrase',
    );
  }
  const srp = words.join(' ');

  if (password === '') {
    return { srp };
  }
  if (password.length < MIN_VAULT_PASSWORD_LENGTH) {
    failUsage(
      `self-onboarding password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters`,
    );
  }
  return { srp, password };
}

/**
 * Parses launch command arguments into a key-value object.
 *
 * @param args - The raw CLI arguments after the command name.
 * @returns The parsed launch options.
 */
export function parseLaunchArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') {
      result.force = true;
    } else if (arg === '--context') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--context requires a value (e2e|prod)');
      }
      result.context = args[i];
    } else if (arg === '--state') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--state requires a value (default|onboarding|custom)');
      }
      result.stateMode = args[i];
    } else if (arg === '--extension-path') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--extension-path requires a value');
      }
      result.extensionPath = args[i];
    } else if (arg === '--platform') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--platform requires a value (browser|ios|android)');
      }
      result.platform = args[i];
    } else if (arg === '--device-id') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--device-id requires a value');
      }
      result.deviceId = args[i];
    } else if (arg === '--app-bundle') {
      i += 1;
      if (!args[i] || args[i].startsWith('--')) {
        failUsage('--app-bundle requires a path');
      }
      result.appBundlePath = args[i];
    } else if (arg === '--metro-port') {
      i += 1;
      const rawPort = args[i];
      const port = parseInt(rawPort ?? '', 10);
      if (
        !rawPort ||
        rawPort.startsWith('--') ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        failUsage('--metro-port requires a valid port (1-65535)');
      }
      result.metroPort = port;
    } else if (arg === '--reinstall') {
      result.reinstall = true;
    } else if (arg === '--reset-app-data') {
      result.resetAppData = true;
    } else if (arg === '--allow-fox-code-mismatch') {
      result.allowFoxCodeMismatch = true;
    } else if (arg === '--self-onboarding') {
      result.selfOnboarding = true;
    } else if (arg.startsWith('--')) {
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

Usage: mm [--project <path>] [--observe <level>] [--pretty] <command> [options]

Global Options:
  --project <path>    Target a specific project directory (absolute or relative).
                      Overrides MM_PROJECT and git-based discovery.
  --observe <level>   Observation returned after the call: none | diff | full.
                      Default: diff for mutating commands and run-steps,
                      none for reads, discovery and cdp. none does not
                      refresh refs: run describe-screen before using refs
                      again.
  --pretty            Indent JSON output. Default: one line per result when
                      stdout is not a terminal (agents, pipes), indented on a
                      terminal.

Environment Variables:
  MM_PROJECT          Default project directory when --project is not provided.
                      Falls back to the current git worktree root.
  MM_PRETTY           1/true: indent JSON output; 0/false: one line, also on a
                      terminal. --pretty takes precedence.

Lifecycle:
  mm launch [--context e2e|prod] [--state default|onboarding|custom] [--self-onboarding] [--extension-path <path>] [--force] [--platform browser|ios|android] [--device-id <id>]
  mm launch --platform ios|android [--device-id <id>] [--app-bundle <path>] [--metro-port <port>] [--reinstall] [--reset-app-data] [--allow-fox-code-mismatch]
  mm launch --self-onboarding reads the secret recovery phrase from stdin,
    and an optional vault password from the next line.
  mm cleanup [--shutdown]
  mm status
  mm stop [--force]
  mm serve [--background]
  mm build [--force]

Interaction:
  mm click <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]
  mm type <ref> <text> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]
  mm get-text <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]
  mm describe-screen
  mm screenshot [--name <name>]
  mm wait-for <ref> [--timeout <ms>] [--selector <css>] [--testid <id>] [--within <scope>]
  mm wait-for-notification [--timeout <ms>]
  mm clipboard <read|write> [text]

Navigation:
  mm navigate <url>
  mm navigate-home
  mm navigate-settings
  mm switch-to-tab <role> | --role <role> | --url <url>
  mm close-tab --role <role> | --url <url>

Discovery:
  mm list-testids [--limit <n>]
  mm accessibility-snapshot [--root <selector>]

State & Context:
  mm get-state
  mm get-context
  mm set-context <e2e|prod>

Contracts (E2E only):
  mm seed-contract <name> [--hardfork <fork>]
  mm seed-contracts <name1> <name2> ... [--hardfork <fork>]
  mm get-contract-address <name>
  mm list-contracts

Batching:
  mm run-steps <json>

Advanced:
  mm mock-network add '<json-rule-or-config>'
  mm mock-network clear
  mm mock-network list
  mm mock-network requests [--limit <n>]
  mm cdp <method> [params-json] [--timeout <ms>] [--target hermes|android-webview] [--url-filter <substr>] [--metro-port <p>] [--app-id <id>]
  mm hermes-targets [--all] [--metro-port <p>] [--app-id <id>]   (mobile only)

Mobile (iOS/Android only):
  mm scroll-to-element <ref> [--selector <css>] [--testid <id>] [--direction up|down] [--maxAttempts <n>]
  mm device-swipe <up|down|left|right> [--startX <n>] [--startY <n>] [--distance <n>]
  mm long-press <ref> [--selector <css>] [--testid <id>] [--duration <ms>]
  mm tap-coordinates <x> <y>
  mm dismiss-keyboard
  mm dismiss-alert [--accept]
  mm get-alert-text
  mm open-app <bundleId>
  mm close-app <bundleId>
  mm press-button <button>
  mm device-context <list|switch> [name]
  mm device-clipboard <read|write> [text]
  mm screen-recording <start|stop> [--output <path>]
  mm device-logs [--duration <seconds>] [--filter <text>]
  mm generate-locators

Errors:
  A failed command prints one JSON line on stdout and exits non-zero:
    {"ok":false,"error":{"code":"MM_...","message":"...","hint":"...","retryable":false},"meta":{...}}
  Branch on error.code or the exit code. stderr is for human logs only.

Exit Codes:
  0  ok
  1  anything else (internal error, tool failure)
  2  usage or validation (bad flag, bad JSON, schema); nothing ran
  3  no session, daemon not running, daemon connection lost
  4  target not found or not actionable
  5  timeout (for click, type and request timeouts the action state is unknown)
  6  platform, device, Metro or Hermes not available
  7  daemon version mismatch (reserved)

Examples:
  mm launch                                          (from inside project)
  mm --project ../metamask-extension launch          (from parent folder)
  MM_PROJECT=/path/to/extension mm describe-screen   (via env var)
`);
}

/* istanbul ignore next -- CLI entry point, tested via exported functions */
/* istanbul ignore next -- top-level fatal handler is not exercised in tests */
const handleFatalCliError = (error: unknown): void => {
  if (error instanceof CliError) {
    fail(error.code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
  fail(ErrorCodes.MM_INTERNAL_ERROR, `Fatal: ${String(error)}`);
};

/* istanbul ignore next -- CLI entry point, tested via exported functions */
if (process.env.VITEST === undefined) {
  main().catch(handleFatalCliError);
}
