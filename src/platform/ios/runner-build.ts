import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export type EnsureRunnerBuildOptions = {
  destination: string;
  derivedDataPath?: string;
  verbose?: boolean;
};

export type EnsureRunnerBuildResult = {
  derivedDataPath: string;
  xctestrunPath: string;
};

const ENV_DERIVED_PATH = 'IOS_RUNNER_DERIVED_DATA_PATH';
const ENV_CLEAN_DERIVED = 'IOS_RUNNER_CLEAN_DERIVED';

/**
 * The sole filesystem root under which the runner build may delete data.
 *
 * Every `derivedDataPath` (default or overridden) must symlink-resolve to a
 * path strictly under this root. Enforced by `assertSafeDerivedDataPath()`
 * before every `fs.rm()`. There is no environment-variable bypass.
 */
const SAFE_DERIVED_DATA_ROOT = path.join(os.homedir(), '.metamask-mobile-cli');

/**
 * Interpret common truthy environment variable values.
 *
 * @param value - Environment variable value to inspect.
 * @returns True when the value is `1` or `true`.
 */
function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Resolve the default DerivedData cache directory for runner builds.
 *
 * @returns Default DerivedData path under the safe root.
 */
function resolveDefaultDerivedDataPath(): string {
  return path.join(SAFE_DERIVED_DATA_ROOT, 'ios-runner', 'derived');
}

/**
 * Resolve the DerivedData path from explicit options, env override, or default.
 *
 * Returns an absolute path. Symlink resolution and safety validation are
 * performed lazily in `assertSafeDerivedDataPath()` immediately before any
 * destructive operation.
 *
 * @param overridePath - Optional caller-provided DerivedData path.
 * @returns Resolved absolute DerivedData path.
 */
function resolveRunnerDerivedDataPath(overridePath?: string): string {
  const envOverride = process.env[ENV_DERIVED_PATH]?.trim();
  const trimmedOverride = overridePath?.trim();
  const derivedDataPath =
    trimmedOverride && trimmedOverride.length > 0
      ? trimmedOverride
      : (envOverride ?? '');
  if (derivedDataPath) {
    return path.resolve(derivedDataPath);
  }
  return resolveDefaultDerivedDataPath();
}

/**
 * Resolve a target path through symlinks by walking up to the deepest
 * existing ancestor.
 *
 * Protects against path-traversal via intermediate symlinks (e.g. a path
 * like `<safe-root>/evil/sub` where `evil` is a symlink whose target is
 * outside the safe root). Non-existent tail components are appended after
 * the realpath result so the function is total over non-existent paths
 * (which is necessary because the safety check runs before destructive
 * operations may have created the directory).
 *
 * @param target - Absolute or relative path to resolve.
 * @returns The fully symlink-resolved path.
 */
