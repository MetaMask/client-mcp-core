/* eslint-disable jsdoc/require-jsdoc */
import type { HermesCdpInput, HermesCdpResult } from './types';
import { ErrorCodes } from './types/errors.js';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

type HermesCapabilities = {
  nativePageReloads?: boolean;
  nativeSourceCodeFetching?: boolean;
  supportsMultipleDebuggers?: boolean;
};

type HermesReactNative = {
  logicalDeviceId?: string;
  capabilities?: HermesCapabilities;
};

type HermesTarget = {
  id?: string;
  title?: string;
  description?: string;
  appId?: string;
  webSocketDebuggerUrl?: string;
  reactNative?: HermesReactNative;
};

type CdpSuccessResponse = {
  id: number;
  result?: unknown;
};

type CdpErrorResponse = {
  id: number;
  error: {
    message?: string;
    code?: number;
    data?: unknown;
  };
};

type TargetSelection =
  | { ok: true; target: HermesTarget }
  | { ok: false; code: string; message: string };

type ProbeResult = { ok: true } | { ok: false; code: string; message: string };

const HERMES_BLOCKED_METHODS = new Set([
  'Runtime.terminateExecution',
  'Inspector.detached',
]);

const DISCOVERY_PATHS = ['/json', '/json/list'];
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LEGACY_SYNTHETIC_TITLE =
  'React Native Experimental (Improved Chrome Reloads)';

export const IDENTITY_PROBE_EXPR = `(function () {
  try {
    var hi = typeof HermesInternal !== 'undefined' ? HermesInternal : null;
    var p =
      hi && typeof hi.getRuntimeProperties === 'function'
        ? hi.getRuntimeProperties()
        : null;
    return JSON.stringify({
      isHermes: !!hi,
      ossVersion: p ? p['OSS Release Version'] : null,
      debuggerEnabled: p ? p['Debugger Enabled'] : null,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})();`;

/**
 * Sends a Chrome DevTools Protocol command to the active iOS Hermes runtime via
 * Metro's React Native inspector proxy, after strict target identity checks.
 *
 * @param input - CDP method, parameters, timeout, and optional Metro port.
 * @param context - Tool execution context containing the active platform driver.
 * @returns The raw CDP response result or a classified Hermes CDP error.
 */
export async function hermesCdpTool(
  input: HermesCdpInput,
  context: ToolContext,
): Promise<ToolResponse<HermesCdpResult>> {
  const { driver } = context;

  if (driver?.getPlatform() !== 'ios') {
    return createToolError(
      ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
      'hermes_cdp is only supported on iOS sessions',
    );
  }

  if (HERMES_BLOCKED_METHODS.has(input.method)) {
    return createToolError(
      ErrorCodes.MM_HERMES_CDP_BLOCKED,
      `CDP method "${input.method}" is blocked for safety. ` +
        `Blocked methods: ${[...HERMES_BLOCKED_METHODS].join(', ')}`,
    );
  }

  const expectedAppId = driver.getAppId?.();
  if (!expectedAppId) {
    return createToolError(
      ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      'No expected app identity configured on platform driver',
    );
  }

  const metroPort = input.metroPort ?? driver.getMetroPort?.() ?? 8081;
  const pinnedDeviceId = driver.getPinnedHermesDeviceId?.();

  try {
    const targets = await fetchDiscoveryTargets(metroPort, input.timeoutMs);
    const selection = selectHermesTarget(
      targets,
      expectedAppId,
      pinnedDeviceId,
    );
    if (!selection.ok) {
      return createToolError(selection.code, selection.message);
    }

    const validation = validateWebSocketUrl(
      selection.target.webSocketDebuggerUrl,
      metroPort,
    );
    if (!validation.ok) {
      return createToolError(
        ErrorCodes.MM_HERMES_UNSAFE_TARGET,
        validation.message,
      );
    }

    return await executeVerifiedCdpCommand(
      selection.target,
      input,
      pinnedDeviceId,
      driver.setPinnedHermesDeviceId?.bind(driver),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_HERMES_CONNECTION_FAILED,
      `Hermes CDP connection failed: ${message}`,
    );
  }
}

