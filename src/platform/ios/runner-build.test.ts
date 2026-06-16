import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  computeRunnerFingerprint,
  computeRunnerSourceHash,
} from './runner-build.js';

describe('runner-build', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-build-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('computeRunnerSourceHash', () => {
    it('returns a 64-char hex SHA-256 digest', async () => {
      await fs.writeFile(path.join(tmpDir, 'Test.swift'), 'import XCTest');

      const hash = await computeRunnerSourceHash(tmpDir);

      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('includes only source file extensions (.swift, .m, .h, .pbxproj, .xctestplan)', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'swift code');
      await fs.writeFile(path.join(tmpDir, 'Helper.m'), 'objc code');
      await fs.writeFile(path.join(tmpDir, 'Header.h'), 'header');
      await fs.writeFile(path.join(tmpDir, 'project.pbxproj'), 'pbx config');
      await fs.writeFile(path.join(tmpDir, 'plan.xctestplan'), 'plan config');
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'docs');
      await fs.writeFile(path.join(tmpDir, 'Package.json'), '{}');

      const hashWithAll = await computeRunnerSourceHash(tmpDir);

      await fs.writeFile(path.join(tmpDir, 'README.md'), 'changed docs');
      await fs.writeFile(path.join(tmpDir, 'Package.json'), '{"changed":1}');

      const hashAfterNonSourceChange = await computeRunnerSourceHash(tmpDir);

      expect(hashWithAll).toBe(hashAfterNonSourceChange);
    });

    it('changes when a source file is modified', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'version 1');
      const hashBefore = await computeRunnerSourceHash(tmpDir);

      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'version 2');
      const hashAfter = await computeRunnerSourceHash(tmpDir);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('changes when a source file is added', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');
      const hashBefore = await computeRunnerSourceHash(tmpDir);

      await fs.writeFile(path.join(tmpDir, 'NewFile.swift'), 'new code');
      const hashAfter = await computeRunnerSourceHash(tmpDir);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('changes when a source file is renamed', async () => {
      await fs.writeFile(path.join(tmpDir, 'Old.swift'), 'code');
      const hashBefore = await computeRunnerSourceHash(tmpDir);

      await fs.unlink(path.join(tmpDir, 'Old.swift'));
      await fs.writeFile(path.join(tmpDir, 'New.swift'), 'code');
      const hashAfter = await computeRunnerSourceHash(tmpDir);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('traverses nested directories', async () => {
      const nestedDir = path.join(tmpDir, 'Sub', 'Deep');
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(nestedDir, 'Nested.swift'), 'nested code');

      const hash = await computeRunnerSourceHash(tmpDir);

      const expected = createHash('sha256');
      expected.update(path.join('Sub', 'Deep', 'Nested.swift'));
      expected.update('nested code');

      expect(hash).toBe(expected.digest('hex'));
    });

    it('produces deterministic output regardless of file system order', async () => {
      await fs.writeFile(path.join(tmpDir, 'B.swift'), 'b');
      await fs.writeFile(path.join(tmpDir, 'A.swift'), 'a');

      const hash1 = await computeRunnerSourceHash(tmpDir);
      const hash2 = await computeRunnerSourceHash(tmpDir);

      expect(hash1).toBe(hash2);
    });

    it('returns a hash for an empty directory', async () => {
      const hash = await computeRunnerSourceHash(tmpDir);

      const expected = createHash('sha256').digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('computeRunnerFingerprint', () => {
    it('returns a 64-char hex SHA-256 digest', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');

      const hash = await computeRunnerFingerprint(
        tmpDir,
        async () => 'Xcode 16.0\nBuild 16A123',
      );

      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('is deterministic given the same sources and toolchain', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');
      const probe = async (): Promise<string> => 'Xcode 16.0\nBuild 16A123';

      const hash1 = await computeRunnerFingerprint(tmpDir, probe);
      const hash2 = await computeRunnerFingerprint(tmpDir, probe);

      expect(hash1).toBe(hash2);
    });

    it('differs from computeRunnerSourceHash because toolchain is mixed in', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');

      const sourceHash = await computeRunnerSourceHash(tmpDir);
      const fingerprint = await computeRunnerFingerprint(
        tmpDir,
        async () => 'Xcode 16.0\nBuild 16A123',
      );

      expect(fingerprint).not.toBe(sourceHash);
    });

    it('changes when the toolchain version changes', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');

      const hashV15 = await computeRunnerFingerprint(
        tmpDir,
        async () => 'Xcode 15.0\nBuild 15A123',
      );
      const hashV16 = await computeRunnerFingerprint(
        tmpDir,
        async () => 'Xcode 16.0\nBuild 16A123',
      );

      expect(hashV15).not.toBe(hashV16);
    });

    it('changes when a source file changes', async () => {
      const probe = async (): Promise<string> => 'Xcode 16.0';
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'v1');
      const hashBefore = await computeRunnerFingerprint(tmpDir, probe);

      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'v2');
      const hashAfter = await computeRunnerFingerprint(tmpDir, probe);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('handles empty toolchain output (e.g., xcodebuild missing)', async () => {
      await fs.writeFile(path.join(tmpDir, 'Runner.swift'), 'code');

      const hash = await computeRunnerFingerprint(tmpDir, async () => '');

      expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    });
  });
});