function safeRealpath(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Assert that a path is safe to recursively delete.
 *
 * The target's symlink-resolved path must live strictly under the
 * symlink-resolved `SAFE_DERIVED_DATA_ROOT`. The safe root itself cannot be
 * deleted. There is no environment-variable or option bypass: any path
 * outside the safe root is rejected unconditionally.
 *
 * @param target - The absolute path that is about to be passed to `fs.rm()`.
 * @throws Error - When `target` resolves to the safe root or escapes it.
 */
function assertSafeDerivedDataPath(target: string): void {
  const resolvedTarget = safeRealpath(target);
  const safeRoot = safeRealpath(SAFE_DERIVED_DATA_ROOT);

  if (resolvedTarget === safeRoot) {
    throw new Error(
      `Refusing to delete the safe root itself: '${resolvedTarget}'`,
    );
  }

  if (!resolvedTarget.startsWith(safeRoot + path.sep)) {
    throw new Error(
      `Refusing to delete '${resolvedTarget}': path must be under '${safeRoot}' (input was '${target}')`,
    );
  }
}

/**
 * Find the generated .xctestrun file in a DerivedData directory.
 *
 * @param derivedDataPath - Xcode DerivedData directory to inspect.
 * @returns Full .xctestrun path, or undefined when absent.
 */
async function findXctestrun(
  derivedDataPath: string,
): Promise<string | undefined> {
  const productsDir = path.join(derivedDataPath, 'Build', 'Products');
  try {
    const entries = await fs.readdir(productsDir);
    const xctestrun = entries.find((name) => name.endsWith('.xctestrun'));
    return xctestrun ? path.join(productsDir, xctestrun) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve this package's root directory.
 *
 * @returns Absolute package root path.
 */
function resolvePackageRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Resolve the iOS runner Xcode project path.
 *
 * @returns Absolute path to AgentDeviceRunner.xcodeproj.
 */
function resolveRunnerXcodeprojPath(): string {
  const pkgRoot = resolvePackageRoot();
  return path.join(
    pkgRoot,
    'ios-runner',
    'AgentDeviceRunner',
    'AgentDeviceRunner.xcodeproj',
  );
}

const SOURCE_HASH_FILENAME = '.source-hash';
const SOURCE_FILE_EXTENSIONS = new Set([
  '.swift',
  '.m',
  '.h',
  '.pbxproj',
  '.xctestplan',
]);

/**
 * Resolve the bundled iOS runner source directory.
 *
 * @returns Absolute path to ios-runner sources.
 */
function resolveRunnerSourceDir(): string {
  const pkgRoot = resolvePackageRoot();
  return path.join(pkgRoot, 'ios-runner');
}

/**
 * Recursively collect source files that affect runner builds.
 *
 * @param dir - Directory to scan.
 * @returns Absolute paths for source files relevant to the runner hash.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: string[];
  try {
    const dirents = await fs.readdir(dir);
    entries = dirents;
  } catch {
    return results;
  }

  for (const name of entries) {
    const fullPath = path.join(dir, name);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const nested = await collectSourceFiles(fullPath);
      results.push(...nested);
    } else if (SOURCE_FILE_EXTENSIONS.has(path.extname(name))) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Compute a SHA-256 hash of all runner source files (Swift, ObjC, pbxproj, xctestplan).
 *
 * Produces a deterministic fingerprint from sorted relative paths and file contents,
 * independent of absolute paths. Used to detect when cached runner builds are stale.
 *
 * @param sourceDir - Optional runner source directory override.
 * @returns Hex-encoded source hash.
 */
export async function computeRunnerSourceHash(
  sourceDir?: string,
): Promise<string> {
  const dir = sourceDir ?? resolveRunnerSourceDir();
  const files = await collectSourceFiles(dir);

  const relativePaths = files
    .map((filePath) => path.relative(dir, filePath))
    .sort();

  const hash = createHash('sha256');
  for (const relPath of relativePaths) {
    const fullPath = path.join(dir, relPath);
    const content = await fs.readFile(fullPath, 'utf-8');
    hash.update(relPath);
    hash.update(content);
  }

  return hash.digest('hex');
}

const XCODEBUILD_VERSION_TIMEOUT_MS = 5_000;

/**
 * Resolve the active toolchain version string for xcodebuild.
 *
 * Captures Xcode version + build identity. Used in {@link computeRunnerFingerprint}
 * to invalidate cached runner builds when the toolchain is upgraded, even when
 * source files are unchanged.
 *
 * @returns Trimmed stdout of `xcodebuild -version`, or an empty string when
 * xcodebuild is unavailable (non-Darwin hosts or missing Xcode).
 */
async function probeXcodebuildVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], {
      timeout: XCODEBUILD_VERSION_TIMEOUT_MS,
    });
    return String(stdout ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Compute a SHA-256 fingerprint over runner sources and the active Xcode toolchain.
 *
 * Combines {@link computeRunnerSourceHash} with `xcodebuild -version` output so that
 * cached runner builds are invalidated when EITHER the sources OR the toolchain
 * changes. Source-only hashing misses toolchain upgrades, which can produce
 * stale `.xctestrun` files that no longer match the simulator runtime.
 *
 * @param sourceDir - Optional runner source directory override (passes through to
 *   {@link computeRunnerSourceHash}).
 * @param toolchainProbe - Optional async function returning a toolchain identity string.
 *   Defaults to `probeXcodebuildVersion`. Tests may inject a deterministic stub.
 * @returns Hex-encoded SHA-256 fingerprint.
 */
export async function computeRunnerFingerprint(
  sourceDir?: string,
  toolchainProbe: () => Promise<string> = probeXcodebuildVersion,
): Promise<string> {
  const sourceHash = await computeRunnerSourceHash(sourceDir);
  const toolchain = await toolchainProbe();
  const hash = createHash('sha256');
  hash.update('source:');
  hash.update(sourceHash);
  hash.update('toolchain:xcodebuild:');
  hash.update(toolchain);
  return hash.digest('hex');
}

/**
 * Read the source hash stored beside a cached runner build.
 *
 * @param derivedDataPath - DerivedData directory containing the hash file.
 * @returns Stored source hash, or undefined if none exists.
 */
async function readStoredSourceHash(
  derivedDataPath: string,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(
      path.join(derivedDataPath, SOURCE_HASH_FILENAME),
      'utf-8',
    );
    return content.trim();
  } catch {
    return undefined;
  }
}

/**
 * Persist the runner source hash for cache validation.
 *
 * @param derivedDataPath - DerivedData directory to write into.
 * @param sourceHash - Current source hash to store.
 */
async function writeSourceHash(
  derivedDataPath: string,
  sourceHash: string,
): Promise<void> {
  await fs.writeFile(
    path.join(derivedDataPath, SOURCE_HASH_FILENAME),
    sourceHash,
  );
}

/**
 * Compare the cached source hash with the current runner source hash.
 *
 * @param derivedDataPath - DerivedData directory containing the cached hash.
 * @param currentHash - Current source hash to compare.
 * @returns True when the cached build matches current sources.
 */
async function isCachedBuildValid(
  derivedDataPath: string,
  currentHash: string,
): Promise<boolean> {
  const storedHash = await readStoredSourceHash(derivedDataPath);
  return storedHash === currentHash;
}

/**
 * Invoke xcodebuild build-for-testing for the AgentDeviceRunner project.
 *
 * @param params - Build invocation parameters.
 * @param params.projectPath - Absolute path to the runner Xcode project.
 * @param params.derivedDataPath - DerivedData output path for the build.
 * @param params.destination - xcodebuild destination string for the simulator.
 * @param params.verbose - Whether to stream xcodebuild output to stderr.
 */
async function runXcodebuildBuildForTesting(params: {
  projectPath: string;
  derivedDataPath: string;
  destination: string;
  verbose: boolean;
}): Promise<void> {
  const { projectPath, derivedDataPath, destination, verbose } = params;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('xcodebuild', [
      'build-for-testing',
      '-project',
      projectPath,
      '-scheme',
      'AgentDeviceRunner',
      '-parallel-testing-enabled',
      'NO',
      '-maximum-concurrent-test-simulator-destinations',
      '1',
      '-test-timeouts-enabled',
      'NO',
      '-destination',
      destination,
      '-derivedDataPath',
      derivedDataPath,
    ]);

    let stderrTail = '';
    let stdoutTail = '';
    const maxTailChars = 32_000;

    const appendTail = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length > maxTailChars ? next.slice(-maxTailChars) : next;
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutTail = appendTail(stdoutTail, text);
      if (verbose) {
        process.stderr.write(text);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = appendTail(stderrTail, text);
      if (verbose) {
        process.stderr.write(text);
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to run xcodebuild: ${error.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `xcodebuild build-for-testing failed (code ${String(code)})\n` +
            `stdout tail:\n${stdoutTail.trimEnd()}\n` +
            `stderr tail:\n${stderrTail.trimEnd()}`,
        ),
      );
    });
  });
}

