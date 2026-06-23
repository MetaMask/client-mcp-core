/* eslint-disable n/no-process-env */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  computeAxSnapshotFingerprint,
  resolveAxSnapshotBinaryPath,
  snapshotAxIos,
} from './ax-snapshot.js';

const ENV_VAR = 'METAMASK_AXSNAPSHOT_BINARY';
const SWIFT_VERSION = 'Apple Swift version 5.9\n';
const TEST_UDID = 'AAAA-BBBB-CCCC-DDDD';

async function writeAxSnapshotPackage(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'Sources', 'AXSnapshot'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'Package.swift'),
    '// swift-tools-version: 5.9\nlet package = Package()\n',
  );
  await fs.writeFile(
    path.join(root, 'Sources', 'AXSnapshot', 'main.swift'),
    'print("snapshot")\n',
  );
}

describe('ax-snapshot', () => {
  let tmpDir: string;
  let previousEnv: string | undefined;

  beforeEach(async () => {
    previousEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-snapshot-test-'));
  });

  afterEach(async () => {
    if (previousEnv === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = previousEnv;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('computeAxSnapshotFingerprint', () => {
    it('returns a 64-char hex SHA-256 digest', async () => {
      await writeAxSnapshotPackage(tmpDir);

      const hash = await computeAxSnapshotFingerprint(tmpDir, SWIFT_VERSION);

      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('changes when a Swift source file changes', async () => {
      await writeAxSnapshotPackage(tmpDir);
      const hashBefore = await computeAxSnapshotFingerprint(
        tmpDir,
        SWIFT_VERSION,
      );

      await fs.writeFile(
        path.join(tmpDir, 'Sources', 'AXSnapshot', 'main.swift'),
        'print("changed")\n',
      );
      const hashAfter = await computeAxSnapshotFingerprint(
        tmpDir,
        SWIFT_VERSION,
      );

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('changes when Package.swift changes', async () => {
      await writeAxSnapshotPackage(tmpDir);
      const hashBefore = await computeAxSnapshotFingerprint(
        tmpDir,
        SWIFT_VERSION,
      );

      await fs.writeFile(
        path.join(tmpDir, 'Package.swift'),
        '// swift-tools-version: 5.10\nlet package = Package()\n',
      );
      const hashAfter = await computeAxSnapshotFingerprint(
        tmpDir,
        SWIFT_VERSION,
      );

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('produces deterministic output across calls', async () => {
      await writeAxSnapshotPackage(tmpDir);
      await fs.writeFile(
        path.join(tmpDir, 'Sources', 'AXSnapshot', 'z.swift'),
        'let z = 1\n',
      );
      await fs.writeFile(
        path.join(tmpDir, 'Sources', 'AXSnapshot', 'a.swift'),
        'let a = 1\n',
      );

      const hash1 = await computeAxSnapshotFingerprint(tmpDir, SWIFT_VERSION);
      const hash2 = await computeAxSnapshotFingerprint(tmpDir, SWIFT_VERSION);

      expect(hash1).toBe(hash2);
    });

    it('changes when swift --version output changes', async () => {
      await writeAxSnapshotPackage(tmpDir);

      const hashBefore = await computeAxSnapshotFingerprint(
        tmpDir,
        'Apple Swift version 5.9\n',
      );
      const hashAfter = await computeAxSnapshotFingerprint(
        tmpDir,
        'Apple Swift version 5.10\n',
      );

      expect(hashBefore).not.toBe(hashAfter);
    });
  });

  describe('resolveAxSnapshotBinaryPath', () => {
    it('honors an absolute executable env override', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      await fs.writeFile(binaryPath, '#!/bin/sh\n');
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      const resolved = await resolveAxSnapshotBinaryPath();

      expect(resolved).toBe(binaryPath);
    });

    it('throws when env override is not absolute', async () => {
      process.env[ENV_VAR] = 'relative/axsnapshot';

      await expect(resolveAxSnapshotBinaryPath()).rejects.toThrowError(
        /MM_IOS_AX_BINARY_MISSING: .*absolute path/u,
      );
    });

    it('throws when env override is not executable', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      await fs.writeFile(binaryPath, '#!/bin/sh\n');
      await fs.chmod(binaryPath, 0o644);
      process.env[ENV_VAR] = binaryPath;

      await expect(resolveAxSnapshotBinaryPath()).rejects.toThrowError(
        /MM_IOS_AX_BINARY_MISSING: .*not executable/u,
      );
    });

    it('throws on non-Darwin without env override or usable cache', async () => {
      await expect(
        resolveAxSnapshotBinaryPath({ platform: 'linux' }),
      ).rejects.toThrowError(
        'MM_IOS_AX_BINARY_MISSING: AXSnapshot binary could not be built. Install Xcode Command Line Tools (xcode-select --install) or set METAMASK_AXSNAPSHOT_BINARY to a prebuilt binary path.',
      );
    });

    it('returns a cached binary when its fingerprint matches', async () => {
      const sourceDir = path.join(tmpDir, 'source');
      const installDir = path.join(tmpDir, 'install');
      const installBinary = path.join(installDir, 'axsnapshot');
      const fingerprintFile = path.join(installDir, 'fingerprint.json');
      await writeAxSnapshotPackage(sourceDir);
      await fs.mkdir(installDir, { recursive: true });
      await fs.writeFile(installBinary, '#!/bin/sh\n');
      await fs.chmod(installBinary, 0o755);
      const hash = await computeAxSnapshotFingerprint(sourceDir, SWIFT_VERSION);
      await fs.writeFile(
        fingerprintFile,
        JSON.stringify({ hash, writtenAt: new Date().toISOString() }),
      );
      const runSwiftBuild = vi.fn<() => Promise<void>>();

      const resolved = await resolveAxSnapshotBinaryPath({
        sourceDir,
        swiftVersionOutput: SWIFT_VERSION,
        installBinary,
        fingerprintFile,
        runSwiftBuild,
      });

      expect(resolved).toBe(installBinary);
      expect(runSwiftBuild).not.toHaveBeenCalled();
    });

    it('builds and installs when the cache is missing', async () => {
      const sourceDir = path.join(tmpDir, 'source');
      const installDir = path.join(tmpDir, 'install');
      const installBinary = path.join(installDir, 'axsnapshot');
      const fingerprintFile = path.join(installDir, 'fingerprint.json');
      const builtBinary = path.join(
        sourceDir,
        '.build',
        'release',
        'axsnapshot',
      );
      await writeAxSnapshotPackage(sourceDir);
      await fs.mkdir(path.dirname(builtBinary), { recursive: true });
      await fs.writeFile(builtBinary, '#!/bin/sh\n');
      const runSwiftBuild = vi.fn<() => Promise<void>>().mockResolvedValue();

      const resolved = await resolveAxSnapshotBinaryPath({
        platform: 'darwin',
        sourceDir,
        swiftVersionOutput: SWIFT_VERSION,
        installBinary,
        fingerprintFile,
        runSwiftBuild,
      });
      const installedFingerprint = JSON.parse(
        await fs.readFile(fingerprintFile, 'utf-8'),
      ) as { hash: string };

      expect(resolved).toBe(installBinary);
      await fs.access(installBinary);
      expect(installedFingerprint.hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(runSwiftBuild).toHaveBeenCalledWith(sourceDir);
    });

    it('throws build diagnostics when swift build fails', async () => {
      const sourceDir = path.join(tmpDir, 'source');
      const installDir = path.join(tmpDir, 'install');
      await writeAxSnapshotPackage(sourceDir);
      const runSwiftBuild = vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('compiler exploded'));

      await expect(
        resolveAxSnapshotBinaryPath({
          platform: 'darwin',
          sourceDir,
          swiftVersionOutput: SWIFT_VERSION,
          installBinary: path.join(installDir, 'axsnapshot'),
          fingerprintFile: path.join(installDir, 'fingerprint.json'),
          runSwiftBuild,
        }),
      ).rejects.toThrowError(/MM_IOS_AX_BUILD_FAILED: .*compiler exploded/u);
    });
  });

  describe('snapshotAxIos', () => {
    it('executes the resolved binary and maps AX output to snapshot nodes', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      const payload = {
        windowFrame: { x: 10, y: 20, width: 390, height: 844 },
        root: {
          role: 'AXWindow',
          label: 'Root',
          frame: { x: 10, y: 20, width: 390, height: 844 },
          children: [
            {
              role: 'AXButton',
              subrole: 'AXCloseButton',
              label: 'Close',
              value: 'value',
              identifier: 'close-button',
              frame: { x: 20, y: 40, width: 50, height: 60 },
              children: [],
            },
          ],
        },
      };
      await fs.writeFile(
        binaryPath,
        `#!/bin/sh\nprintf '%s' '${JSON.stringify(payload)}'\n`,
      );
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      const nodes = await snapshotAxIos(TEST_UDID);

      expect(nodes).toStrictEqual([
        {
          index: 0,
          type: 'AXWindow',
          label: 'Root',
          value: undefined,
          identifier: undefined,
          rect: { x: 0, y: 0, width: 390, height: 844 },
          enabled: true,
          hittable: true,
          children: [
            {
              index: 1,
              type: 'AXCloseButton',
              label: 'Close',
              value: 'value',
              identifier: 'close-button',
              rect: { x: 10, y: 20, width: 50, height: 60 },
              enabled: true,
              hittable: true,
              children: [],
            },
          ],
        },
      ]);
    });

    it('wraps accessibility permission stderr with the permission error code', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      await fs.writeFile(
        binaryPath,
        '#!/bin/sh\nprintf "%s" "accessibility permission missing" >&2\nprintf "%s" "{}"\n',
      );
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      await expect(snapshotAxIos(TEST_UDID)).rejects.toThrowError(
        /MM_IOS_AX_PERMISSION_REQUIRED/u,
      );
    });

    it('wraps other stderr with the snapshot failure error code', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      await fs.writeFile(
        binaryPath,
        '#!/bin/sh\nprintf "%s" "unexpected failure" >&2\nprintf "%s" "{}"\n',
      );
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      await expect(snapshotAxIos(TEST_UDID)).rejects.toThrowError(
        /MM_IOS_AX_SNAPSHOT_FAILED/u,
      );
    });

    it('passes --udid <UDID> to the AXSnapshot binary', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      const argLogPath = path.join(tmpDir, 'argv.log');
      await fs.writeFile(
        binaryPath,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argLogPath}'\nprintf '{}'\n`,
      );
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      await snapshotAxIos(TEST_UDID);

      const argLog = await fs.readFile(argLogPath, 'utf-8');
      expect(argLog.split('\n').filter(Boolean)).toStrictEqual([
        '--udid',
        TEST_UDID,
      ]);
    });

    it('rejects with MM_IOS_AX_DEVICE_NOT_FOUND when called without a UDID', async () => {
      await expect(snapshotAxIos('')).rejects.toThrowError(
        /MM_IOS_AX_DEVICE_NOT_FOUND/u,
      );
    });

    it('preserves MM_IOS_AX_DEVICE_NOT_FOUND from binary stderr without re-wrapping', async () => {
      const binaryPath = path.join(tmpDir, 'axsnapshot');
      await fs.writeFile(
        binaryPath,
        '#!/bin/sh\nprintf "%s" "MM_IOS_AX_DEVICE_NOT_FOUND: no Simulator window matched UDID AAAA-BBBB-CCCC-DDDD" >&2\nprintf "%s" "{}"\n',
      );
      await fs.chmod(binaryPath, 0o755);
      process.env[ENV_VAR] = binaryPath;

      await expect(snapshotAxIos(TEST_UDID)).rejects.toThrowError(
        /^MM_IOS_AX_DEVICE_NOT_FOUND: no Simulator window matched UDID/u,
      );
    });
  });
});