async function fetchDiscoveryTargets(
  metroPort: number,
  timeoutMs: number,
): Promise<HermesTarget[]> {
  let lastError: unknown;

  for (const path of DISCOVERY_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://localhost:${metroPort}${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Metro ${path} returned HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`Metro ${path} returned a non-array response`);
      }

      return payload.filter(isHermesTarget);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isHermesTarget(value: unknown): value is HermesTarget {
  return typeof value === 'object' && value !== null;
}

function selectHermesTarget(
  targets: HermesTarget[],
  expectedAppId: string,
  pinnedDeviceId: string | undefined,
): TargetSelection {
  const seenAppIds = [...new Set(targets.map((target) => target.appId))].filter(
    (appId): appId is string => typeof appId === 'string',
  );

  let candidates = targets
    .filter((target) => Boolean(target.webSocketDebuggerUrl))
    .filter((target) => target.title !== LEGACY_SYNTHETIC_TITLE)
    .filter((target) => target.appId === expectedAppId);

  if (pinnedDeviceId) {
    candidates = candidates.filter(
      (target) => target.reactNative?.logicalDeviceId === pinnedDeviceId,
    );
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_FOUND,
      message: `No Hermes debug target found for appId ${expectedAppId}. Saw appIds: ${JSON.stringify(
        seenAppIds,
      )}`,
    };
  }

  if (hasAmbiguousTarget(candidates)) {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: `Ambiguous Hermes target after pin filtering. Candidates: ${candidates
        .map(
          (target) =>
            `${target.id ?? '<unknown>'} (device=${
              target.reactNative?.logicalDeviceId ?? '<missing>'
            })`,
        )
        .join(', ')}`,
    };
  }

  // Same-device tiebreak: prefer pages with nativePageReloads (newer RN page
  // registrations) over stale entries left behind after in-app reloads.
  const nativeReloadTargets = candidates.filter(
    (target) => target.reactNative?.capabilities?.nativePageReloads === true,
  );
  if (nativeReloadTargets.length > 0) {
    candidates = nativeReloadTargets;
  }

  return { ok: true, target: candidates[candidates.length - 1] };
}

/**
 * Determines whether a multi-candidate target list is too ambiguous to choose
 * from safely. Returns true when:
 * - any candidate is missing a `reactNative.logicalDeviceId` (we can't route safely), or
 * - candidates resolve to more than one distinct `logicalDeviceId` (multi-device
 *   without a session pin — picking any one would silently bind the wrong device).
 *
 * Returns false when all candidates share the same logical device ID. In that
 * case the caller falls through to the "last-in-array" tiebreak, matching the
 * React Native convention that the most recent page registration wins (e.g.,
 * stale + fresh page after an in-app reload).
 *
 * @param candidates - Targets remaining after appId/pin/capability filtering.
 * @returns True when the caller must fail closed; false when tiebreak is safe.
 */
function hasAmbiguousTarget(candidates: HermesTarget[]): boolean {
  if (candidates.length <= 1) {
    return false;
  }
  const deviceIds = candidates.map(
    (target) => target.reactNative?.logicalDeviceId,
  );
  // Any candidate missing a logicalDeviceId → can't safely route.
  if (deviceIds.some((id) => !id)) {
    return true;
  }
  // Multiple distinct device IDs → multi-device without pin.
  return new Set(deviceIds).size > 1;
}

function validateWebSocketUrl(
  rawUrl: string | undefined,
  expectedPort: number,
): { ok: true } | { ok: false; message: string } {
  if (!rawUrl) {
    return { ok: false, message: 'webSocketDebuggerUrl is missing' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      message: `webSocketDebuggerUrl is not a valid URL: ${rawUrl}`,
    };
  }

  if (parsed.protocol !== 'ws:') {
    return { ok: false, message: `Unexpected protocol '${parsed.protocol}'` };
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return { ok: false, message: `Unexpected hostname '${parsed.hostname}'` };
  }
  if (Number(parsed.port) !== expectedPort) {
    return {
      ok: false,
      message: `Port mismatch: target=${parsed.port} expected=${expectedPort}`,
    };
  }

  return { ok: true };
}

