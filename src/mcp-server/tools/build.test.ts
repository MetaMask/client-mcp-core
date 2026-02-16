/**
 * Unit tests for build tool handler.
 *
 * Tests the build handler with BuildCapability and legacy build paths,
 * including success/failure scenarios and build options handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleBuild } from './build.js';
import type { BuildCapability } from '../../capabilities/types.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import * as sessionManagerModule from '../session-manager.js';
import { createMockSessionManager } from '../test-utils';
import { ErrorCodes } from '../types/errors.js';
import { launchInputSchema } from '../schemas.js';

describe('build', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockBuildCapability: BuildCapability;

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

    mockBuildCapability = {
      build: vi.fn(),
      getExtensionPath: vi.fn(),
      isBuilt: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleBuild with capability', () => {
    it('builds extension successfully with default buildType', async () => {
      // Arrange
      const mockedBuild = vi
        .spyOn(mockBuildCapability, 'build')
        .mockResolvedValue({
          success: true,
          extensionPath: '/path/to/dist/chrome',
          durationMs: 5000,
        });

      // Act
      const result = await handleBuild(
        {},
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.buildType).toBe('build:test');
        expect(result.result.extensionPathResolved).toBe(
          '/path/to/dist/chrome',
        );
        expect(result.result.watchModeSupported).toBe(false);
      }
      expect(mockedBuild).toHaveBeenCalledWith({
        buildType: undefined,
        force: undefined,
      });
    });

    it('builds extension with explicit buildType', async () => {
      // Arrange
      const mockedBuild = vi
        .spyOn(mockBuildCapability, 'build')
        .mockResolvedValue({
          success: true,
          extensionPath: '/path/to/dist/chrome',
          durationMs: 5000,
        });

      // Act
      const result = await handleBuild(
        { buildType: 'build:test' },
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.buildType).toBe('build:test');
        expect(result.result.extensionPathResolved).toBe(
          '/path/to/dist/chrome',
        );
      }
      expect(mockedBuild).toHaveBeenCalledWith({
        buildType: 'build:test',
        force: undefined,
      });
    });

    it('reports watchModeSupported when capability has startWatchMode', async () => {
      // Arrange
      const watchCapability: BuildCapability = {
        build: vi.fn().mockResolvedValue({
          success: true,
          extensionPath: '/path/to/dist',
          durationMs: 100,
        }),
        getExtensionPath: vi.fn().mockReturnValue('/path/to/dist'),
        isBuilt: vi.fn().mockResolvedValue(true),
        startWatchMode: vi.fn(),
        stopWatchMode: vi.fn(),
        isWatching: vi.fn().mockReturnValue(false),
      };

      // Act
      const result = await handleBuild({}, { buildCapability: watchCapability });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.watchModeSupported).toBe(true);
      }
    });

    it('builds extension with force flag', async () => {
      // Arrange
      const mockedBuild = vi
        .spyOn(mockBuildCapability, 'build')
        .mockResolvedValue({
          success: true,
          extensionPath: '/path/to/dist/chrome',
          durationMs: 5000,
        });

      // Act
      const result = await handleBuild(
        { force: true },
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(true);
      expect(mockedBuild).toHaveBeenCalledWith({
        buildType: undefined,
        force: true,
      });
    });

    it('returns error when build fails with error message', async () => {
      // Arrange
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: false,
        extensionPath: '',
        durationMs: 1000,
        error: 'Compilation error',
      });

      // Act
      const result = await handleBuild(
        {},
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Compilation error');
      }
    });

    it('returns error when build fails without error message', async () => {
      // Arrange
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: false,
        extensionPath: '',
        durationMs: 1000,
      });

      // Act
      const result = await handleBuild(
        {},
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Unknown error');
      }
    });

    it('returns error when build throws exception', async () => {
      // Arrange
      vi.spyOn(mockBuildCapability, 'build').mockRejectedValue(
        new Error('Build process crashed'),
      );

      // Act
      const result = await handleBuild(
        {},
        { buildCapability: mockBuildCapability },
      );

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Build process crashed');
      }
    });
  });

  describe('launchInputSchema watch mode refinements', () => {
    it('fails when ios launch omits simulatorDeviceId', () => {
      const result = launchInputSchema.safeParse({
        platform: 'ios',
        appBundlePath: '/path/to/app.app',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'simulatorDeviceId is required when platform is "ios"',
        );
      }
    });

    it('fails when ios launch omits appBundlePath', () => {
      const result = launchInputSchema.safeParse({
        platform: 'ios',
        simulatorDeviceId: 'sim-1234',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'appBundlePath is required when platform is "ios"',
        );
      }
    });

    it('passes when ios launch provides watch mode options', () => {
      const result = launchInputSchema.safeParse({
        platform: 'ios',
        simulatorDeviceId: 'sim-1234',
        appBundlePath: '/path/to/app.app',
        useWatchMode: true,
        watchModePort: 8081,
      });

      expect(result.success).toBe(true);
    });
  });
});
