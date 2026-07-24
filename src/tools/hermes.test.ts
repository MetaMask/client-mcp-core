import { describe, it, expect, vi, afterEach } from 'vitest';

import { hermesTargetsTool } from './hermes.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { HermesTargetsInput } from './types';
import { ErrorCodes } from './types/errors.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { ToolContext } from '../types/http.js';

function createContext(options: {
  hasActive?: boolean;
  driver?: Partial<IPlatformDriver> | undefined;
}): ToolContext {
  const { hasActive = true, driver } = options;
  return {
    sessionManager: createMockSessionManager({ hasActive }),
    refMap: new Map(),
    workflowContext: {},
    knowledgeStore: {},
    toolRegistry: new Map(),
    driver: driver as IPlatformDriver | undefined,
  } as unknown as ToolContext;
}

const targetsInput: HermesTargetsInput = {};

describe('hermesTargetsTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { hermesTargets: vi.fn() },
    });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_HERMES_NOT_AVAILABLE when driver lacks hermesTargets', async () => {
    const context = createContext({ driver: {} });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_HERMES_NOT_AVAILABLE);
    }
  });

  it('returns MM_HERMES_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_HERMES_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.hermesTargets and returns the report', async () => {
    const report = {
      metroPort: 8081,
      expectedAppId: 'io.metamask',
      filterBypassed: false,
      metroDown: false,
      targetsDiscovered: 1,
      candidates: [],
      chosen: { id: 'page-1', logicalDeviceId: 'dev-1' },
    };
    const hermesTargets = vi.fn().mockResolvedValue(report);
    const context = createContext({ driver: { hermesTargets } });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(hermesTargets).toHaveBeenCalledWith(targetsInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual(report);
    }
  });

  it('returns MM_HERMES_FAILED when the driver throws', async () => {
    const hermesTargets = vi
      .fn()
      .mockRejectedValue(new Error('discovery boom'));
    const context = createContext({ driver: { hermesTargets } });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_HERMES_FAILED);
      expect(result.error.message).toContain('discovery boom');
    }
  });

  it('returns MM_HERMES_FAILED for non-Error throwables', async () => {
    const hermesTargets = vi.fn().mockRejectedValue('discovery string error');
    const context = createContext({ driver: { hermesTargets } });

    const result = await hermesTargetsTool(targetsInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_HERMES_FAILED);
      expect(result.error.message).toContain('discovery string error');
    }
  });
});
