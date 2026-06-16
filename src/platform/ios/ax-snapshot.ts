import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs, { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SnapshotNode } from './types.js';

const execFile = promisify(execFileCb);

const AXSNAPSHOT_ENV_VAR = 'METAMASK_AXSNAPSHOT_BINARY';
const AXSNAPSHOT_INSTALL_ROOT = path.join(
  os.homedir(),
  '.metamask-mobile-cli',
  'axsnapshot',
  'current',
);
const AXSNAPSHOT_INSTALL_BINARY = path.join(
  AXSNAPSHOT_INSTALL_ROOT,
  'axsnapshot',
);
const AXSNAPSHOT_FINGERPRINT_FILE = path.join(
  AXSNAPSHOT_INSTALL_ROOT,
  'fingerprint.json',
);
const AXSNAPSHOT_BUILD_TIMEOUT_MS = 120_000;
const SWIFT_VERSION_TIMEOUT_MS = 5_000;
const AXSNAPSHOT_TIMEOUT_MS = 15_000;
const AXSNAPSHOT_MISSING_MESSAGE =
  'MM_IOS_AX_BINARY_MISSING: AXSnapshot binary could not be built. Install Xcode Command Line Tools (xcode-select --install) or set METAMASK_AXSNAPSHOT_BINARY to a prebuilt binary path.';
const STDERR_TAIL_CHARS = 4_096;

type AXFrame = { x: number; y: number; width: number; height: number };

type AXTreeNode = {
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame?: AXFrame;
  children?: AXTreeNode[];
};

type AXSnapshotPayload = {
  root?: AXTreeNode;
  windowFrame?: AXFrame | null;
};

type FingerprintFile = {
  hash?: unknown;
  writtenAt?: unknown;
};

type ResolveAxSnapshotOptions = {
  platform?: NodeJS.Platform;
  sourceDir?: string;
  swiftVersionOutput?: string;
  installBinary?: string;
  fingerprintFile?: string;
  runSwiftBuild?: (sourceDir: string) => Promise<void>;
};

/**
 * Capture and normalize the iOS accessibility snapshot for a specific simulator.
 *
 * @param udid - UDID of the simulator to snapshot (required to disambiguate
 *   between multiple booted simulators).
 * @returns Snapshot nodes from AXSnapshot output.
 */
export async function snapshotAxIos(udid: string): Promise<SnapshotNode[]> {
  if (!udid) {
    throw new Error(
      'MM_IOS_AX_DEVICE_NOT_FOUND: UDID is required to capture an AX snapshot scoped to a specific simulator.',
    );
  }

  const binaryPath = await resolveAxSnapshotBinaryPath();
  const { stdout, stderr } = await execFile(binaryPath, ['--udid', udid], {
    timeout: AXSNAPSHOT_TIMEOUT_MS,
  });

  const stderrText = String(stderr ?? '').trim();
  if (stderrText.length > 0) {
    if (stderrText.includes('MM_IOS_AX_DEVICE_NOT_FOUND')) {
      throw new Error(stderrText);
    }
    if (stderrText.toLowerCase().includes('accessibility permission')) {
      throw new Error(`MM_IOS_AX_PERMISSION_REQUIRED: ${stderrText}`);
    }
    throw new Error(`MM_IOS_AX_SNAPSHOT_FAILED: ${stderrText}`);
  }

  const parsed = parsePayload(String(stdout ?? ''));
  return mapAxToSnapshotNodes(parsed.root, parsed.windowFrame ?? undefined);
}

/**
 * Resolve the AXSnapshot binary path from env, cache, or lazy source build.
 *
 * @param options - Optional test-only resolver overrides.
 * @returns Absolute path to an executable AXSnapshot binary.
 */