async function executeVerifiedCdpCommand(
  target: HermesTarget,
  input: HermesCdpInput,
  pinnedDeviceId: string | undefined,
  setPinnedDeviceId: ((id: string) => void) | undefined,
): Promise<ToolResponse<HermesCdpResult>> {
  if (!target.webSocketDebuggerUrl) {
    return createToolError(
      ErrorCodes.MM_HERMES_UNSAFE_TARGET,
      'Target is missing webSocketDebuggerUrl',
    );
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('Global WebSocket is unavailable in this Node runtime');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;

  try {
    await waitForSocketOpen(socket, input.timeoutMs);

    const probe = await runIdentityProbe(socket, input.timeoutMs, nextId);
    nextId += 1;
    if (!probe.ok) {
      return createToolError(probe.code, probe.message);
    }

    const targetDeviceId = target.reactNative?.logicalDeviceId;
    if (!targetDeviceId) {
      return createToolError(
        ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
        'Target is missing reactNative.logicalDeviceId',
      );
    }
    if (!pinnedDeviceId) {
      setPinnedDeviceId?.(targetDeviceId);
    } else if (pinnedDeviceId !== targetDeviceId) {
      return createToolError(
        ErrorCodes.MM_HERMES_DEVICE_PIN_MISMATCH,
        `Hermes target device ${targetDeviceId} does not match session pin ${pinnedDeviceId}`,
      );
    }

    const response = await sendUserMethod(socket, input, nextId);
    nextId += 1;
    if (isCdpErrorResponse(response)) {
      return createToolError(
        ErrorCodes.MM_HERMES_CDP_FAILED,
        `Hermes CDP "${input.method}" failed: ${formatCdpError(response)}`,
      );
    }

    return createToolSuccess<HermesCdpResult>({
      method: input.method,
      result: response.result,
    });
  } finally {
    closeSocket(socket);
  }
}

async function runIdentityProbe(
  socket: WebSocket,
  timeoutMs: number,
  id: number,
): Promise<ProbeResult> {
  socket.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: IDENTITY_PROBE_EXPR, returnByValue: true },
    }),
  );

  let response: CdpSuccessResponse | CdpErrorResponse;
  try {
    response = await waitForCdpResponse(socket, id, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timed out')) {
      return {
        ok: false,
        code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
        message: `Identity probe timed out after ${timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_CONNECTION_FAILED,
      message: `Hermes CDP connection failed: ${message}`,
    };
  }

  if (isCdpErrorResponse(response)) {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: `Identity probe failed: ${formatCdpError(response)}`,
    };
  }

  const remoteResult = getProbeRemoteResult(response);
  if (remoteResult.subtype === 'error') {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: 'Identity probe evaluation returned an error subtype',
    };
  }
  if (remoteResult.value === undefined || remoteResult.value === null) {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: 'Identity probe response missing result.value',
    };
  }

  const raw =
    typeof remoteResult.value === 'string'
      ? remoteResult.value
      : JSON.stringify(remoteResult.value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: `Identity probe returned non-JSON: ${raw}`,
    };
  }

  if (!isHermesProbePayload(parsed)) {
    return {
      ok: false,
      code: ErrorCodes.MM_HERMES_TARGET_NOT_VERIFIED,
      message: `Identity probe did not verify Hermes runtime: ${raw}`,
    };
  }

  return { ok: true };
}

function getProbeRemoteResult(response: CdpSuccessResponse): {
  subtype?: unknown;
  value?: unknown;
} {
  if (typeof response.result !== 'object' || response.result === null) {
    return {};
  }
  const outer = response.result as Record<string, unknown>;
  if (typeof outer.result !== 'object' || outer.result === null) {
    return {};
  }
  return outer.result as { subtype?: unknown; value?: unknown };
}

function isHermesProbePayload(value: unknown): value is { isHermes: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isHermes?: unknown }).isHermes === true
  );
}

async function sendUserMethod(
  socket: WebSocket,
  input: HermesCdpInput,
  id: number,
): Promise<CdpSuccessResponse | CdpErrorResponse> {
  socket.send(
    JSON.stringify({
      id,
      method: input.method,
      params: input.params ?? {},
    }),
  );
  return await waitForCdpResponse(socket, id, input.timeoutMs);
}

async function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let cleanup = (): void => undefined;
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error('WebSocket connection error'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
    };

    socket.addEventListener('open', handleOpen);
    socket.addEventListener('error', handleError);
  });
}

async function waitForCdpResponse(
  socket: WebSocket,
  id: number,
  timeoutMs: number,
): Promise<CdpSuccessResponse | CdpErrorResponse> {
  return new Promise((resolve, reject) => {
    let cleanup = (): void => undefined;
    const handleMessage = (event: MessageEvent): void => {
      try {
        const parsed = parseCdpResponse(event.data);
        if (parsed?.id !== id) {
          return;
        }
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error('WebSocket message error'));
    };
    const handleClose = (): void => {
      cleanup();
      reject(new Error('WebSocket closed before CDP response'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Hermes CDP call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };

    socket.addEventListener('message', handleMessage);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);
  });
}

function parseCdpResponse(
  data: MessageEvent['data'],
): CdpSuccessResponse | CdpErrorResponse | undefined {
  if (typeof data !== 'string') {
    throw new Error('Hermes CDP returned a non-text WebSocket frame');
  }

  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.id !== 'number') {
    return undefined;
  }
  if (isCdpError(candidate.error)) {
    return { id: candidate.id, error: candidate.error };
  }
  return { id: candidate.id, result: candidate.result };
}

function isCdpError(value: unknown): value is CdpErrorResponse['error'] {
  return typeof value === 'object' && value !== null;
}

function isCdpErrorResponse(
  response: CdpSuccessResponse | CdpErrorResponse,
): response is CdpErrorResponse {
  return 'error' in response;
}

function formatCdpError(response: CdpErrorResponse): string {
  const parts = [response.error.message ?? 'Unknown CDP error'];
  if (typeof response.error.code === 'number') {
    parts.push(`code ${response.error.code}`);
  }
  if (response.error.data !== undefined) {
    parts.push(JSON.stringify(response.error.data));
  }
  return parts.join(' - ');
}

function closeSocket(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    socket.close();
  }
}
