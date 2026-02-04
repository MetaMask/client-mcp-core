import { describe, it, expect } from 'vitest';
import type {
  EnvironmentConfig,
  E2EEnvironmentConfig,
  ProdEnvironmentConfig,
  WorkflowContext,
} from './context.js';
import {
  isE2EConfig,
  isProdConfig,
  hasCapability,
} from './context.js';

describe('isE2EConfig', () => {
  it('returns true for E2E environment config', () => {
    const config: EnvironmentConfig = {
      environment: 'e2e',
      extensionName: 'MetaMask',
    };

    const result = isE2EConfig(config);

    expect(result).toBe(true);
  });

  it('returns true for E2E config with all optional fields', () => {
    const config: EnvironmentConfig = {
      environment: 'e2e',
      extensionName: 'MetaMask',
      defaultPassword: 'password123',
      toolPrefix: 'mm',
      artifactsDir: './test-artifacts',
      defaultChainId: 1337,
      ports: {
        anvil: 8545,
        fixtureServer: 12345,
      },
      fork: {
        url: 'https://mainnet.infura.io/v3/key',
        blockNumber: 18000000,
      },
    };

    const result = isE2EConfig(config);

    expect(result).toBe(true);
  });

  it('returns false for production environment config', () => {
    const config: EnvironmentConfig = {
      environment: 'prod',
      extensionName: 'MetaMask',
    };

    const result = isE2EConfig(config);

    expect(result).toBe(false);
  });

  it('returns false for production config with optional fields', () => {
    const config: EnvironmentConfig = {
      environment: 'prod',
      extensionName: 'MetaMask',
      defaultPassword: 'password123',
      toolPrefix: 'mm',
      defaultChainId: 1,
    };

    const result = isE2EConfig(config);

    expect(result).toBe(false);
  });

  it('narrows type to E2EEnvironmentConfig when true', () => {
    const config: EnvironmentConfig = {
      environment: 'e2e',
      extensionName: 'MetaMask',
      ports: { anvil: 8545 },
    };

    if (isE2EConfig(config)) {
      expect(config.ports?.anvil).toBe(8545);
    }
  });
});

describe('isProdConfig', () => {
  it('returns true for production environment config', () => {
    const config: EnvironmentConfig = {
      environment: 'prod',
      extensionName: 'MetaMask',
    };

    const result = isProdConfig(config);

    expect(result).toBe(true);
  });

  it('returns true for production config with optional fields', () => {
    const config: EnvironmentConfig = {
      environment: 'prod',
      extensionName: 'MetaMask',
      defaultPassword: 'password123',
      toolPrefix: 'mm',
      artifactsDir: './artifacts',
      defaultChainId: 1,
    };

    const result = isProdConfig(config);

    expect(result).toBe(true);
  });

  it('returns false for E2E environment config', () => {
    const config: EnvironmentConfig = {
      environment: 'e2e',
      extensionName: 'MetaMask',
    };

    const result = isProdConfig(config);

    expect(result).toBe(false);
  });

  it('returns false for E2E config with all optional fields', () => {
    const config: EnvironmentConfig = {
      environment: 'e2e',
      extensionName: 'MetaMask',
      defaultPassword: 'password123',
      toolPrefix: 'mm',
      artifactsDir: './test-artifacts',
      defaultChainId: 1337,
      ports: {
        anvil: 8545,
        fixtureServer: 12345,
      },
    };

    const result = isProdConfig(config);

    expect(result).toBe(false);
  });

  it('narrows type to ProdEnvironmentConfig when true', () => {
    const config: EnvironmentConfig = {
      environment: 'prod',
      extensionName: 'MetaMask',
      defaultChainId: 1,
    };

    if (isProdConfig(config)) {
      expect(config.defaultChainId).toBe(1);
    }
  });
});

