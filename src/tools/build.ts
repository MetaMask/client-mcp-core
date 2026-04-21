import type { BuildInput, BuildToolResult } from './types';
import { ErrorCodes } from './types';
import { createToolError, createToolSuccess } from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { extractErrorMessage } from '../utils';

/**
 * Triggers an extension build using the configured build capability.
 *
 * @param input - The build configuration options.
 * @param context - The tool execution context.
 * @returns The build result with the resolved extension path.
 */
export async function buildTool(
  input: BuildInput,
  context: ToolContext,
): Promise<ToolResponse<BuildToolResult>> {
  const buildCapability =
    context.workflowContext.build ??
    context.sessionManager.getBuildCapability();

  if (!buildCapability) {
    return createToolError(
      ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE,
      'BuildCapability not available. The mm_build tool requires either: (1) running in e2e mode with the MetaMask extension wrapper, or (2) running directly in the metamask-extension repository with dependencies installed.',
    );
  }

  try {
    const result = await buildCapability.build({
      buildType: input.buildType,
      force: input.force,
    });

    if (!result.success) {
      return createToolError(
        ErrorCodes.MM_BUILD_FAILED,
        `Build failed: ${result.error ?? 'Unknown error'}`,
      );
    }

    return createToolSuccess({
      buildType: input.buildType ?? 'build:test',
      extensionPathResolved: result.extensionPath,
    });
  } catch (error) {
    return createToolError(
      ErrorCodes.MM_BUILD_FAILED,
      `Build failed: ${extractErrorMessage(error)}`,
    );
  }
}
