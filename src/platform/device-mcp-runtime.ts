import type * as DeviceMcp from '@metamask/device-mcp';

/** The run-time exports of `@metamask/device-mcp`. */
export type DeviceMcpRuntime = typeof DeviceMcp;

let runtime: DeviceMcpRuntime | undefined;

// `require` exists in the CommonJS build only.
const moduleRequire: NodeJS.Require | null =
  typeof require === 'function'
    ? require
    : /* istanbul ignore next -- the test run always has `require` */ null;

/**
 * Loads `@metamask/device-mcp` on first use. A browser-only daemon then never
 * loads it (about 65 ms and 54 modules at daemon start).
 *
 * The CommonJS build uses `require`, so it shares the copy that a CommonJS
 * consumer loaded to create its backend. A native `import()` there would load
 * the package's ESM build as a second copy. The ESM build has no `require`
 * and uses `import()`.
 *
 * @param cjsRequire - The CommonJS `require`, or null when there is none.
 * Tests pass null to take the ESM path.
 * @returns The device-mcp module.
 */
export async function loadDeviceMcp(
  cjsRequire: NodeJS.Require | null = moduleRequire,
): Promise<DeviceMcpRuntime> {
  if (runtime === undefined) {
    const loaded = cjsRequire
      ? (cjsRequire('@metamask/device-mcp') as DeviceMcpRuntime)
      : // The ESM and CJS type declarations differ only in their MCP SDK
        // copies, which core does not use.
        ((await import('@metamask/device-mcp')) as unknown as DeviceMcpRuntime);
    // Concurrent first calls get the same cached module, so the order of
    // these writes does not matter.
    runtime ??= loaded;
  }
  return runtime;
}

/** Forgets the loaded module. Test only. */
export function resetDeviceMcpForTesting(): void {
  runtime = undefined;
}
