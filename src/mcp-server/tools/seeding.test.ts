/**
 * Unit tests for seeding tool handlers.
 *
 * Tests contract deployment handlers including single/multiple contract deployment,
 * address lookup, and contract listing with ContractSeedingCapability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  handleSeedContract,
  handleSeedContracts,
  handleGetContractAddress,
  handleListDeployedContracts,
} from './seeding.js';
import type { ContractSeedingCapability } from '../../capabilities/types.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';
import { ErrorCodes } from '../types/errors.js';

describe('seeding', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockSeedingCapability: ContractSeedingCapability;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager({
      hasActive: true,
      sessionId: 'test-session-123',
      sessionMetadata: {
        schemaVersion: 1,
        sessionId: 'test-session-123',
        createdAt: new Date().toISOString(),
        flowTags: [],
        tags: [],
        launch: { stateMode: 'default' },
      },
    });
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
    // Mock knowledge store to prevent "not initialized" errors
    vi.spyOn(knowledgeStoreModule, 'knowledgeStore', 'get').mockReturnValue({
      recordStep: vi.fn().mockResolvedValue(undefined),
      getLastSteps: vi.fn().mockResolvedValue([]),
      searchSteps: vi.fn().mockResolvedValue([]),
      summarizeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
    } as any);

    // Create fresh mock seeding capability
    mockSeedingCapability = {
      deployContract: vi.fn(),
      deployContracts: vi.fn(),
      getContractAddress: vi.fn(),
      listDeployedContracts: vi.fn(),
      getAvailableContracts: vi.fn(),
      clearRegistry: vi.fn(),
      initialize: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleSeedContract', () => {
    it('deploys a single contract successfully', async () => {
      // Arrange
      const deployedAt = new Date().toISOString();
      const mockedDeployContract = vi
        .spyOn(mockSeedingCapability, 'deployContract')
        .mockResolvedValue({
          name: 'hst',
          address: '0x1234567890123456789012345678901234567890',
          deployedAt,
        });

      // Act
      const result = await handleSeedContract(
        { contractName: 'hst' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.contractName).toBe('hst');
        expect(result.result.contractAddress).toBe(
          '0x1234567890123456789012345678901234567890',
        );
        expect(result.result.deployedAt).toBe(deployedAt);
      }
      expect(mockedDeployContract).toHaveBeenCalledWith('hst', {
        hardfork: undefined,
        deployerOptions: undefined,
      });
    });

    it('deploys contract with custom hardfork', async () => {
      // Arrange
      const deployedAt = new Date().toISOString();
      const mockedDeployContract = vi
        .spyOn(mockSeedingCapability, 'deployContract')
        .mockResolvedValue({
          name: 'nfts',
          address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          deployedAt,
        });

      // Act
      const result = await handleSeedContract(
        { contractName: 'nfts', hardfork: 'shanghai' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      expect(mockedDeployContract).toHaveBeenCalledWith('nfts', {
        hardfork: 'shanghai',
        deployerOptions: undefined,
      });
    });

    it('deploys contract with deployer options', async () => {
      // Arrange
      const deployedAt = new Date().toISOString();
      const mockedDeployContract = vi
        .spyOn(mockSeedingCapability, 'deployContract')
        .mockResolvedValue({
          name: 'piggybank',
          address: '0x9876543210987654321098765432109876543210',
          deployedAt,
        });

      // Act
      const result = await handleSeedContract(
        {
          contractName: 'piggybank',
          deployerOptions: {
            fromAddress: '0x1111111111111111111111111111111111111111',
          },
        },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      expect(mockedDeployContract).toHaveBeenCalledWith('piggybank', {
        hardfork: undefined,
        deployerOptions: {
          fromAddress: '0x1111111111111111111111111111111111111111',
        },
      });
    });

    it('returns error when seeding capability not available', async () => {
      // Act
      const result = await handleSeedContract(
        { contractName: 'hst' },
        { seedingCapability: undefined },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain(
          'ContractSeedingCapability not available',
        );
      }
    });

    it('returns error when deployment fails', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'deployContract').mockRejectedValue(
        new Error('Contract not found: unknown'),
      );

      // Act
      const result = await handleSeedContract(
        { contractName: 'hst' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CONTRACT_NOT_FOUND);
        expect(result.error.message).toContain('Contract not found');
      }
    });

    it('returns error when deployment fails with generic error', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'deployContract').mockRejectedValue(
        new Error('Deployment failed'),
      );

      // Act
      const result = await handleSeedContract(
        { contractName: 'hst' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Deployment failed');
      }
    });
  });

  describe('handleSeedContracts', () => {
    it('deploys multiple contracts successfully', async () => {
      // Arrange
      const deployedAt1 = new Date().toISOString();
      const deployedAt2 = new Date(Date.now() + 1000).toISOString();
      const mockedDeployContracts = vi
        .spyOn(mockSeedingCapability, 'deployContracts')
        .mockResolvedValue({
          deployed: [
            {
              name: 'hst',
              address: '0x1234567890123456789012345678901234567890',
              deployedAt: deployedAt1,
            },
            {
              name: 'nfts',
              address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
              deployedAt: deployedAt2,
            },
          ],
          failed: [],
        });

      // Act
      const result = await handleSeedContracts(
        { contracts: ['hst', 'nfts'] },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.deployed).toHaveLength(2);
        expect(result.result.deployed[0].contractName).toBe('hst');
        expect(result.result.deployed[1].contractName).toBe('nfts');
        expect(result.result.failed).toHaveLength(0);
      }
      expect(mockedDeployContracts).toHaveBeenCalledWith(['hst', 'nfts'], {
        hardfork: undefined,
      });
    });

    it('deploys contracts with custom hardfork', async () => {
      // Arrange
      const deployedAt = new Date().toISOString();
      const mockedDeployContracts = vi
        .spyOn(mockSeedingCapability, 'deployContracts')
        .mockResolvedValue({
          deployed: [
            {
              name: 'hst',
              address: '0x1234567890123456789012345678901234567890',
              deployedAt,
            },
          ],
          failed: [],
        });

      // Act
      const result = await handleSeedContracts(
        { contracts: ['hst'], hardfork: 'shanghai' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      expect(mockedDeployContracts).toHaveBeenCalledWith(['hst'], {
        hardfork: 'shanghai',
      });
    });

    it('handles partial deployment failures', async () => {
      // Arrange
      const deployedAt = new Date().toISOString();
      vi.spyOn(mockSeedingCapability, 'deployContracts').mockResolvedValue({
        deployed: [
          {
            name: 'hst',
            address: '0x1234567890123456789012345678901234567890',
            deployedAt,
          },
        ],
        failed: [
          {
            name: 'nfts',
            error: 'Contract deployment failed',
          },
        ],
      });

      // Act
      const result = await handleSeedContracts(
        { contracts: ['hst', 'nfts'] },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.deployed).toHaveLength(1);
        expect(result.result.failed).toHaveLength(1);
        expect(result.result.failed[0].contractName).toBe('nfts');
        expect(result.result.failed[0].error).toBe(
          'Contract deployment failed',
        );
      }
    });

    it('returns error when seeding capability not available', async () => {
      // Act
      const result = await handleSeedContracts(
        { contracts: ['hst'] },
        { seedingCapability: undefined },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain(
          'ContractSeedingCapability not available',
        );
      }
    });

    it('returns error when deployment fails completely', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'deployContracts').mockRejectedValue(
        new Error('Anvil not running'),
      );

      // Act
      const result = await handleSeedContracts(
        { contracts: ['hst'] },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Anvil not running');
      }
    });
  });

  describe('handleGetContractAddress', () => {
    it('returns contract address when found', async () => {
      // Arrange
      const mockedGetContractAddress = vi
        .spyOn(mockSeedingCapability, 'getContractAddress')
        .mockReturnValue('0x1234567890123456789012345678901234567890');

      // Act
      const result = await handleGetContractAddress(
        { contractName: 'hst' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.contractName).toBe('hst');
        expect(result.result.contractAddress).toBe(
          '0x1234567890123456789012345678901234567890',
        );
      }
      expect(mockedGetContractAddress).toHaveBeenCalledWith('hst');
    });

    it('returns null when contract not found', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'getContractAddress').mockReturnValue(
        null,
      );

      // Act
      const result = await handleGetContractAddress(
        { contractName: 'nfts' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.contractName).toBe('nfts');
        expect(result.result.contractAddress).toBeNull();
      }
    });

    it('returns error when seeding capability not available', async () => {
      // Act
      const result = await handleGetContractAddress(
        { contractName: 'hst' },
        { seedingCapability: undefined },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain(
          'ContractSeedingCapability not available',
        );
      }
    });

    it('returns error when lookup fails', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'getContractAddress').mockImplementation(
        () => {
          throw new Error('Registry error');
        },
      );

      // Act
      const result = await handleGetContractAddress(
        { contractName: 'hst' },
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Registry error');
      }
    });
  });

  describe('handleListDeployedContracts', () => {
    it('returns list of deployed contracts', async () => {
      // Arrange
      const deployedAt1 = new Date().toISOString();
      const deployedAt2 = new Date(Date.now() + 1000).toISOString();
      const mockedListDeployedContracts = vi
        .spyOn(mockSeedingCapability, 'listDeployedContracts')
        .mockReturnValue([
          {
            name: 'hst',
            address: '0x1234567890123456789012345678901234567890',
            deployedAt: deployedAt1,
          },
          {
            name: 'nfts',
            address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            deployedAt: deployedAt2,
          },
        ]);

      // Act
      const result = await handleListDeployedContracts(
        {},
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.contracts).toHaveLength(2);
        expect(result.result.contracts[0].contractName).toBe('hst');
        expect(result.result.contracts[0].contractAddress).toBe(
          '0x1234567890123456789012345678901234567890',
        );
        expect(result.result.contracts[0].deployedAt).toBe(deployedAt1);
        expect(result.result.contracts[1].contractName).toBe('nfts');
        expect(result.result.contracts[1].contractAddress).toBe(
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        );
        expect(result.result.contracts[1].deployedAt).toBe(deployedAt2);
      }
      expect(mockedListDeployedContracts).toHaveBeenCalled();
    });

    it('returns empty list when no contracts deployed', async () => {
      // Arrange
      vi.spyOn(mockSeedingCapability, 'listDeployedContracts').mockReturnValue(
        [],
      );

      // Act
      const result = await handleListDeployedContracts(
        {},
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.contracts).toHaveLength(0);
      }
    });

    it('returns error when seeding capability not available', async () => {
      // Act
      const result = await handleListDeployedContracts(
        {},
        { seedingCapability: undefined },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain(
          'ContractSeedingCapability not available',
        );
      }
    });

    it('returns error when listing fails', async () => {
      // Arrange
      vi.spyOn(
        mockSeedingCapability,
        'listDeployedContracts',
      ).mockImplementation(() => {
        throw new Error('Registry error');
      });

      // Act
      const result = await handleListDeployedContracts(
        {},
        { seedingCapability: mockSeedingCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Registry error');
      }
    });
  });
});
