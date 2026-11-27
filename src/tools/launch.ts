import type { LaunchInput, LaunchPrerequisite, LaunchResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import { getSessionEvents } from '../events/session-events.js';
import { cleanupSession } from '../server/cleanup-session.js';
import type {
  ISessionManager,
  SessionLaunchResult,
} from '../server/session-manager.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { debugWarn, extractErrorMessage } from '../utils';

const PROD_MODE_PREREQUISITES: LaunchPrerequisite[] = [
  {
    step: 'Unlock Wallet',
    description:
      'The wallet must be unlocked before interacting with it. Use the extension UI to enter your password.',
  },
  {
    step: 'Configure Network',
    description:
      'Ensure the correct network is selected (e.g., Ethereum Mainnet, Sepolia, or custom network).',
  },
  {
    step: 'Set Up Accounts',
    description:
      'Import or create accounts as needed. Ensure the active account has sufficient funds for transactions.',
  },
];

/**
 * Keeps the launch Metro port and device on the session's driver, so later
 * `cdp` and `hermes-targets` calls use the launched target without passing a
 * per-call flag (B5). The launch flags win over the values the consumer
 * resolved. Drivers that do not implement `setHermesDefaults` (the browser
 * driver) are left alone.
 *
 * @param sessionManager - The session manager that owns the driver.
 * @param input - The launch input.
 * @param result - The values the consumer's launch resolved.
 */
function applyHermesDefaults(
  sessionManager: ISessionManager,
  input: LaunchInput,
  result: Pick<SessionLaunchResult, 'metroPort' | 'deviceId'>,
): void {
  const metroPort = input.metroPort ?? result.metroPort;
  const deviceId = input.deviceId ?? result.deviceId;
  if (metroPort === undefined && deviceId === undefined) {
    return;
  }
  sessionManager.getPlatformDriver?.()?.setHermesDefaults?.({
    ...(metroPort === undefined ? {} : { metroPort }),
    ...(deviceId === undefined ? {} : { deviceId }),
  });
}

/**
 * Starts the session event buffer of a browser session (`mm logs`,
 * `mm network`), so it records from launch on. Best-effort: a failure never
 * fails the launch, and the next `events`/`logs`/`network` call retries.
 *
 * @param context - The tool execution context.
 * @param input - The launch input.
 */
async function startSessionEvents(
  context: ToolContext,
  input: LaunchInput,
): Promise<void> {
  try {
    const platform =
      context.sessionManager.getPlatformDriver?.()?.getPlatform() ??
      input.platform ??
      'browser';
    if (platform !== 'browser') {
      return;
    }
    // `ensureStarted` is bounded (5 s) and never rejects: it does not hold
    // the launch on a slow attach, and the sources keep starting.
    await getSessionEvents(context.sessionManager.getContext()).ensureStarted();
  } catch (error) {
    debugWarn('launch.session-events', error);
  }
}

/**
 * Launches a new browser session with the configured extension.
 *
 * @param input - The launch configuration options.
 * @param context - The tool execution context.
 * @returns The launch result with session details and prerequisites.
 */
export async function launchTool(
  input: LaunchInput,
  context: ToolContext,
): Promise<ToolResponse<LaunchResult>> {
  const { sessionManager } = context;
  const cleanup = async (): Promise<boolean> =>
    context.cleanupSession?.() ?? cleanupSession(sessionManager);

  try {
    if (sessionManager.hasActiveSession()) {
      if (input.force) {
        await cleanup();
      } else {
        return createToolError(
          ErrorCodes.MM_SESSION_ALREADY_RUNNING,
          'A session is already running. Call cleanup first, or use --force.',
        );
      }
    }

    if (input.context) {
      sessionManager.setContext(input.context);
    }

    // Let the host redirect artifact output (e.g. screenshots) via env var,
    // falling back to the configured artifacts directory.
    const artifactsDir =
      process.env.MM_ARTIFACTS_DIR ??
      context.workflowContext.config?.artifactsDir;

    const result = await sessionManager
      .launch(artifactsDir === undefined ? input : { ...input, artifactsDir })
      .catch(async (error: unknown) => {
        // Preserve the launch error after best-effort cleanup of a partial session.
        try {
          await cleanup();
        } catch (rollbackError) {
          // The original launch error is the actionable failure.
          debugWarn('launch.rollback', rollbackError);
        }
        throw error;
      });
    const { metroPort, deviceId, ...launchResult } = result;
    applyHermesDefaults(sessionManager, input, { metroPort, deviceId });
    await startSessionEvents(context, input);
    const isProdMode = sessionManager.getEnvironmentMode() === 'prod';

    return createToolSuccess({
      ...launchResult,
      ...(isProdMode &&
        input.selfOnboarding !== true && {
          prerequisites: PROD_MODE_PREREQUISITES,
        }),
    });
  } catch (error) {
    const message = extractErrorMessage(error);

    // Preserve a consumer-thrown `MM_*` error code, known or not.
    // Consumers (e.g. mobile session managers) classify launch failures far
    // more precisely than this handler can — collapsing everything into
    // MM_LAUNCH_FAILED would discard that signal before it reaches the agent.
    // The CLI maps a code it does not know to exit 1.
    const errorCode = (error as { code?: unknown }).code;
    if (typeof errorCode === 'string' && /^MM_[A-Z0-9_]+$/u.test(errorCode)) {
      return createToolError(errorCode, message);
    }

    if (message.includes('EADDRINUSE') || message.includes('port')) {
      return createToolError(
        ErrorCodes.MM_PORT_IN_USE,
        `Port conflict: ${message}`,
      );
    }

    return createToolError(
      ErrorCodes.MM_LAUNCH_FAILED,
      `Launch failed: ${message}`,
    );
  }
}
