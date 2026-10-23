#!/usr/bin/env node
/* eslint-disable import-x/no-nodejs-modules */
// Benchmark `mm` commands against a running session (not shipped).
//
// Usage (run from the consumer worktree that owns the session):
//   node <core>/scripts/bench.mjs [--runs N] [--mm "<cmd>"] -- <command> [<command> ...]
//
// Each <command> is one mm invocation, quoted if it has arguments:
//   node bench.mjs --runs 5 -- describe-screen get-state \
//     "cdp Runtime.evaluate '{\"expression\":\"1+1\"}'"
//
// Prints TSV to stdout: median and p95 (nearest rank; with 5 runs p95 is the
// max) of wall clock, response bytes and meta.timing.{queueMs,toolMs,
// observationMs,totalMs}. Wall clock includes the `--mm` launcher start-up
// (about 1 s for `yarn mm`). Runs that exit non-zero, time out (--timeout-ms,
// default 180000) or are killed count in `fail` and are left out of the stats.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const USAGE =
  'usage: bench.mjs [--runs N] [--timeout-ms MS] [--mm "<mm invocation>"] -- <command> [<command> ...]';

/**
 * Parses the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ runs: number, timeoutMs: number, mm: string, commands: string[] }} The options.
 */
function parseArgs(argv) {
  let runs = 5;
  let timeoutMs = 180_000;
  let mm = 'yarn mm';
  const sep = argv.indexOf('--');
  const opts = sep === -1 ? argv : argv.slice(0, sep);
  const commands = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < opts.length; i++) {
    const flag = opts[i];
    const value = opts[i + 1];
    if (flag === '--runs' && value) {
      runs = Number(value);
      i += 1;
    } else if (flag === '--timeout-ms' && value) {
      timeoutMs = Number(value);
      i += 1;
    } else if (flag === '--mm' && value) {
      mm = value;
      i += 1;
    } else {
      throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a positive integer\n${USAGE}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`--timeout-ms must be a positive integer\n${USAGE}`);
  }
  if (commands.length === 0) {
    throw new Error(USAGE);
  }
  return { runs, timeoutMs, mm, commands };
}

/**
 * Returns a quantile (nearest rank) of a list of numbers.
 *
 * @param {number[]} values - The samples.
 * @param {number} fraction - Quantile in [0, 1].
 * @returns {number | string} The quantile, or '-' when there are no samples.
 */
function quantile(values, fraction) {
  if (values.length === 0) {
    return '-';
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return Math.round(sorted[rank - 1]);
}

/**
 * Runs one mm command once.
 *
 * @param {string} mm - The mm invocation (for example `yarn mm`).
 * @param {string} command - The command and its arguments.
 * @param {number} timeoutMs - Kill the run after this many milliseconds.
 * @returns {{ ok: boolean, wallMs: number, bytes: number, timing?: Record<string, number> }} The run result.
 */
function runOnce(mm, command, timeoutMs) {
  const start = performance.now();
  const proc = spawnSync(`${mm} ${command}`, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const wallMs = performance.now() - start;
  const stdout = proc.stdout ?? '';
  let timing;
  try {
    timing = JSON.parse(stdout)?.meta?.timing;
  } catch {
    // string output or not JSON: no timing
  }
  return {
    ok: proc.status === 0 && !proc.error && !proc.signal,
    wallMs,
    bytes: Buffer.byteLength(stdout),
    timing,
  };
}

const FIELDS = ['queueMs', 'toolMs', 'observationMs', 'totalMs'];

/**
 * Entry point.
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const { runs, timeoutMs, mm, commands } = options;

  const header = ['command', 'runs', 'fail', 'wall_p50', 'wall_p95'];
  header.push('bytes_p50');
  for (const field of FIELDS) {
    header.push(`${field}_p50`, `${field}_p95`);
  }
  process.stdout.write(`${header.join('\t')}\n`);

  for (const command of commands) {
    const results = [];
    for (let i = 0; i < runs; i++) {
      const result = runOnce(mm, command, timeoutMs);
      results.push(result);
      process.stderr.write(
        `${command} #${i + 1}: ${Math.round(result.wallMs)}ms ${result.ok ? 'ok' : 'FAIL'}\n`,
      );
    }
    const ok = results.filter((result) => result.ok);
    const row = [
      command.replace(/\s+/gu, ' '),
      runs,
      runs - ok.length,
      quantile(
        ok.map((result) => result.wallMs),
        0.5,
      ),
      quantile(
        ok.map((result) => result.wallMs),
        0.95,
      ),
      quantile(
        ok.map((result) => result.bytes),
        0.5,
      ),
    ];
    for (const field of FIELDS) {
      const samples = ok
        .map((result) => result.timing?.[field])
        .filter((value) => typeof value === 'number');
      row.push(quantile(samples, 0.5), quantile(samples, 0.95));
    }
    process.stdout.write(`${row.join('\t')}\n`);
  }
}

main();
