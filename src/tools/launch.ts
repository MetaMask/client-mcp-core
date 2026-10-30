import type { LaunchInput, LaunchPrerequisite, LaunchResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import { cleanupSession } from '../server/cleanup-session.js';
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

    const result = await sessionManager
      .launch(input)
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
    const isProdMode = sessionManager.getEnvironmentMode() === 'prod';

    return createToolSuccess({
      ...result,
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
