/**
 * Unit tests for seeding tool handlers.
 *
 * Tests contract deployment handlers including single/multiple contract deployment,
 * address lookup, and contract listing with ContractSeedingCapability.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  seedContractTool,
  seedContractsTool,
  getContractAddressTool,
  listContractsTool,
} from './seeding.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types';
import type { ContractSeedingCapability } from '../capabilities/types.js';
import type { ToolContext } from '../types/http.js';

function createMockSeedingCapability(): ContractSeedingCapability {
  return {
    deployContract: vi.fn(),
    deployContracts: vi.fn(),
    getContractAddress: vi.fn(),
    listDeployedContracts: vi.fn(),
    getAvailableContracts: vi.fn(),
    clearRegistry: vi.fn(),
    initialize: vi.fn(),
  };
}

function createMockContext(
  options: {
    hasActive?: boolean;
    workflowCapability?: ContractSeedingCapability;
    sessionCapability?: ContractSeedingCapability;
  } = {},
): ToolContext {
  const { hasActive = true, workflowCapability, sessionCapability } = options;

  const sessionManager = createMockSessionManager({ hasActive });
  sessionManager.getContractSeedingCapability.mockReturnValue(
    sessionCapability,
  );

  return {
    sessionManager,
    page: {} as ToolContext['page'],
    refMap: new Map(),
    workflowContext: {
      config: {
        environment: 'e2e',
        extensionName: 'MetaMask',
      },
      contractSeeding: workflowCapability,
    },
    knowledgeStore: {} as ToolContext['knowledgeStore'],
    toolRegistry: new Map(),
  } as unknown as ToolContext;
}

describe('seeding tools', () => {
  describe('seedContractTool', () => {
    it('deploys a single contract using workflowContext capability', async () => {
      const deployedAt = new Date().toISOString();
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'deployContract').mockResolvedValue({
        name: 'hst',
        address: '0x1234567890123456789012345678901234567890',
        deployedAt,
      });
      const context = createMockContext({ workflowCapability: capability });

      const result = await seedContractTool({ contractName: 'hst' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({
          contractName: 'hst',
          contractAddress: '0x1234567890123456789012345678901234567890',
          deployedAt,
        });
      }
      expect(capability.deployContract).toHaveBeenCalledWith('hst', {
        hardfork: undefined,
        deployerOptions: undefined,
      });
      expect(
        context.sessionManager.getContractSeedingCapability,
      ).not.toHaveBeenCalled();
    });

    it('falls back to session manager capability when workflowContext lacks one', async () => {
      const deployedAt = new Date().toISOString();
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'deployContract').mockResolvedValue({
        name: 'nfts',
        address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        deployedAt,
      });
      const context = createMockContext({ sessionCapability: capability });

      const result = await seedContractTool(
        { contractName: 'nfts', hardfork: 'shanghai' },
        context,
      );

      expect(result.ok).toBe(true);
      expect(capability.deployContract).toHaveBeenCalledWith('nfts', {
        hardfork: 'shanghai',
        deployerOptions: undefined,
      });
      expect(
        context.sessionManager.getContractSeedingCapability,
      ).toHaveBeenCalled();
    });

    it('returns contract not found errors from deployment failures', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'deployContract').mockRejectedValue(
        new Error('Contract not found: unknown'),
      );
      const context = createMockContext({ workflowCapability: capability });

      const result = await seedContractTool({ contractName: 'hst' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CONTRACT_NOT_FOUND);
        expect(result.error.message).toContain('Contract not found');
      }
    });

    it('returns capability unavailable when no seeding capability exists', async () => {
      const context = createMockContext();

      const result = await seedContractTool({ contractName: 'hst' }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
      }
    });
  });

  describe('seedContractsTool', () => {
    it('deploys multiple contracts and maps deployed and failed results', async () => {
      const deployedAt = new Date().toISOString();
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'deployContracts').mockResolvedValue({
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
      const context = createMockContext({ workflowCapability: capability });

      const result = await seedContractsTool(
        { contracts: ['hst', 'nfts'] },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({
          deployed: [
            {
              contractName: 'hst',
              contractAddress: '0x1234567890123456789012345678901234567890',
              deployedAt,
            },
          ],
          failed: [
            {
              contractName: 'nfts',
              error: 'Contract deployment failed',
            },
          ],
        });
      }
      expect(capability.deployContracts).toHaveBeenCalledWith(['hst', 'nfts'], {
        hardfork: undefined,
      });
    });

    it('returns seed failed errors for complete deployment failures', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'deployContracts').mockRejectedValue(
        new Error('Anvil not running'),
      );
      const context = createMockContext({ workflowCapability: capability });

      const result = await seedContractsTool({ contracts: ['hst'] }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Anvil not running');
      }
    });

    it('returns capability unavailable when no seeding capability exists', async () => {
      const context = createMockContext();

      const result = await seedContractsTool({ contracts: ['hst'] }, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
      }
    });
  });

  describe('getContractAddressTool', () => {
    it('returns the contract address when found', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'getContractAddress').mockReturnValue(
        '0x1234567890123456789012345678901234567890',
      );
      const context = createMockContext({ workflowCapability: capability });

      const result = await getContractAddressTool(
        { contractName: 'hst' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({
          contractName: 'hst',
          contractAddress: '0x1234567890123456789012345678901234567890',
        });
      }
      expect(capability.getContractAddress).toHaveBeenCalledWith('hst');
    });

    it('returns null when the contract address is missing', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'getContractAddress').mockReturnValue(null);
      const context = createMockContext({ workflowCapability: capability });

      const result = await getContractAddressTool(
        { contractName: 'nfts' },
        context,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({
          contractName: 'nfts',
          contractAddress: null,
        });
      }
    });

    it('returns error when getContractAddress throws', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'getContractAddress').mockImplementation(() => {
        throw new Error('Connection lost');
      });
      const context = createMockContext({ workflowCapability: capability });

      const result = await getContractAddressTool(
        { contractName: 'hst' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Connection lost');
      }
    });

    it('returns capability unavailable when no seeding capability exists', async () => {
      const context = createMockContext();

      const result = await getContractAddressTool(
        { contractName: 'hst' },
        context,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
      }
    });
  });

  describe('listContractsTool', () => {
    it('returns the list of deployed contracts', async () => {
      const deployedAt1 = new Date().toISOString();
      const deployedAt2 = new Date(Date.now() + 1000).toISOString();
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'listDeployedContracts').mockReturnValue([
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
      const context = createMockContext({ workflowCapability: capability });

      const result = await listContractsTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toStrictEqual({
          contracts: [
            {
              contractName: 'hst',
              contractAddress: '0x1234567890123456789012345678901234567890',
              deployedAt: deployedAt1,
            },
            {
              contractName: 'nfts',
              contractAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
              deployedAt: deployedAt2,
            },
          ],
        });
      }
      expect(capability.listDeployedContracts).toHaveBeenCalled();
    });

    it('returns capability unavailable when no seeding capability exists', async () => {
      const context = createMockContext();

      const result = await listContractsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain(
          'ContractSeedingCapability not available',
        );
      }
    });

    it('returns no active session when the session is missing', async () => {
      const context = createMockContext({ hasActive: false });

      const result = await listContractsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
      }
    });

    it('returns error when listDeployedContracts throws', async () => {
      const capability = createMockSeedingCapability();
      vi.spyOn(capability, 'listDeployedContracts').mockImplementation(() => {
        throw new Error('Connection lost');
      });
      const context = createMockContext({ workflowCapability: capability });

      const result = await listContractsTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_SEED_FAILED);
        expect(result.error.message).toContain('Connection lost');
      }
    });
  });
});
