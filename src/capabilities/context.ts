import type {
  BuildCapability,
  FixtureCapability,
  ChainCapability,
  ContractSeedingCapability,
  StateSnapshotCapability,
  MockServerCapability,
} from './types.js';

/**
 * Environment mode discriminator.
 * - 'e2e': End-to-end testing environment with local chain, fixtures, and contract seeding
 * - 'prod': Production-like environment without test infrastructure
 */
export type EnvironmentMode = 'e2e' | 'prod';

/**
 * Base configuration fields shared across all environment modes.
 */
export type BaseEnvironmentConfig = {
  /** Human-readable name of the extension (e.g., "MetaMask") */
  extensionName: string;
  /** Default password for wallet unlock operations */
  defaultPassword?: string;
  /** Prefix for MCP tool names (e.g., "mm" -> "mm_build", "mm_launch") */
  toolPrefix?: string;
  /** Directory for storing screenshots and other artifacts */
  artifactsDir?: string;
};

/**
 * Configuration specific to E2E testing environment.
 * Includes local chain settings and test infrastructure options.
 */
export type E2EEnvironmentConfig = BaseEnvironmentConfig & {
  /** Discriminator for E2E environment */
  environment: 'e2e';
  /** Chain ID for local Anvil node (default: 1337) */
  defaultChainId?: number;
  /** Port configuration for test infrastructure */
  ports?: {
    /** Anvil local chain port (default: 8545) */
    anvil?: number;
    /** Fixture server port (default: 12345) */
    fixtureServer?: number;
  };
  /** Fork configuration for mainnet forking */
  fork?: {
    /** RPC URL to fork from */
    url?: string;
    /** Block number to fork at */
    blockNumber?: number;
  };
};

/**
 * Configuration specific to production-like environment.
 * Minimal configuration without test infrastructure.
 */
export type ProdEnvironmentConfig = BaseEnvironmentConfig & {
  /** Discriminator for production environment */
  environment: 'prod';
  /** Optional chain ID for network detection (no local chain) */
  defaultChainId?: number;
};

/**
 * Union type for environment-specific configuration.
 * Use discriminated union pattern with `environment` field.
 *
 * @example
 * ```typescript
 * function processConfig(config: EnvironmentConfig) {
 *   if (config.environment === 'e2e') {
 *     // TypeScript knows config has E2E-specific fields
 *     console.log(config.ports?.anvil);
 *   }
 * }
 * ```
 */
export type EnvironmentConfig = E2EEnvironmentConfig | ProdEnvironmentConfig;

/**
 * Type guard to check if config is for E2E environment.
 *
 * @param config - The environment configuration to check
 * @returns True if the config is for E2E environment, false otherwise
 */
export function isE2EConfig(
  config: EnvironmentConfig,
): config is E2EEnvironmentConfig {
  return config.environment === 'e2e';
}

/**
 * Type guard to check if config is for production environment.
 *
 * @param config - The environment configuration to check
 * @returns True if the config is for production environment, false otherwise
 */
export function isProdConfig(
  config: EnvironmentConfig,
): config is ProdEnvironmentConfig {
  return config.environment === 'prod';
}

export type WorkflowContext = {
  build?: BuildCapability;
  fixture?: FixtureCapability;
  chain?: ChainCapability;
  contractSeeding?: ContractSeedingCapability;
  stateSnapshot?: StateSnapshotCapability;
  mockServer?: MockServerCapability;
  config: EnvironmentConfig;
};

/**
 * Type guard to check if a capability is available in the workflow context.
 *
 * @param context - The workflow context to check
 * @param key - The capability key to verify
 * @returns True if the capability is defined, narrowing the type accordingly
 */
export function hasCapability<Key extends keyof WorkflowContext>(
  context: WorkflowContext,
  key: Key,
): context is WorkflowContext & Required<Pick<WorkflowContext, Key>> {
  return context[key] !== undefined;
}
