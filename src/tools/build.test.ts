/**
 * Unit tests for build tool handler.
 *
 * Tests the build handler with BuildCapability and legacy build paths,
 * including success/failure scenarios and build options handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTool } from './build.js';
import type { BuildCapability } from '../capabilities/types.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { ToolContext } from '../types/http.js';

function createMockContext(
  options: { buildCapability?: BuildCapability } = {},
) {
  const sessionManager = createMockSessionManager({
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

  sessionManager.getBuildCapability.mockReturnValue(options.buildCapability);

  return {
    sessionManager,
    page: {},
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
  } as unknown as ToolContext;
}

describe('buildTool', () => {
  let mockBuildCapability: BuildCapability;

  beforeEach(() => {
    mockBuildCapability = {
      build: vi.fn(),
      getExtensionPath: vi.fn(),
      isBuilt: vi.fn(),
    };
  });

  describe('with capability', () => {
    it('builds extension successfully with default buildType', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: true,
        extensionPath: '/path/to/dist/chrome',
        durationMs: 5000,
      });
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({}, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.buildType).toBe('build:test');
        expect(result.result.extensionPathResolved).toBe(
          '/path/to/dist/chrome',
        );
      }
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: undefined,
        force: undefined,
      });
    });

    it('builds extension with explicit buildType', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: true,
        extensionPath: '/path/to/dist/chrome',
        durationMs: 5000,
      });
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({ buildType: 'build:test' }, context);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.buildType).toBe('build:test');
        expect(result.result.extensionPathResolved).toBe(
          '/path/to/dist/chrome',
        );
      }
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: 'build:test',
        force: undefined,
      });
    });

    it('builds extension with force flag', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: true,
        extensionPath: '/path/to/dist/chrome',
        durationMs: 5000,
      });
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({ force: true }, context);

      expect(result.ok).toBe(true);
      expect(mockBuildCapability.build).toHaveBeenCalledWith({
        buildType: undefined,
        force: true,
      });
    });

    it('returns error when build fails with error message', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: false,
        extensionPath: '',
        durationMs: 1000,
        error: 'Compilation error',
      });
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Compilation error');
      }
    });

    it('returns error when build fails without error message', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockResolvedValue({
        success: false,
        extensionPath: '',
        durationMs: 1000,
      });
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Unknown error');
      }
    });

    it('returns error when build throws exception', async () => {
      vi.spyOn(mockBuildCapability, 'build').mockRejectedValue(
        new Error('Build process crashed'),
      );
      const context = createMockContext({
        buildCapability: mockBuildCapability,
      });

      const result = await buildTool({}, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.MM_BUILD_FAILED);
        expect(result.error.message).toContain('Build process crashed');
      }
    });
  });

  it('returns error when build capability is unavailable', async () => {
    const context = createMockContext();

    const result = await buildTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CAPABILITY_NOT_AVAILABLE);
      expect(result.error.message).toContain('BuildCapability not available');
    }
  });
});
