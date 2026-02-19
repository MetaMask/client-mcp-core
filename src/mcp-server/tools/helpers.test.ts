/**
 * Unit tests for tool helper functions.
 *
 * Tests session validation, observation collection, error handling, and step recording.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { collectObservation } from './helpers';
import type { ObservationLevel } from './helpers';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';

describe('helpers', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue(
      mockSessionManager,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('collectObservation', () => {
    describe('when level is "none"', () => {
      it('returns default observation with empty arrays', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'none';
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('does not query extension state', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'none';
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: {} as any,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        await collectObservation(mockDriver as any, level);

        // Assert
        expect(mockSessionManager.getExtensionState).not.toHaveBeenCalled();
      });
    });

    describe('when level is "minimal"', () => {
      it('returns observation with state only', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'minimal';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: '0x123',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        };
        mockDriver.getAppState.mockResolvedValue(mockState);
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.state).toStrictEqual(mockState);
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('uses preset state when provided', async () => {
        // Arrange
        const mockDriver = { getAppState: vi.fn() };
        const level: ObservationLevel = 'minimal';
        const presetState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-456/home.html',
          extensionId: 'ext-456',
          isUnlocked: false,
          currentScreen: 'unlock' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: presetState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(
          mockDriver as any,
          level,
          presetState,
        );

        // Assert
        expect(mockSessionManager.getExtensionState).not.toHaveBeenCalled();
        expect(result.state).toStrictEqual(presetState);
      });
    });

    describe('when level is "full"', () => {
      it('collects state, testIds, and a11y tree', async () => {
        // Arrange
        const mockDriver = {
          getAppState: vi.fn(),
          getTestIds: vi.fn(),
          getAccessibilityTree: vi.fn(),
        };
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: '0x123',
          networkName: 'Ethereum Mainnet',
          chainId: 1,
          balance: '1.5 ETH',
        };
        const mockTestIds = [
          { testId: 'send-button', tag: 'button', text: 'Send', visible: true },
        ];
        const mockA11yNodes = [
          { ref: 'e1', role: 'button', name: 'Send', path: [] },
        ];
        const mockRefMap = new Map([['e1', '[data-testid="send-button"]']]);

        mockDriver.getAppState.mockResolvedValue(mockState);
        mockDriver.getTestIds.mockResolvedValue(mockTestIds);
        mockDriver.getAccessibilityTree.mockResolvedValue({
          nodes: mockA11yNodes,
          refMap: mockRefMap,
        });
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: mockTestIds,
          a11y: { nodes: mockA11yNodes },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.state).toStrictEqual(mockState);
        expect(result.testIds).toStrictEqual(mockTestIds);
        expect(result.a11y.nodes).toStrictEqual(mockA11yNodes);
        expect(mockSessionManager.setRefMap).toHaveBeenCalledWith(mockRefMap);
      });

      it('returns default observation when page is undefined', async () => {
        // Arrange
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        vi.spyOn(mockSessionManager, 'getExtensionState').mockResolvedValue(
          mockState,
        );
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(undefined, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });

      it('returns default observation when discovery throws error', async () => {
        // Arrange
        const mockDriver = {
          getAppState: vi.fn(),
          getTestIds: vi.fn(),
          getAccessibilityTree: vi.fn(),
        };
        const level: ObservationLevel = 'full';
        const mockState = {
          isLoaded: true,
          currentUrl: 'chrome-extension://ext-123/home.html',
          extensionId: 'ext-123',
          isUnlocked: true,
          currentScreen: 'home' as const,
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
        mockDriver.getAppState.mockResolvedValue(mockState);
        mockDriver.getTestIds.mockRejectedValue(new Error('Page closed'));
        vi.spyOn(
          knowledgeStoreModule,
          'createDefaultObservation',
        ).mockReturnValue({
          state: mockState,
          testIds: [],
          a11y: { nodes: [] },
        });

        // Act
        const result = await collectObservation(mockDriver as any, level);

        // Assert
        expect(result.testIds).toStrictEqual([]);
        expect(result.a11y.nodes).toStrictEqual([]);
      });
    });
  });
});
