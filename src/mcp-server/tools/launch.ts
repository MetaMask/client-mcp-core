import { getSessionManager } from '../session-manager.js';
import type {
  LaunchInput,
  LaunchResult,
  LaunchPrerequisite,
  McpResponse,
  HandlerOptions,
} from '../types';
import { ErrorCodes } from '../types';
import {
  createSuccessResponse,
  createErrorResponse,
  extractErrorMessage,
} from '../utils';

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
 * Handles the launch tool request to start a browser session.
 *
 * @param input - The launch configuration parameters.
 * @param _options - Handler options (unused).
 * @returns Response with session info or error.
 */
export async function handleLaunch(
  input: LaunchInput,
  _options?: HandlerOptions,
): Promise<McpResponse<LaunchResult>> {
  const startTime = Date.now();
  const sessionManager = getSessionManager();

  try {
    if (sessionManager.hasActiveSession()) {
      return createErrorResponse(
        ErrorCodes.MM_SESSION_ALREADY_RUNNING,
        'A session is already running. Call mm_cleanup first.',
        { currentSessionId: sessionManager.getSessionId() },
        sessionManager.getSessionId(),
        startTime,
      );
    }

    const result = await sessionManager.launch(input);

    const isProdMode = sessionManager.getEnvironmentMode() === 'prod';
    const launchResult: LaunchResult = {
      ...result,
      ...(isProdMode && { prerequisites: PROD_MODE_PREREQUISITES }),
    };

    return createSuccessResponse<LaunchResult>(
      launchResult,
      result.sessionId,
      startTime,
    );
  } catch (error) {
    const message = extractErrorMessage(error);

    if (message.includes('EADDRINUSE') || message.includes('port')) {
      return createErrorResponse(
        ErrorCodes.MM_PORT_IN_USE,
        `Port conflict: ${message}`,
        { input },
        undefined,
        startTime,
      );
    }

    return createErrorResponse(
      ErrorCodes.MM_LAUNCH_FAILED,
      `Launch failed: ${message}`,
      { input },
      undefined,
      startTime,
    );
  }
}