export async function resolveAxSnapshotBinaryPath(
  options: ResolveAxSnapshotOptions = {},
): Promise<string> {
  const envPath = process.env[AXSNAPSHOT_ENV_VAR];
  const installBinary = options.installBinary ?? AXSNAPSHOT_INSTALL_BINARY;
  const fingerprintFile =
    options.fingerprintFile ?? AXSNAPSHOT_FINGERPRINT_FILE;
  if (envPath) {
    if (!path.isAbsolute(envPath)) {
      throw new Error(
        'MM_IOS_AX_BINARY_MISSING: METAMASK_AXSNAPSHOT_BINARY must be an absolute path.',
      );
    }
    if (await existsExecutable(envPath)) {
      return envPath;
    }

    throw new Error(
      `MM_IOS_AX_BINARY_MISSING: METAMASK_AXSNAPSHOT_BINARY is not executable: ${envPath}`,
    );
  }

  const hasCachedBinary = await existsExecutable(installBinary);
  let fingerprint: string | undefined;
  if (hasCachedBinary) {
    try {
      fingerprint = await computeAxSnapshotFingerprint(
        options.sourceDir,
        options.swiftVersionOutput,
      );
      const installedFingerprint =
        await readInstalledFingerprint(fingerprintFile);
      if (installedFingerprint === fingerprint) {
        return installBinary;
      }
    } catch {
      if ((options.platform ?? process.platform) !== 'darwin') {
        throw new Error(AXSNAPSHOT_MISSING_MESSAGE);
      }
    }
  }

  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error(AXSNAPSHOT_MISSING_MESSAGE);
  }

  try {
    fingerprint ??= await computeAxSnapshotFingerprint(
      options.sourceDir,
      options.swiftVersionOutput,
    );
    await buildAndInstallAxSnapshot(fingerprint, options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MM_IOS_AX_')) {
      throw error;
    }
    throw new Error(AXSNAPSHOT_MISSING_MESSAGE);
  }

  if (await existsExecutable(installBinary)) {
    return installBinary;
  }

  throw new Error(AXSNAPSHOT_MISSING_MESSAGE);
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
 * Resolve the bundled AXSnapshot Swift package directory.
 *
 * @returns Absolute path to ios-runner/AXSnapshot.
 */
function resolveAxSnapshotSourceDir(): string {
  return path.join(resolvePackageRoot(), 'ios-runner', 'AXSnapshot');
}

/**
 * Recursively collect Swift source files.
 *
 * @param dir - Directory to scan.
 * @returns Absolute Swift source file paths.
 */
