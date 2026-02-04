/**
 * Unit tests for build tool handler.
 *
 * Tests the build handler with BuildCapability and legacy build paths,
 * including success/failure scenarios and build options handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBuild } from './build.js';
import { ErrorCodes } from '../types/errors.js';
import { createMockSessionManager } from '../test-utils/index.js';
import * as sessionManagerModule from '../session-manager.js';
import * as knowledgeStoreModule from '../knowledge-store.js';
import type { BuildCapability } from '../../capabilities/types.js';

// Mock fs and child_process modules
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

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
      summarizeSession: vi.fn().mockResolvedValue({ sessionId: 'test', stepCount: 0, recipe: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      generatePriorKnowledge: vi.fn().mockResolvedValue(undefined),
      writeSessionMetadata: vi.fn().mockResolvedValue('test-session'),
      getGitInfoSync: vi.fn().mockReturnValue({ branch: 'main', commit: 'abc123' }),
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
      mockBuildCapability.build = vi.fn().mockResolvedValue({
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
        expect(result.result.extensionPathResolved).toBe('/path/to/dist/chrome');
      }
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: undefined,
        force: undefined,
      });
    });

    it('builds extension with explicit buildType', async () => {
      // Arrange
      mockBuildCapability.build = vi.fn().mockResolvedValue({
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
        expect(result.result.extensionPathResolved).toBe('/path/to/dist/chrome');
      }
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: 'build:test',
        force: undefined,
      });
    });

    it('builds extension with force flag', async () => {
      // Arrange
      mockBuildCapability.build = vi.fn().mockResolvedValue({
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
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: undefined,
        force: true,
      });
    });

    it('returns error when build fails with error message', async () => {
      // Arrange
      mockBuildCapability.build = vi.fn().mockResolvedValue({
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
      mockBuildCapability.build = vi.fn().mockResolvedValue({
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
      mockBuildCapability.build = vi.fn().mockRejectedValue(
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

  describe('handleBuild without capability', () => {
    it('returns error when node_modules does not exist', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
        expect(result.error.message).toContain('BuildCapability not available');
        expect(result.error.message).toContain('running in e2e mode');
      }
    });

    it('builds successfully in legacy mode when node_modules exists', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      const { execSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.buildType).toBe('build:test');
        expect(result.result.extensionPathResolved).toBe('/test/project/dist/chrome');
      }

      cwdSpy.mockRestore();
    });

    it('skips build when manifest exists and force is false', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      const { execSync } = await import('child_process');
      vi.mocked(existsSync).mockImplementation(() => {
        // node_modules exists, manifest exists
        return true;
      });
      const execSyncSpy = vi.mocked(execSync);

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(true);
      expect(execSyncSpy).not.toHaveBeenCalled();

      cwdSpy.mockRestore();
    });

    it('runs build when manifest does not exist', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      const { execSync } = await import('child_process');
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        // node_modules exists, manifest does not exist
        if (pathStr.includes('node_modules')) {
          return true;
        }
        if (pathStr.includes('manifest.json')) {
          return false;
        }
        return false;
      });
      const execSyncSpy = vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(true);
      expect(execSyncSpy).toHaveBeenCalledWith('yarn build:test', expect.any(Object));

      cwdSpy.mockRestore();
    });

    it('runs build when force is true', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      const { execSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      const execSyncSpy = vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({ force: true }, {});

      // Assert
      expect(result.ok).toBe(true);
      expect(execSyncSpy).toHaveBeenCalledWith('yarn build:test', expect.any(Object));

      cwdSpy.mockRestore();
    });

    it('returns error when dependencies are missing in legacy mode', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        // First call checks node_modules (exists), second call checks again (doesn't exist)
        if (pathStr.includes('node_modules')) {
          // Return true first time (for capability check), false second time (for legacy check)
          const callCount = vi.mocked(existsSync).mock.calls.length;
          return callCount === 1;
        }
        return false;
      });

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_DEPENDENCIES_MISSING);
        expect(result.error.message).toContain('Dependencies not installed');
      }

      cwdSpy.mockRestore();
    });

    it('returns error when build command fails', async () => {
      // Arrange
      const { existsSync } = await import('fs');
      const { execSync } = await import('child_process');
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        // node_modules exists, manifest does not exist
        if (pathStr.includes('node_modules')) {
          return true;
        }
        if (pathStr.includes('manifest.json')) {
          return false;
        }
        return false;
      });
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Build command failed');
      });

      // Mock process.cwd()
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project');

      // Act
      const result = await handleBuild({}, {});

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Build command failed');
      }

      cwdSpy.mockRestore();
    });
  });
});
