import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSessionMetadata } from './session-metadata.js';
import type { SessionMetadata } from '../tools/types/session.js';

const metadata = (sessionId: string): SessionMetadata => ({
  schemaVersion: 1,
  sessionId,
  createdAt: '2026-10-23T00:00:00.000Z',
  tags: ['smoke'],
  launch: { stateMode: 'default' },
});

describe('writeSessionMetadata', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-session-metadata-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes <artifactsDir>/<sessionId>/session.json and returns its path', async () => {
    const filePath = await writeSessionMetadata(dir, metadata('mm-abc'));

    expect(filePath).toBe(path.join(dir, 'mm-abc', 'session.json'));
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toStrictEqual(
      metadata('mm-abc'),
    );
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'a', 'b');

    const filePath = await writeSessionMetadata(nested, metadata('mm-x'));

    expect(filePath).toBe(path.join(nested, 'mm-x', 'session.json'));
  });

  it('overwrites an existing file', async () => {
    await writeSessionMetadata(dir, metadata('mm-1'));
    const updated = { ...metadata('mm-1'), tags: ['second'] };

    const filePath = await writeSessionMetadata(dir, updated);

    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).tags).toStrictEqual([
      'second',
    ]);
  });

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b'])(
    'rejects unsafe session id %j',
    async (sessionId) => {
      await expect(
        writeSessionMetadata(dir, metadata(sessionId)),
      ).rejects.toThrowError('Invalid session id');
    },
  );
});
