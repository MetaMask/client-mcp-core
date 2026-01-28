import * as path from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";
import type {
  BuildInput,
  BuildToolResult,
  McpResponse,
  HandlerOptions,
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createSuccessResponse, createErrorResponse, extractErrorMessage } from "../utils/index.js";
import type { BuildCapability } from "../../capabilities/types.js";

export type BuildToolOptions = HandlerOptions & {
  buildCapability?: BuildCapability;
};

export async function handleBuild(
  input: BuildInput,
  options?: BuildToolOptions,
): Promise<McpResponse<BuildToolResult>> {
  const startTime = Date.now();

  if (options?.buildCapability) {
    return handleBuildWithCapability(input, options.buildCapability, startTime);
  }

  // Check if we're in a context where legacy build is available
  // (i.e., running directly in metamask-extension repo)
  const nodeModulesPath = path.join(process.cwd(), "node_modules");
  if (!existsSync(nodeModulesPath)) {
    return createErrorResponse(
      ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE,
      "BuildCapability not available. The mm_build tool requires either: (1) running in e2e mode with the MetaMask extension wrapper, or (2) running directly in the metamask-extension repository with dependencies installed.",
      { capability: "BuildCapability" },
      undefined,
      startTime,
    );
  }

  return handleBuildLegacy(input, startTime);
}

async function handleBuildWithCapability(
  input: BuildInput,
  buildCapability: BuildCapability,
  startTime: number,
): Promise<McpResponse<BuildToolResult>> {
  try {
    const result = await buildCapability.build({
      buildType: input.buildType,
      force: input.force,
    });

    if (!result.success) {
      return createErrorResponse(
        ErrorCodes.MM_BUILD_FAILED,
        `Build failed: ${result.error ?? "Unknown error"}`,
        { buildType: input.buildType ?? "build:test" },
        undefined,
        startTime,
      );
    }

    return createSuccessResponse<BuildToolResult>(
      {
        buildType: input.buildType ?? "build:test",
        extensionPathResolved: result.extensionPath,
      },
      undefined,
      startTime,
    );
   } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_BUILD_FAILED,
      `Build failed: ${message}`,
      { buildType: input.buildType ?? "build:test" },
      undefined,
      startTime,
    );
  }
}

async function handleBuildLegacy(
  input: BuildInput,
  startTime: number,
): Promise<McpResponse<BuildToolResult>> {
  const buildType = input.buildType ?? "build:test";
  const extensionPath = path.join(process.cwd(), "dist", "chrome");

  try {
    const nodeModulesPath = path.join(process.cwd(), "node_modules");
    if (!existsSync(nodeModulesPath)) {
      return createErrorResponse(
        ErrorCodes.MM_DEPENDENCIES_MISSING,
        "Dependencies not installed. Run: yarn install",
        { nodeModulesPath },
        undefined,
        startTime,
      );
    }

    const manifestPath = path.join(extensionPath, "manifest.json");
    const needsBuild = input.force || !existsSync(manifestPath);

    if (needsBuild) {
      console.log(`Running: yarn ${buildType}`);
      execSync(`yarn ${buildType}`, {
        stdio: "inherit",
        cwd: process.cwd(),
        timeout: 600000,
      });
    }

    return createSuccessResponse<BuildToolResult>(
      {
        buildType: "build:test",
        extensionPathResolved: extensionPath,
      },
      undefined,
      startTime,
    );
   } catch (error) {
    const message = extractErrorMessage(error);
    return createErrorResponse(
      ErrorCodes.MM_BUILD_FAILED,
      `Build failed: ${message}`,
      { buildType },
      undefined,
      startTime,
    );
  }
}
