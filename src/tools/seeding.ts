import { classifySeedingError } from './error-classification.js';
import type {
  GetContractAddressInput,
  GetContractAddressResult,
  ListDeployedContractsInput,
  ListDeployedContractsResult,
  SeedContractInput,
  SeedContractResult,
  SeedContractsInput,
  SeedContractsResult,
} from './types';
import { ErrorCodes } from './types';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ContractSeedingCapability } from '../capabilities/types.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

/**
 * Resolves the contract seeding capability or returns an error response.
 *
 * @param context - The tool execution context.
 * @returns The seeding capability or an error response if unavailable.
 */
function getSeedingCapability(
  context: ToolContext,
): ContractSeedingCapability | ToolResponse<never> {
  const missingSession = requireActiveSession<never>(context);
  if (missingSession) {
    return missingSession;
  }

  const capability =
    context.workflowContext.contractSeeding ??
    context.sessionManager.getContractSeedingCapability();

  if (!capability) {
    return createToolError(
      ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE,
      'ContractSeedingCapability not available. The mm_seed_contract tool requires running in e2e mode with the MetaMask extension wrapper, which provides Anvil chain and contract deployment support.',
    );
  }

  return capability;
}

/**
 * Type guard that checks if the value is a ToolResponse rather than a capability.
 *
 * @param value - The capability or tool response to check.
 * @returns True if the value is a ToolResponse.
 */
function isToolResponse(
  value: ContractSeedingCapability | ToolResponse<never>,
): value is ToolResponse<never> {
  return 'ok' in value;
}

/**
 * Deploys a single smart contract to the local Anvil chain.
 *
 * @param input - The contract name and deployment options.
 * @param context - The tool execution context.
 * @returns The deployed contract address and metadata.
 */
export async function seedContractTool(
  input: SeedContractInput,
  context: ToolContext,
): Promise<ToolResponse<SeedContractResult>> {
  const capability = getSeedingCapability(context);
  if (isToolResponse(capability)) {
    return capability;
  }

  try {
    const deployed = await capability.deployContract(input.contractName, {
      hardfork: input.hardfork,
      deployerOptions: input.deployerOptions,
    });

    return createToolSuccess({
      contractName: deployed.name,
      contractAddress: deployed.address,
      deployedAt: deployed.deployedAt,
    });
  } catch (error) {
    const errorInfo = classifySeedingError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Deploys multiple smart contracts in batch to the local Anvil chain.
 *
 * @param input - The contract list and shared deployment options.
 * @param context - The tool execution context.
 * @returns The deployed and failed contract results.
 */
export async function seedContractsTool(
  input: SeedContractsInput,
  context: ToolContext,
): Promise<ToolResponse<SeedContractsResult>> {
  const capability = getSeedingCapability(context);
  if (isToolResponse(capability)) {
    return capability;
  }

  try {
    const seedResult = await capability.deployContracts(input.contracts, {
      hardfork: input.hardfork,
    });

    return createToolSuccess({
      deployed: seedResult.deployed.map((deployedContract) => ({
        contractName: deployedContract.name,
        contractAddress: deployedContract.address,
        deployedAt: deployedContract.deployedAt,
      })),
      failed: seedResult.failed.map((failedDeployment) => ({
        contractName: failedDeployment.name,
        error: failedDeployment.error,
      })),
    });
  } catch (error) {
    const errorInfo = classifySeedingError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Looks up the deployed address of a contract by name.
 *
 * @param input - The contract name to look up.
 * @param context - The tool execution context.
 * @returns The contract name and its deployed address.
 */
export async function getContractAddressTool(
  input: GetContractAddressInput,
  context: ToolContext,
): Promise<ToolResponse<GetContractAddressResult>> {
  const capability = getSeedingCapability(context);
  if (isToolResponse(capability)) {
    return capability;
  }

  try {
    return createToolSuccess({
      contractName: input.contractName,
      contractAddress: capability.getContractAddress(input.contractName),
    });
  } catch (error) {
    const errorInfo = classifySeedingError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}

/**
 * Lists all currently deployed contracts.
 *
 * @param _input - Unused input parameters.
 * @param context - The tool execution context.
 * @returns The list of deployed contracts with addresses and timestamps.
 */
export async function listContractsTool(
  _input: ListDeployedContractsInput,
  context: ToolContext,
): Promise<ToolResponse<ListDeployedContractsResult>> {
  const capability = getSeedingCapability(context);
  if (isToolResponse(capability)) {
    return capability;
  }

  try {
    return createToolSuccess({
      contracts: capability.listDeployedContracts().map((deployedContract) => ({
        contractName: deployedContract.name,
        contractAddress: deployedContract.address,
        deployedAt: deployedContract.deployedAt,
      })),
    });
  } catch (error) {
    const errorInfo = classifySeedingError(error);
    return createToolError(errorInfo.code, errorInfo.message);
  }
}