describe('hasCapability', () => {
  it('returns true when capability is defined', () => {
    const context: WorkflowContext = {
      build: {
        build: async () => ({
          success: true,
          extensionPath: '/path/to/extension',
          durationMs: 100,
        }),
        getExtensionPath: () => '/path/to/extension',
        isBuilt: async () => true,
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'build');

    expect(result).toBe(true);
  });

  it('returns true when fixture capability is defined', () => {
    const context: WorkflowContext = {
      fixture: {
        start: async () => {},
        stop: async () => {},
        getDefaultState: () => ({ data: {} }),
        getOnboardingState: () => ({ data: {} }),
        resolvePreset: () => ({ data: {} }),
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'fixture');

    expect(result).toBe(true);
  });

  it('returns true when chain capability is defined', () => {
    const context: WorkflowContext = {
      chain: {
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        setPort: () => {},
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'chain');

    expect(result).toBe(true);
  });

  it('returns true when contractSeeding capability is defined', () => {
    const context: WorkflowContext = {
      contractSeeding: {
        deployContract: async () => ({
          name: 'hst',
          address: '0x123',
          deployedAt: new Date().toISOString(),
        }),
        deployContracts: async () => ({
          deployed: [],
          failed: [],
        }),
        getContractAddress: () => null,
        listDeployedContracts: () => [],
        getAvailableContracts: () => [],
        clearRegistry: () => {},
        initialize: () => {},
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'contractSeeding');

    expect(result).toBe(true);
  });

  it('returns true when stateSnapshot capability is defined', () => {
    const context: WorkflowContext = {
      stateSnapshot: {
        getState: async () => ({
          isLoaded: true,
          currentUrl: 'chrome://extension',
          extensionId: 'abc123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x123',
          networkName: 'Ethereum',
          chainId: 1,
          balance: '1.0',
        }),
        detectCurrentScreen: async () => 'home',
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'stateSnapshot');

    expect(result).toBe(true);
  });

  it('returns true when mockServer capability is defined', () => {
    const context: WorkflowContext = {
      mockServer: {
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        getServer: () => ({}),
        getPort: () => 3000,
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'mockServer');

    expect(result).toBe(true);
  });

  it('returns false when capability is undefined', () => {
    const context: WorkflowContext = {
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    const result = hasCapability(context, 'build');

    expect(result).toBe(false);
  });

  it('returns false when multiple capabilities are undefined', () => {
    const context: WorkflowContext = {
      build: {
        build: async () => ({
          success: true,
          extensionPath: '/path',
          durationMs: 100,
        }),
        getExtensionPath: () => '/path',
        isBuilt: async () => true,
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    expect(hasCapability(context, 'fixture')).toBe(false);
    expect(hasCapability(context, 'chain')).toBe(false);
    expect(hasCapability(context, 'contractSeeding')).toBe(false);
  });

  it('narrows type when capability is present', () => {
    const context: WorkflowContext = {
      build: {
        build: async () => ({
          success: true,
          extensionPath: '/path',
          durationMs: 100,
        }),
        getExtensionPath: () => '/path',
        isBuilt: async () => true,
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    if (hasCapability(context, 'build')) {
      expect(context.build).toBeDefined();
      expect(context.build.getExtensionPath()).toBe('/path');
    }
  });

  it('allows type-safe capability access after guard', () => {
    const context: WorkflowContext = {
      fixture: {
        start: async () => {},
        stop: async () => {},
        getDefaultState: () => ({ data: { test: true } }),
        getOnboardingState: () => ({ data: {} }),
        resolvePreset: () => ({ data: {} }),
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    if (hasCapability(context, 'fixture')) {
      const state = context.fixture.getDefaultState();
      expect(state.data).toEqual({ test: true });
    }
  });

  it('handles context with all capabilities defined', () => {
    const context: WorkflowContext = {
      build: {
        build: async () => ({
          success: true,
          extensionPath: '/path',
          durationMs: 100,
        }),
        getExtensionPath: () => '/path',
        isBuilt: async () => true,
      },
      fixture: {
        start: async () => {},
        stop: async () => {},
        getDefaultState: () => ({ data: {} }),
        getOnboardingState: () => ({ data: {} }),
        resolvePreset: () => ({ data: {} }),
      },
      chain: {
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        setPort: () => {},
      },
      contractSeeding: {
        deployContract: async () => ({
          name: 'hst',
          address: '0x123',
          deployedAt: new Date().toISOString(),
        }),
        deployContracts: async () => ({
          deployed: [],
          failed: [],
        }),
        getContractAddress: () => null,
        listDeployedContracts: () => [],
        getAvailableContracts: () => [],
        clearRegistry: () => {},
        initialize: () => {},
      },
      stateSnapshot: {
        getState: async () => ({
          isLoaded: true,
          currentUrl: 'chrome://extension',
          extensionId: 'abc123',
          isUnlocked: true,
          currentScreen: 'home',
          accountAddress: '0x123',
          networkName: 'Ethereum',
          chainId: 1,
          balance: '1.0',
        }),
        detectCurrentScreen: async () => 'home',
      },
      mockServer: {
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        getServer: () => ({}),
        getPort: () => 3000,
      },
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
    };

    expect(hasCapability(context, 'build')).toBe(true);
    expect(hasCapability(context, 'fixture')).toBe(true);
    expect(hasCapability(context, 'chain')).toBe(true);
    expect(hasCapability(context, 'contractSeeding')).toBe(true);
    expect(hasCapability(context, 'stateSnapshot')).toBe(true);
    expect(hasCapability(context, 'mockServer')).toBe(true);
  });
});
