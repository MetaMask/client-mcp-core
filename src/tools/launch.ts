import type { LaunchInput, LaunchPrerequisite, LaunchResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { extractErrorMessage } from '../utils';

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

  try {
    if (sessionManager.hasActiveSession()) {
      if (input.force) {
        await sessionManager.cleanup();
      } else {
        return createToolError(
          ErrorCodes.MM_SESSION_ALREADY_RUNNING,
          'A session is already running. Call cleanup first, or use --force.',
        );
      }
    }

    if (input.platform === 'ios') {
      if (!input.simulatorDeviceId) {
        return createToolError(
          ErrorCodes.MM_INVALID_INPUT,
          'simulatorDeviceId is required when platform is "ios"',
        );
      }
      // appBundlePath is optional — prod context resolves the installed app automatically.
      // The mobile session manager's validateIOSPrerequisites() handles resolution and safety checks.
    }

    if (input.platform === 'android') {
      if (!input.androidDeviceId) {
        return createToolError(
          ErrorCodes.MM_INVALID_INPUT,
          'androidDeviceId is required when platform is "android"',
        );
      }
    }

    if (input.context) {
      sessionManager.setContext(input.context);
    }

    const result = await sessionManager.launch(input);
    const isProdMode = sessionManager.getEnvironmentMode() === 'prod';

    return createToolSuccess({
      ...result,
      ...(isProdMode && { prerequisites: PROD_MODE_PREREQUISITES }),
    });
  } catch (error) {
    const message = extractErrorMessage(error);

    const errorCode = (error as { code?: string }).code;
    if (
      errorCode &&
      Object.values(ErrorCodes).includes(
        errorCode as (typeof ErrorCodes)[keyof typeof ErrorCodes],
      )
    ) {
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
