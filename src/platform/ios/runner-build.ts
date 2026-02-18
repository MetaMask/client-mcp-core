import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
const ENV_ALLOW_OVERRIDE_CLEAN = 'IOS_RUNNER_ALLOW_OVERRIDE_DERIVED_CLEAN';

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

function resolveDefaultDerivedDataPath(): string {
  return path.join(os.homedir(), '.metamask-mcp', 'ios-runner', 'DerivedData');
}

function resolveRunnerDerivedDataPath(overridePath?: string): {
  path: string;
  isOverride: boolean;
} {
  const envOverride = process.env[ENV_DERIVED_PATH]?.trim();
  const derivedDataPath = overridePath?.trim() || envOverride || '';
  if (derivedDataPath) {
    return { path: path.resolve(derivedDataPath), isOverride: true };
  }
  return { path: resolveDefaultDerivedDataPath(), isOverride: false };
}

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

function resolvePackageRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

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

function resolveRunnerSourceDir(): string {
  const pkgRoot = resolvePackageRoot();
  return path.join(pkgRoot, 'ios-runner');
}

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

async function writeSourceHash(
  derivedDataPath: string,
  sourceHash: string,
): Promise<void> {
  await fs.writeFile(
    path.join(derivedDataPath, SOURCE_HASH_FILENAME),
    sourceHash,
  );
}

async function isCachedBuildValid(
  derivedDataPath: string,
  currentHash: string,
): Promise<boolean> {
  const storedHash = await readStoredSourceHash(derivedDataPath);
  return storedHash === currentHash;
}

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

    proc.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stdoutTail = appendTail(stdoutTail, text);
      if (verbose) {
        process.stderr.write(text);
      }
    });

    proc.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
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

export async function ensureRunnerBuild(
  options: EnsureRunnerBuildOptions,
): Promise<EnsureRunnerBuildResult> {
  if (process.platform !== 'darwin') {
    throw new Error('iOS runner build requires macOS (Darwin).');
  }

  const { destination } = options;
  const verbose = options.verbose ?? false;

  const { path: derivedDataPath, isOverride } = resolveRunnerDerivedDataPath(
    options.derivedDataPath,
  );

  const projectPath = resolveRunnerXcodeprojPath();
  if (!existsSync(projectPath)) {
    throw new Error(
      `iOS runner Xcode project not found at ${projectPath}. ` +
        'Ensure the package was installed with the ios-runner sources.',
    );
  }

  const clean = isTruthyEnv(process.env[ENV_CLEAN_DERIVED]);
  const allowOverrideClean = isTruthyEnv(process.env[ENV_ALLOW_OVERRIDE_CLEAN]);

  if (clean) {
    if (isOverride && !allowOverrideClean) {
      throw new Error(
        `${ENV_CLEAN_DERIVED}=1 is set, but refusing to clean an overridden derived data path. ` +
          `Set ${ENV_ALLOW_OVERRIDE_CLEAN}=1 to allow cleaning ${derivedDataPath}.`,
      );
    }
    await fs.rm(derivedDataPath, { recursive: true, force: true });
  }

  const currentSourceHash = await computeRunnerSourceHash();

  const existing = await findXctestrun(derivedDataPath);
  if (existing) {
    const cacheValid = await isCachedBuildValid(
      derivedDataPath,
      currentSourceHash,
    );
    if (cacheValid) {
      return { derivedDataPath, xctestrunPath: existing };
    }
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
