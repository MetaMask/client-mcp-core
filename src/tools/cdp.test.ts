import { afterEach, describe, it, expect, vi } from 'vitest';

import { cdpTool } from './cdp.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import type { CdpInput } from './types';
import { ErrorCodes } from './types/errors.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { ToolContext } from '../types/http.js';

const DEFAULT_TIMEOUT_MS = 30_000;

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

const cdpInput: CdpInput = {
  method: 'Runtime.evaluate',
  params: { expression: '1+1', returnByValue: true },
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

describe('cdpTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { cdp: vi.fn() },
    });

    const result = await cdpTool(cdpInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_CDP_FAILED when no driver is available', async () => {
    const context = createContext({ driver: undefined });

    const result = await cdpTool(cdpInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
      expect(result.error.message).toContain('No platform driver');
    }
  });

  it('dispatches to driver.cdp and returns the raw result', async () => {
    const cdp = vi.fn().mockResolvedValue({ ok: true, result: { value: 2 } });
    const context = createContext({ driver: { cdp } });

    const result = await cdpTool(cdpInput, context);

    expect(cdp).toHaveBeenCalledWith(cdpInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.method).toBe('Runtime.evaluate');
      expect(result.result.result).toStrictEqual({ value: 2 });
    }
  });

  it('passes through the error code from a blocked outcome', async () => {
    const cdp = vi.fn().mockResolvedValue({
      ok: false,
      code: ErrorCodes.MM_CDP_BLOCKED,
      message: 'CDP method "Browser.close" is blocked',
    });
    const context = createContext({ driver: { cdp } });

    const result = await cdpTool(
      { method: 'Browser.close', timeoutMs: DEFAULT_TIMEOUT_MS },
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CDP_BLOCKED);
      expect(result.error.message).toContain('Browser.close');
    }
  });

  it('passes through a failed outcome with its preserved message', async () => {
    const cdp = vi.fn().mockResolvedValue({
      ok: false,
      code: ErrorCodes.MM_CDP_FAILED,
      message: '[HERMES_TARGET_NOT_FOUND] No Hermes debug target found',
    });
    const context = createContext({ driver: { cdp } });

    const result = await cdpTool(cdpInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
      expect(result.error.message).toContain('HERMES_TARGET_NOT_FOUND');
    }
  });

  it('returns MM_CDP_FAILED when the driver throws', async () => {
    const cdp = vi.fn().mockRejectedValue(new Error('socket boom'));
    const context = createContext({ driver: { cdp } });

    const result = await cdpTool(cdpInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
      expect(result.error.message).toContain('socket boom');
    }
  });

  it('handles non-Error throwables', async () => {
    const cdp = vi.fn().mockRejectedValue('string error');
    const context = createContext({ driver: { cdp } });

    const result = await cdpTool(cdpInput, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_CDP_FAILED);
      expect(result.error.message).toContain('string error');
    }
  });
});
