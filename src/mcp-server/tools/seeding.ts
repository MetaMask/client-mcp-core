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
} from "../types/index.js";
import { ErrorCodes } from "../types/index.js";
import { createErrorResponse } from "../utils/index.js";
import { getSessionManager } from "../session-manager.js";
import type { ContractSeedingCapability } from "../../capabilities/types.js";
import { runTool } from "./run-tool.js";
import { classifySeedingError } from "./error-classification.js";

export type SeedingToolOptions = HandlerOptions & {
  seedingCapability?: ContractSeedingCapability;
};

function checkSeedingCapability<T>(
  toolName: string,
  input: unknown,
  options: SeedingToolOptions | undefined,
  startTime: number,
): McpResponse<T> | ContractSeedingCapability {
  const sessionManager = getSessionManager();
  const sessionId = sessionManager.getSessionId();

  if (!options?.seedingCapability) {
    return createErrorResponse(
      ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE,
      `ContractSeedingCapability not available. The ${toolName} tool requires running in e2e mode with the MetaMask extension wrapper, which provides Anvil chain and contract deployment support.`,
      { capability: "ContractSeedingCapability", input },
      sessionId,
      startTime,
    ) as McpResponse<T>;
  }

  return options.seedingCapability;
}

function isCapability(
  result: McpResponse<unknown> | ContractSeedingCapability,
): result is ContractSeedingCapability {
  return typeof result === "object" && result !== null && "deployContract" in result;
}

export async function handleSeedContract(
  input: SeedContractInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<SeedContractResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<SeedContractResult>(
    "mm_seed_contract",
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<SeedContractInput, SeedContractResult>({
    toolName: "mm_seed_contract",
    input,
    options,
    observationPolicy: "none",

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

    sanitizeInputForRecording: () => ({
      contractName: input.contractName,
      hardfork: input.hardfork ?? "prague",
    }),
  });
}

export async function handleSeedContracts(
  input: SeedContractsInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<SeedContractsResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<SeedContractsResult>(
    "mm_seed_contracts",
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<SeedContractsInput, SeedContractsResult>({
    toolName: "mm_seed_contracts",
    input,
    options,
    observationPolicy: "none",

    execute: async () => {
      const seedResult = await seedingCapability.deployContracts(
        input.contracts,
        { hardfork: input.hardfork },
      );

      return {
        deployed: seedResult.deployed.map((d) => ({
          contractName: d.name,
          contractAddress: d.address,
          deployedAt: d.deployedAt,
        })),
        failed: seedResult.failed.map((f) => ({
          contractName: f.name,
          error: f.error,
        })),
      };
    },

    classifyError: classifySeedingError,

    sanitizeInputForRecording: () => ({
      contracts: input.contracts,
      hardfork: input.hardfork ?? "prague",
    }),
  });
}

export async function handleGetContractAddress(
  input: GetContractAddressInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<GetContractAddressResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<GetContractAddressResult>(
    "mm_get_contract_address",
    input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<GetContractAddressInput, GetContractAddressResult>({
    toolName: "mm_get_contract_address",
    input,
    options,
    observationPolicy: "none",

    execute: async () => {
      const address = seedingCapability.getContractAddress(input.contractName);

      return {
        contractName: input.contractName,
        contractAddress: address,
      };
    },

    classifyError: classifySeedingError,

    sanitizeInputForRecording: () => ({
      contractName: input.contractName,
    }),
  });
}

export async function handleListDeployedContracts(
  _input: ListDeployedContractsInput,
  options?: SeedingToolOptions,
): Promise<McpResponse<ListDeployedContractsResult>> {
  const startTime = Date.now();
  const capabilityOrError = checkSeedingCapability<ListDeployedContractsResult>(
    "mm_list_contracts",
    _input,
    options,
    startTime,
  );

  if (!isCapability(capabilityOrError)) {
    return capabilityOrError;
  }

  const seedingCapability = capabilityOrError;

  return runTool<ListDeployedContractsInput, ListDeployedContractsResult>({
    toolName: "mm_list_contracts",
    input: _input,
    options,
    observationPolicy: "none",

    execute: async () => {
      const deployed = seedingCapability.listDeployedContracts();

      return {
        contracts: deployed.map(
          (d: { name: string; address: string; deployedAt: string }) => ({
            contractName: d.name,
            contractAddress: d.address,
            deployedAt: d.deployedAt,
          }),
        ),
      };
    },

    classifyError: classifySeedingError,
  });
}