/**
 * Ensure the iOS runner is built and return the reusable xctestrun path.
 *
 * This function manages the iOS runner build lifecycle with intelligent caching:
 * - Invokes `xcodebuild build-for-testing` to compile the AgentDeviceRunner Xcode project
 * - Caches the build output in a DerivedData directory (default: `$HOME/.metamask-mobile-cli/ios-runner/derived`)
 * - Detects stale caches by computing a SHA-256 fingerprint over runner source files (Swift, ObjC, pbxproj, xctestplan) AND the active Xcode toolchain version
 * - Reuses cached builds when the fingerprint matches; rebuilds when sources or toolchain change
 * - Returns the path to the generated `.xctestrun` file for use with `xcodebuild test-without-building`
 *
 * ⚠ **DESTRUCTIVE CONTRACT**: The `derivedDataPath` may be **recursively deleted** under two conditions:
 *
 * 1. **Force clean on entry**: When the environment variable `IOS_RUNNER_CLEAN_DERIVED=1` is set,
 *    the resolved `derivedDataPath` is recursively deleted before the build begins.
 *
 * 2. **Cache invalidation**: When an existing `.xctestrun` is found in the DerivedData directory
 *    but the runner source hash has changed (indicating source files were modified), the entire
 *    `derivedDataPath` is recursively deleted before rebuilding.
 *
 * **Safe-root invariant**: Every `derivedDataPath` (whether provided via `options.derivedDataPath`,
 * the `IOS_RUNNER_DERIVED_DATA_PATH` environment variable, or the default) must resolve
 * (after symlink resolution) to a path strictly under `SAFE_DERIVED_DATA_ROOT`
 * (`$HOME/.metamask-mobile-cli`). This invariant is enforced by `assertSafeDerivedDataPath()`
 * immediately before any recursive deletion. There is **no environment-variable or option bypass**:
 * any path outside the safe root is rejected unconditionally with an error.
 *
 * **Environment variables**:
 * - `IOS_RUNNER_DERIVED_DATA_PATH`: Override the DerivedData cache directory (must be under safe root)
 * - `IOS_RUNNER_CLEAN_DERIVED`: Set to `1` or `true` to force a full clean of the DerivedData directory on entry
 *
 * **Platform requirement**: This function is macOS-only and throws an error on non-Darwin platforms.
 *
 * @param options - Runner build options
 * @param options.destination - xcodebuild destination string for the simulator (e.g., `generic/platform=iOS Simulator`)
 * @param options.derivedDataPath - Optional override for the DerivedData cache directory. If not provided,
 *   the function checks `IOS_RUNNER_DERIVED_DATA_PATH` environment variable, then falls back to the default
 *   path under the safe root. Must resolve to a path under `SAFE_DERIVED_DATA_ROOT` after symlink resolution.
 * @param options.verbose - Optional flag to stream xcodebuild output to stderr (default: false)
 *
 * @returns An object containing:
 *   - `derivedDataPath`: The absolute path to the DerivedData directory used for the build
 *   - `xctestrunPath`: The absolute path to the generated `.xctestrun` file
 *
 * @throws Error - When the platform is not macOS (Darwin)
 * @throws Error - When the Xcode project is not found at the expected location
 * @throws Error - When xcodebuild is not available on the system
 * @throws Error - When `derivedDataPath` resolves to the safe root itself or escapes it (safe-root violation)
 * @throws Error - When the xcodebuild build-for-testing command fails
 * @throws Error - When the `.xctestrun` file is not found after a successful build
 */
