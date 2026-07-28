import path from 'node:path';

/**
 * Result of resolving a path within the artifacts directory.
 */
export type ResolveWithinArtifactsDirResult =
  | {
      ok: true;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Resolves an output path relative to the artifacts directory, rejecting
 * paths that escape the directory via traversal or absolute paths outside it.
 *
 * @param outputPath - The user-supplied output path to resolve.
 * @param artifactsDir - The configured artifacts directory (sandbox root).
 * @returns The resolved absolute path if valid, or an error reason if invalid.
 */
export function resolveWithinArtifactsDir(
  outputPath: string,
  artifactsDir: string | undefined,
): ResolveWithinArtifactsDirResult {
  if (artifactsDir === undefined) {
    return {
      ok: false,
      reason: 'No artifacts directory configured for output path sandboxing',
    };
  }

  const resolved = path.resolve(artifactsDir, outputPath);
  const relative = path.relative(artifactsDir, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      reason: `Output path "${outputPath}" escapes the artifacts directory`,
    };
  }

  return { ok: true, resolvedPath: resolved };
}