async function collectSwiftFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const name of entries) {
    const fullPath = path.join(dir, name);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      results.push(...(await collectSwiftFiles(fullPath)));
    } else if (path.extname(name) === '.swift') {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Return stdout from `swift --version`.
 *
 * @returns Swift toolchain version text.
 */
async function readSwiftVersionOutput(): Promise<string> {
  const { stdout } = await execFile('swift', ['--version'], {
    timeout: SWIFT_VERSION_TIMEOUT_MS,
  });
  return String(stdout ?? '');
}

/**
 * Compute the AXSnapshot source and toolchain fingerprint.
 *
 * @param sourceDir - Optional AXSnapshot package directory override.
 * @param swiftVersionOutput - Optional pre-read Swift version output.
 * @param platform - Optional platform value to include in the fingerprint.
 * @returns SHA-256 hex digest.
 */
export async function computeAxSnapshotFingerprint(
  sourceDir?: string,
  swiftVersionOutput?: string,
  platform = process.platform,
): Promise<string> {
  const axDir = sourceDir ?? resolveAxSnapshotSourceDir();
  const sourcesDir = path.join(axDir, 'Sources');
  const swiftFiles = await collectSwiftFiles(sourcesDir);
  const inputPaths = [
    path.relative(axDir, path.join(axDir, 'Package.swift')),
    ...swiftFiles.map((filePath) => path.relative(axDir, filePath)),
  ].sort();

  const hash = createHash('sha256');
  for (const relPath of inputPaths) {
    const content = await fs.readFile(path.join(axDir, relPath));
    hash.update(`path:${relPath}\n`);
    hash.update(content);
  }

  hash.update(`platform:${platform}\n`);
  hash.update('toolchain:swift\n');
  hash.update(swiftVersionOutput ?? (await readSwiftVersionOutput()));

  return hash.digest('hex');
}

/**
 * Read the installed AXSnapshot fingerprint.
 *
 * @param fingerprintFile - Fingerprint file path to read.
 * @returns Stored hash, or undefined when absent or invalid.
 */
async function readInstalledFingerprint(
  fingerprintFile = AXSNAPSHOT_FINGERPRINT_FILE,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(fingerprintFile, 'utf-8');
    const parsed = JSON.parse(content) as FingerprintFile;
    return typeof parsed.hash === 'string' ? parsed.hash : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the installed AXSnapshot fingerprint atomically.
 *
 * @param hash - Current fingerprint hash.
 * @param fingerprintFile - Fingerprint file path to write.
 */
async function writeInstalledFingerprint(
  hash: string,
  fingerprintFile = AXSNAPSHOT_FINGERPRINT_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(fingerprintFile), { recursive: true });
  const tmpPath = `${fingerprintFile}.tmp-${String(process.pid)}`;
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify({ hash, writtenAt: new Date().toISOString() }, null, 2)}\n`,
  );
  await fs.rename(tmpPath, fingerprintFile);
}

/**
 * Run SwiftPM to build AXSnapshot, then install it into the cache atomically.
 *
 * @param fingerprint - Current AXSnapshot fingerprint.
 * @param options - Optional test-only build overrides.
 */
async function buildAndInstallAxSnapshot(
  fingerprint: string,
  options: ResolveAxSnapshotOptions = {},
): Promise<void> {
  const axDir = options.sourceDir ?? resolveAxSnapshotSourceDir();
  const installBinary = options.installBinary ?? AXSNAPSHOT_INSTALL_BINARY;
  const fingerprintFile =
    options.fingerprintFile ?? AXSNAPSHOT_FINGERPRINT_FILE;
  process.stderr.write(
    'metamask-mobile-cli: building axsnapshot (first run or update)...\n',
  );

  try {
    if (options.runSwiftBuild) {
      await options.runSwiftBuild(axDir);
    } else {
      await execFile(
        'swift',
        ['build', '-c', 'release', '--package-path', axDir],
        { timeout: AXSNAPSHOT_BUILD_TIMEOUT_MS },
      );
    }
  } catch (error) {
    throw new Error(
      `MM_IOS_AX_BUILD_FAILED: swift build failed. ${formatExecErrorTail(error)}`,
    );
  }

  const builtBinary = path.join(axDir, '.build', 'release', 'axsnapshot');
  await fs.mkdir(path.dirname(installBinary), { recursive: true });
  const tmpBinary = `${installBinary}.tmp-${String(process.pid)}`;
  await fs.copyFile(builtBinary, tmpBinary);
  await fs.chmod(tmpBinary, 0o755);
  await fs.rename(tmpBinary, installBinary);
  await writeInstalledFingerprint(fingerprint, fingerprintFile);
}

/**
 * Format the diagnostic tail from a failed child process.
 *
 * @param error - Child process failure.
 * @returns Stderr tail text suitable for an error message.
 */
function formatExecErrorTail(error: unknown): string {
  if (error instanceof Error) {
    const stderr =
      'stderr' in error
        ? (error as Error & { stderr?: unknown }).stderr
        : undefined;
    let text = error.message;
    if (Buffer.isBuffer(stderr)) {
      text = stderr.toString();
    } else if (typeof stderr === 'string') {
      text = stderr;
    }
    text = text.trimEnd();
    return text.length > STDERR_TAIL_CHARS
      ? text.slice(-STDERR_TAIL_CHARS)
      : text;
  }
  return String(error);
}

/**
 * Check whether a file exists and can be executed.
 *
 * @param filePath - Absolute path to inspect.
 * @returns True when the file is executable.
 */
async function existsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse AXSnapshot JSON output into the supported payload shape.
 *
 * @param stdoutText - Raw stdout emitted by AXSnapshot.
 * @returns Parsed AX snapshot payload.
 */
function parsePayload(stdoutText: string): AXSnapshotPayload {
  const text = stdoutText.trim();
  if (!text) {
    throw new Error('AXSnapshot returned empty output');
  }

  const parsed = JSON.parse(text) as AXSnapshotPayload | AXTreeNode;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AXSnapshot returned invalid JSON');
  }

  if ('root' in parsed) {
    if (!parsed.root) {
      throw new Error('AXSnapshot payload missing root');
    }
    return parsed;
  }

  return {
    root: parsed as AXTreeNode,
    windowFrame: null,
  };
}

/**
 * Convert an AX tree into MCP snapshot nodes.
 *
 * @param root - AX tree root node.
 * @param windowFrame - Window frame used to normalize coordinates.
 * @returns Normalized snapshot node list.
 */
function mapAxToSnapshotNodes(
  root: AXTreeNode | undefined,
  windowFrame?: AXFrame,
): SnapshotNode[] {
  if (!root) {
    return [];
  }

  let index = 0;

  const mapNode = (node: AXTreeNode): SnapshotNode => {
    const rect = normalizeFrame(node.frame, windowFrame);
    const mapped: SnapshotNode = {
      index,
      type: node.subrole ?? node.role ?? 'Element',
      label: node.label,
      value: node.value,
      identifier: node.identifier,
      rect,
      enabled: true,
      hittable: true,
      children: [],
    };
    index += 1;

    const children = node.children?.map((child) => mapNode(child)) ?? [];
    mapped.children = children;
    return mapped;
  };

  return [mapNode(root)];
}

/**
 * Normalize an AX frame relative to the window frame when available.
 *
 * @param frame - AX element frame.
 * @param windowFrame - AX window frame used as the origin.
 * @returns Snapshot rectangle coordinates, or undefined when no frame exists.
 */
function normalizeFrame(
  frame?: AXFrame,
  windowFrame?: AXFrame,
): SnapshotNode['rect'] {
  if (!frame) {
    return undefined;
  }

  if (!windowFrame) {
    return {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
  }

  return {
    x: frame.x - windowFrame.x,
    y: frame.y - windowFrame.y,
    width: frame.width,
    height: frame.height,
  };
}