export async function ensureRunnerBuild(
  options: EnsureRunnerBuildOptions,
): Promise<EnsureRunnerBuildResult> {
  if (process.platform !== 'darwin') {
    throw new Error('iOS runner build requires macOS (Darwin).');
  }

  const { destination } = options;
  const verbose = options.verbose ?? false;

  const derivedDataPath = resolveRunnerDerivedDataPath(options.derivedDataPath);

  const projectPath = resolveRunnerXcodeprojPath();
  if (!existsSync(projectPath)) {
    throw new Error(
      `iOS runner Xcode project not found at ${projectPath}. ` +
        'Ensure the package was installed with the ios-runner sources.',
    );
  }

  const clean = isTruthyEnv(process.env[ENV_CLEAN_DERIVED]);

  if (clean) {
    assertSafeDerivedDataPath(derivedDataPath);
    await fs.rm(derivedDataPath, { recursive: true, force: true });
  }

  const currentSourceHash = await computeRunnerFingerprint();

  const existing = await findXctestrun(derivedDataPath);
  if (existing) {
    const cacheValid = await isCachedBuildValid(
      derivedDataPath,
      currentSourceHash,
    );
    if (cacheValid) {
      return { derivedDataPath, xctestrunPath: existing };
    }
    assertSafeDerivedDataPath(derivedDataPath);
    await fs.rm(derivedDataPath, { recursive: true, force: true });
  }

  if (!existsSync('/usr/bin/xcodebuild') && !existsSync('xcodebuild')) {
    throw new Error(
      'xcodebuild not found. Install Xcode to use iOS automation.',
    );
  }

  await fs.mkdir(derivedDataPath, { recursive: true });

  await runXcodebuildBuildForTesting({
    projectPath,
    derivedDataPath,
    destination,
    verbose,
  });

  const built = await findXctestrun(derivedDataPath);
  if (!built) {
    throw new Error(
      `Failed to locate .xctestrun after build in ${path.join(
        derivedDataPath,
        'Build',
        'Products',
      )}`,
    );
  }

  await writeSourceHash(derivedDataPath, currentSourceHash);

  return { derivedDataPath, xctestrunPath: built };
}
