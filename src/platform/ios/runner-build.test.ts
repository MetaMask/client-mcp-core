import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { computeRunnerSourceHash } from './runner-build.js';

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
});
