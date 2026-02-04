import type { ContractSeedingCapability } from '../../capabilities/types.js';
import { getSessionManager } from '../session-manager.js';
import { classifySeedingError } from './error-classification.js';
import { runTool } from './run-tool.js';
import type {
  SeedContractInput,
  SeedContractsInput,
  GetContractAddressInput,
  ListDeployedContractsInput,
  SeedContractResult,
  SeedContractsResult,
  GetContractAddressResult,
  ListDeployedContractsResult,
  McpResponse,
  HandlerOptions,
} from '../types';
import { ErrorCodes } from '../types';
import { createErrorResponse } from '../utils';

/**
 *
 */
export type SeedingToolOptions = HandlerOptions & {
  /**
   *
   */
  seedingCapability?: ContractSeedingCapability;
};

/**
 * Validates that the seeding capability is available, returning either the capability or an error response.
 *
 * @param toolName The name of the tool requesting the capability
 * @param input The input provided to the tool
 * @param options Tool options containing the seeding capability
 * @param startTime Timestamp when the tool execution started
 * @returns The seeding capability if available, or an error response if not
 */
function checkSeedingCapability<Type>(
  toolName: string,
  input: unknown,
  options: SeedingToolOptions | undefined,
  startTime: number,
): McpResponse<Type> | ContractSeedingCapability {
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (!options?.seedingCapability) {
    return createErrorResponse(
      ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE,
      `ContractSeedingCapability not available. The ${toolName} tool requires running in e2e mode with the MetaMask extension wrapper, which provides Anvil chain and contract deployment support.`,
      { capability: 'ContractSeedingCapability', input },
      sessionId,
      startTime,
    ) as McpResponse<Type>;
  }

  return options.seedingCapability;
}

/**
 * Type guard to check if a result is a ContractSeedingCapability.
 *
 * @param result The value to check
 * @returns True if result is a ContractSeedingCapability, false if it's an error response
 */
function isCapability(
  result: McpResponse<unknown> | ContractSeedingCapability,
): result is ContractSeedingCapability {
  return (
    typeof result === 'object' && result !== null && 'deployContract' in result
  );
}

/**
 * Handles the mm_seed_contract tool to deploy a single smart contract.
 *
 * @param input The contract name and deployment options
 * @param options Tool options including seeding capability
 * @returns Promise resolving to the deployment result with contract address
 */
export async function handleSeedContract(
  input: SeedContractInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<SeedContractResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<SeedContractResult>(
    'mm_seed_contract',
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<SeedContractInput, SeedContractResult>({
    toolName: 'mm_seed_contract',
    input,
    options,
    observationPolicy: 'none',

    /**
     * Executes the contract deployment using the seeding capability.
     *
     * @returns The deployed contract details including name, address, and timestamp
     */
    execute: async () => {
      const deployed = await seedingCapability.deployContract(
        input.contractName,
        {
          hardfork: input.hardfork,
          deployerOptions: input.deployerOptions,
        },
      );

      return {
        contractName: deployed.name,
        contractAddress: deployed.address,
        deployedAt: deployed.deployedAt,
      };
    },

    classifyError: classifySeedingError,

    /**
     * Sanitizes the input for recording in the knowledge store.
     *
     * @returns The sanitized input containing contract name and hardfork
     */
    sanitizeInputForRecording: () => ({
      contractName: input.contractName,
      hardfork: input.hardfork ?? 'prague',
    }),
  });
}

/**
 * Handles the mm_seed_contracts tool to deploy multiple smart contracts.
 *
 * @param input The list of contract names and deployment options
 * @param options Tool options including seeding capability
 * @returns Promise resolving to deployment results with deployed and failed contracts
 */
export async function handleSeedContracts(
  input: SeedContractsInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<SeedContractsResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<SeedContractsResult>(
    'mm_seed_contracts',
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<SeedContractsInput, SeedContractsResult>({
    toolName: 'mm_seed_contracts',
    input,
    options,
    observationPolicy: 'none',

    /**
     * Executes the multi-contract deployment using the seeding capability.
     *
     * @returns The deployment results with deployed and failed contract lists
     */
    execute: async () => {
      const seedResult = await seedingCapability.deployContracts(
        input.contracts,
        { hardfork: input.hardfork },
      );

      return {
        deployed: seedResult.deployed.map((deployedContract) => ({
          contractName: deployedContract.name,
          contractAddress: deployedContract.address,
          deployedAt: deployedContract.deployedAt,
        })),
        failed: seedResult.failed.map((failedDeployment) => ({
          contractName: failedDeployment.name,
          error: failedDeployment.error,
        })),
      };
    },

    classifyError: classifySeedingError,

    /**
     * Sanitizes the input for recording in the knowledge store.
     *
     * @returns The sanitized input containing contracts list and hardfork
     */
    sanitizeInputForRecording: () => ({
      contracts: input.contracts,
      hardfork: input.hardfork ?? 'prague',
    }),
  });
}

/**
 * Handles the mm_get_contract_address tool to retrieve a deployed contract's address.
 *
 * @param input The contract name to look up
 * @param options Tool options including seeding capability
 * @returns Promise resolving to the contract address or null if not found
 */
export async function handleGetContractAddress(
  input: GetContractAddressInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<GetContractAddressResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<GetContractAddressResult>(
    'mm_get_contract_address',
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<GetContractAddressInput, GetContractAddressResult>({
    toolName: 'mm_get_contract_address',
    input,
    options,
    observationPolicy: 'none',

    /**
     * Executes the contract address lookup using the seeding capability.
     *
     * @returns The contract name and its deployed address
     */
    execute: async () => {
      const address = seedingCapability.getContractAddress(input.contractName);

      return {
        contractName: input.contractName,
        contractAddress: address,
      };
    },

    classifyError: classifySeedingError,

    /**
     * Sanitizes the input for recording in the knowledge store.
     *
     * @returns The sanitized input containing the contract name
     */
    sanitizeInputForRecording: () => ({
      contractName: input.contractName,
    }),
  });
}

/**
 * Handles the mm_list_contracts tool to list all deployed contracts in the session.
 *
 * @param _input Unused input parameter (no input required for this tool)
 * @param options Tool options including seeding capability
 * @returns Promise resolving to a list of all deployed contracts with their addresses
 */
export async function handleListDeployedContracts(
  _input: ListDeployedContractsInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<ListDeployedContractsResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<ListDeployedContractsResult>(
    'mm_list_contracts',
    _input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<ListDeployedContractsInput, ListDeployedContractsResult>({
    toolName: 'mm_list_contracts',
    input: _input,
    options,
    observationPolicy: 'none',

    /**
     * Executes the contract listing using the seeding capability.
     *
     * @returns The list of all deployed contracts with their details
     */
    execute: async () => {
      const deployed = seedingCapability.listDeployedContracts();

      return {
        contracts: deployed.map(
          (deployedContract: {
            /**
             * The contract name
             */
            name: string;
            /**
             * The contract's deployed address
             */
            address: string;
            /**
             * The deployment timestamp
             */
            deployedAt: string;
          }) => ({
            contractName: deployedContract.name,
            contractAddress: deployedContract.address,
            deployedAt: deployedContract.deployedAt,
          }),
        ),
      };
    },

    classifyError: classifySeedingError,
  });
}
