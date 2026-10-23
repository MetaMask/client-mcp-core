import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SessionMetadata } from '../tools/types/session.js';

/**
 * Writes `session.json` for a session to `<artifactsDir>/<sessionId>/`.
 *
 * @param artifactsDir - The artifacts directory (for example the workflow
 * context's `config.artifactsDir`). Relative paths resolve against the
 * process working directory.
 * @param metadata - The session metadata to persist.
 * @returns The absolute path of the written file.
 */
export async function writeSessionMetadata(
  artifactsDir: string,
  metadata: SessionMetadata,
): Promise<string> {
  if (
    !metadata.sessionId ||
    metadata.sessionId.includes('/') ||
    metadata.sessionId.includes('\\') ||
    metadata.sessionId === '.' ||
    metadata.sessionId === '..'
  ) {
    throw new Error(`Invalid session id: "${metadata.sessionId}"`);
  }
  const sessionDir = path.resolve(artifactsDir, metadata.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'session.json');
  await fs.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
  return filePath;
}
