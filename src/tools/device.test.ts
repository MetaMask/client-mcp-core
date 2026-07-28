import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  closeAppTool,
  deviceClipboardTool,
  deviceContextTool,
  deviceLogsTool,
  deviceSwipeTool,
  dismissAlertTool,
  dismissKeyboardTool,
  generateLocatorsTool,
  getAlertTextTool,
  getWindowSizeTool,
  longPressTool,
  openAppTool,
  pressButtonTool,
  screenRecordingTool,
  scrollToElementTool,
  tapCoordinatesTool,
} from './device.js';
import { createMockSessionManager } from './test-utils/mock-factories.js';
import { ErrorCodes } from './types/errors.js';
import type { IPlatformDriver } from '../platform/types.js';
import type { ToolContext } from '../types/http.js';

function createContext(options: {
  hasActive?: boolean;
  driver?: Partial<IPlatformDriver> | undefined;
  artifactsDir?: string;
}): ToolContext {
  const { hasActive = true, driver, artifactsDir } = options;
  return {
    sessionManager: createMockSessionManager({ hasActive }),
    refMap: new Map(),
    workflowContext: {
      config: artifactsDir === undefined ? {} : { artifactsDir },
    },
    knowledgeStore: {},
    toolRegistry: new Map(),
    driver: driver as IPlatformDriver | undefined,
  } as unknown as ToolContext;
}

describe('getWindowSizeTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { getWindowSize: vi.fn() },
    });

    const result = await getWindowSizeTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks getWindowSize', async () => {
    const context = createContext({ driver: {} });

    const result = await getWindowSizeTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await getWindowSizeTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.getWindowSize and returns the size', async () => {
    const size = { width: 390, height: 844 };
    const getWindowSize = vi.fn().mockResolvedValue(size);
    const context = createContext({ driver: { getWindowSize } });

    const result = await getWindowSizeTool({}, context);

    expect(getWindowSize).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual(size);
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const getWindowSize = vi.fn().mockRejectedValue(new Error('size boom'));
    const context = createContext({ driver: { getWindowSize } });

    const result = await getWindowSizeTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('size boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const getWindowSize = vi.fn().mockRejectedValue('size string error');
    const context = createContext({ driver: { getWindowSize } });

    const result = await getWindowSizeTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('size string error');
    }
  });
});

describe('scrollToElementTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { scrollToElement: vi.fn() },
    });

    const result = await scrollToElementTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks scrollToElement', async () => {
    const context = createContext({ driver: {} });

    const result = await scrollToElementTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await scrollToElementTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.scrollToElement and returns the target', async () => {
    const scrollToElement = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { scrollToElement } });

    const result = await scrollToElementTool(
      { testId: 'foo', direction: 'down', maxAttempts: 5 },
      context,
    );

    expect(scrollToElement).toHaveBeenCalledWith(
      'testId',
      'foo',
      expect.any(Map),
      'down',
      5,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        scrolled: true,
        target: 'testId:foo',
      });
    }
  });

  it('returns MM_INVALID_INPUT when no target is provided', async () => {
    const scrollToElement = vi.fn();
    const context = createContext({ driver: { scrollToElement } });

    const result = await scrollToElementTool({}, context);

    expect(scrollToElement).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const scrollToElement = vi.fn().mockRejectedValue(new Error('scroll boom'));
    const context = createContext({ driver: { scrollToElement } });

    const result = await scrollToElementTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('scroll boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const scrollToElement = vi.fn().mockRejectedValue('scroll string error');
    const context = createContext({ driver: { scrollToElement } });

    const result = await scrollToElementTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('scroll string error');
    }
  });
});

describe('deviceSwipeTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { swipe: vi.fn() },
    });

    const result = await deviceSwipeTool({ direction: 'up' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks swipe', async () => {
    const context = createContext({ driver: {} });

    const result = await deviceSwipeTool({ direction: 'up' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await deviceSwipeTool({ direction: 'up' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.swipe and returns swiped', async () => {
    const swipe = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { swipe } });

    const result = await deviceSwipeTool(
      { direction: 'up', startX: 10, startY: 20, distance: 100 },
      context,
    );

    expect(swipe).toHaveBeenCalledWith('up', 10, 20, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({ swiped: true });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const swipe = vi.fn().mockRejectedValue(new Error('swipe boom'));
    const context = createContext({ driver: { swipe } });

    const result = await deviceSwipeTool({ direction: 'up' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('swipe boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const swipe = vi.fn().mockRejectedValue('swipe string error');
    const context = createContext({ driver: { swipe } });

    const result = await deviceSwipeTool({ direction: 'up' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('swipe string error');
    }
  });
});

describe('longPressTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { longPress: vi.fn() },
    });

    const result = await longPressTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks longPress', async () => {
    const context = createContext({ driver: {} });

    const result = await longPressTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await longPressTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.longPress and returns the target', async () => {
    const longPress = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { longPress } });

    const result = await longPressTool(
      { testId: 'foo', durationMs: 2000 },
      context,
    );

    expect(longPress).toHaveBeenCalledWith(
      'testId',
      'foo',
      expect.any(Map),
      2000,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        pressed: true,
        target: 'testId:foo',
      });
    }
  });

  it('returns MM_INVALID_INPUT when no target is provided', async () => {
    const longPress = vi.fn();
    const context = createContext({ driver: { longPress } });

    const result = await longPressTool({}, context);

    expect(longPress).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const longPress = vi.fn().mockRejectedValue(new Error('press boom'));
    const context = createContext({ driver: { longPress } });

    const result = await longPressTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('press boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const longPress = vi.fn().mockRejectedValue('press string error');
    const context = createContext({ driver: { longPress } });

    const result = await longPressTool({ testId: 'foo' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('press string error');
    }
  });
});

describe('tapCoordinatesTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { tapCoordinates: vi.fn() },
    });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks tapCoordinates', async () => {
    const context = createContext({ driver: {} });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.tapCoordinates and echoes coordinates', async () => {
    const tapCoordinates = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { tapCoordinates } });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(tapCoordinates).toHaveBeenCalledWith(5, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({ tapped: true, x: 5, y: 10 });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const tapCoordinates = vi.fn().mockRejectedValue(new Error('tap boom'));
    const context = createContext({ driver: { tapCoordinates } });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('tap boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const tapCoordinates = vi.fn().mockRejectedValue('tap string error');
    const context = createContext({ driver: { tapCoordinates } });

    const result = await tapCoordinatesTool({ x: 5, y: 10 }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('tap string error');
    }
  });
});

describe('dismissKeyboardTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { dismissKeyboard: vi.fn() },
    });

    const result = await dismissKeyboardTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks dismissKeyboard', async () => {
    const context = createContext({ driver: {} });

    const result = await dismissKeyboardTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await dismissKeyboardTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.dismissKeyboard and returns dismissed', async () => {
    const dismissKeyboard = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { dismissKeyboard } });

    const result = await dismissKeyboardTool({}, context);

    expect(dismissKeyboard).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({ dismissed: true });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const dismissKeyboard = vi.fn().mockRejectedValue(new Error('kb boom'));
    const context = createContext({ driver: { dismissKeyboard } });

    const result = await dismissKeyboardTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('kb boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const dismissKeyboard = vi.fn().mockRejectedValue('kb string error');
    const context = createContext({ driver: { dismissKeyboard } });

    const result = await dismissKeyboardTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('kb string error');
    }
  });
});

describe('dismissAlertTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { dismissAlert: vi.fn() },
    });

    const result = await dismissAlertTool({ accept: true }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks dismissAlert', async () => {
    const context = createContext({ driver: {} });

    const result = await dismissAlertTool({ accept: true }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await dismissAlertTool({ accept: true }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.dismissAlert and echoes accepted', async () => {
    const dismissAlert = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { dismissAlert } });

    const result = await dismissAlertTool({ accept: false }, context);

    expect(dismissAlert).toHaveBeenCalledWith(false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        dismissed: true,
        accepted: false,
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const dismissAlert = vi.fn().mockRejectedValue(new Error('alert boom'));
    const context = createContext({ driver: { dismissAlert } });

    const result = await dismissAlertTool({ accept: true }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('alert boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const dismissAlert = vi.fn().mockRejectedValue('alert string error');
    const context = createContext({ driver: { dismissAlert } });

    const result = await dismissAlertTool({ accept: true }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('alert string error');
    }
  });
});

describe('getAlertTextTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { getAlertText: vi.fn() },
    });

    const result = await getAlertTextTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks getAlertText', async () => {
    const context = createContext({ driver: {} });

    const result = await getAlertTextTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await getAlertTextTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.getAlertText and returns the text', async () => {
    const getAlertText = vi.fn().mockResolvedValue('Allow location access?');
    const context = createContext({ driver: { getAlertText } });

    const result = await getAlertTextTool({}, context);

    expect(getAlertText).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        text: 'Allow location access?',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const getAlertText = vi.fn().mockRejectedValue(new Error('alert boom'));
    const context = createContext({ driver: { getAlertText } });

    const result = await getAlertTextTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('alert boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const getAlertText = vi.fn().mockRejectedValue('alert string error');
    const context = createContext({ driver: { getAlertText } });

    const result = await getAlertTextTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('alert string error');
    }
  });
});

describe('openAppTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { openApp: vi.fn() },
    });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks openApp', async () => {
    const context = createContext({ driver: {} });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.openApp and echoes bundleId', async () => {
    const openApp = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { openApp } });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(openApp).toHaveBeenCalledWith('io.metamask');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        opened: true,
        bundleId: 'io.metamask',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const openApp = vi.fn().mockRejectedValue(new Error('open boom'));
    const context = createContext({ driver: { openApp } });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('open boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const openApp = vi.fn().mockRejectedValue('open string error');
    const context = createContext({ driver: { openApp } });

    const result = await openAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('open string error');
    }
  });
});

describe('closeAppTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { closeApp: vi.fn() },
    });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks closeApp', async () => {
    const context = createContext({ driver: {} });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.closeApp and echoes bundleId', async () => {
    const closeApp = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { closeApp } });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(closeApp).toHaveBeenCalledWith('io.metamask');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        closed: true,
        bundleId: 'io.metamask',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const closeApp = vi.fn().mockRejectedValue(new Error('close boom'));
    const context = createContext({ driver: { closeApp } });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('close boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const closeApp = vi.fn().mockRejectedValue('close string error');
    const context = createContext({ driver: { closeApp } });

    const result = await closeAppTool({ bundleId: 'io.metamask' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('close string error');
    }
  });
});

describe('pressButtonTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { pressButton: vi.fn() },
    });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks pressButton', async () => {
    const context = createContext({ driver: {} });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.pressButton and echoes button', async () => {
    const pressButton = vi.fn().mockResolvedValue(undefined);
    const context = createContext({ driver: { pressButton } });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(pressButton).toHaveBeenCalledWith('home');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        pressed: true,
        button: 'home',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const pressButton = vi.fn().mockRejectedValue(new Error('button boom'));
    const context = createContext({ driver: { pressButton } });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('button boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const pressButton = vi.fn().mockRejectedValue('button string error');
    const context = createContext({ driver: { pressButton } });

    const result = await pressButtonTool({ button: 'home' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('button string error');
    }
  });
});

describe('deviceContextTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { getDeviceContexts: vi.fn(), setDeviceContext: vi.fn() },
    });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks context methods', async () => {
    const context = createContext({ driver: {} });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('lists device contexts via driver.getDeviceContexts', async () => {
    const getDeviceContexts = vi
      .fn()
      .mockResolvedValue(['NATIVE_APP', 'WEBVIEW_1']);
    const setDeviceContext = vi.fn();
    const context = createContext({
      driver: { getDeviceContexts, setDeviceContext },
    });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(getDeviceContexts).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'list',
        contexts: ['NATIVE_APP', 'WEBVIEW_1'],
      });
    }
  });

  it('switches device context via driver.setDeviceContext', async () => {
    const getDeviceContexts = vi.fn();
    const setDeviceContext = vi.fn().mockResolvedValue(undefined);
    const context = createContext({
      driver: { getDeviceContexts, setDeviceContext },
    });

    const result = await deviceContextTool(
      { action: 'switch', name: 'WEBVIEW_1' },
      context,
    );

    expect(setDeviceContext).toHaveBeenCalledWith('WEBVIEW_1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'switch',
        switched: true,
        name: 'WEBVIEW_1',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const getDeviceContexts = vi
      .fn()
      .mockRejectedValue(new Error('context boom'));
    const setDeviceContext = vi.fn();
    const context = createContext({
      driver: { getDeviceContexts, setDeviceContext },
    });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('context boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const getDeviceContexts = vi.fn().mockRejectedValue('context string error');
    const setDeviceContext = vi.fn();
    const context = createContext({
      driver: { getDeviceContexts, setDeviceContext },
    });

    const result = await deviceContextTool({ action: 'list' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('context string error');
    }
  });
});

describe('deviceClipboardTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { getClipboard: vi.fn(), setClipboard: vi.fn() },
    });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks clipboard methods', async () => {
    const context = createContext({ driver: {} });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('reads the clipboard via driver.getClipboard', async () => {
    const getClipboard = vi.fn().mockResolvedValue('copied text');
    const setClipboard = vi.fn();
    const context = createContext({
      driver: { getClipboard, setClipboard },
    });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(getClipboard).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'read',
        text: 'copied text',
      });
    }
  });

  it('writes the clipboard via driver.setClipboard', async () => {
    const getClipboard = vi.fn();
    const setClipboard = vi.fn().mockResolvedValue(undefined);
    const context = createContext({
      driver: { getClipboard, setClipboard },
    });

    const result = await deviceClipboardTool(
      { action: 'write', text: 'hello' },
      context,
    );

    expect(setClipboard).toHaveBeenCalledWith('hello');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'write',
        success: true,
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const getClipboard = vi.fn().mockRejectedValue(new Error('clip boom'));
    const setClipboard = vi.fn();
    const context = createContext({
      driver: { getClipboard, setClipboard },
    });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('clip boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const getClipboard = vi.fn().mockRejectedValue('clip string error');
    const setClipboard = vi.fn();
    const context = createContext({
      driver: { getClipboard, setClipboard },
    });

    const result = await deviceClipboardTool({ action: 'read' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('clip string error');
    }
  });
});

describe('screenRecordingTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: {
        startScreenRecording: vi.fn(),
        stopScreenRecording: vi.fn(),
      },
    });

    const result = await screenRecordingTool({ action: 'start' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks recording methods', async () => {
    const context = createContext({ driver: {} });

    const result = await screenRecordingTool({ action: 'start' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await screenRecordingTool({ action: 'start' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('starts recording with a sandboxed output path resolved to artifactsDir', async () => {
    const startScreenRecording = vi.fn().mockResolvedValue(undefined);
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
      artifactsDir: '/tmp/artifacts',
    });

    const result = await screenRecordingTool(
      { action: 'start', outputPath: 'rec.mp4' },
      context,
    );

    expect(startScreenRecording).toHaveBeenCalledWith(
      path.resolve('/tmp/artifacts', 'rec.mp4'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'start',
        recording: true,
      });
    }
  });

  it('rejects an output path that escapes artifactsDir via traversal', async () => {
    const startScreenRecording = vi.fn();
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
      artifactsDir: '/tmp/artifacts',
    });

    const result = await screenRecordingTool(
      { action: 'start', outputPath: '../escape.mp4' },
      context,
    );

    expect(startScreenRecording).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
    }
  });

  it('rejects an absolute output path outside artifactsDir', async () => {
    const startScreenRecording = vi.fn();
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
      artifactsDir: '/tmp/artifacts',
    });

    const result = await screenRecordingTool(
      { action: 'start', outputPath: '/etc/passwd' },
      context,
    );

    expect(startScreenRecording).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
    }
  });

  it('rejects a custom output path when no artifactsDir is configured', async () => {
    const startScreenRecording = vi.fn();
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
    });

    const result = await screenRecordingTool(
      { action: 'start', outputPath: 'rec.mp4' },
      context,
    );

    expect(startScreenRecording).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_INVALID_INPUT);
    }
  });

  it('stops recording via driver.stopScreenRecording', async () => {
    const startScreenRecording = vi.fn();
    const stopScreenRecording = vi.fn().mockResolvedValue('/tmp/rec.mp4');
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
    });

    const result = await screenRecordingTool({ action: 'stop' }, context);

    expect(stopScreenRecording).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({
        action: 'stop',
        path: '/tmp/rec.mp4',
      });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const startScreenRecording = vi
      .fn()
      .mockRejectedValue(new Error('rec boom'));
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
    });

    const result = await screenRecordingTool({ action: 'start' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('rec boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const startScreenRecording = vi.fn().mockRejectedValue('rec string error');
    const stopScreenRecording = vi.fn();
    const context = createContext({
      driver: { startScreenRecording, stopScreenRecording },
    });

    const result = await screenRecordingTool({ action: 'start' }, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('rec string error');
    }
  });
});

describe('deviceLogsTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { getLogs: vi.fn() },
    });

    const result = await deviceLogsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks getLogs', async () => {
    const context = createContext({ driver: {} });

    const result = await deviceLogsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await deviceLogsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.getLogs and returns the log shape', async () => {
    const logs = {
      entries: [
        { timestamp: '2026-01-01T00:00:00Z', level: 'info', message: 'hi' },
      ],
      source: 'logcat',
    };
    const getLogs = vi.fn().mockResolvedValue(logs);
    const context = createContext({ driver: { getLogs } });

    const result = await deviceLogsTool(
      { durationSeconds: 30, filter: 'MetaMask' },
      context,
    );

    expect(getLogs).toHaveBeenCalledWith(30, 'MetaMask');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual(logs);
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const getLogs = vi.fn().mockRejectedValue(new Error('logs boom'));
    const context = createContext({ driver: { getLogs } });

    const result = await deviceLogsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('logs boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const getLogs = vi.fn().mockRejectedValue('logs string error');
    const context = createContext({ driver: { getLogs } });

    const result = await deviceLogsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('logs string error');
    }
  });
});

describe('generateLocatorsTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MM_NO_ACTIVE_SESSION when no session is active', async () => {
    const context = createContext({
      hasActive: false,
      driver: { generateLocators: vi.fn() },
    });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_NO_ACTIVE_SESSION);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when driver lacks generateLocators', async () => {
    const context = createContext({ driver: {} });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('returns MM_DEVICE_NOT_AVAILABLE when no driver is present', async () => {
    const context = createContext({ driver: undefined });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_NOT_AVAILABLE);
    }
  });

  it('delegates to driver.generateLocators and wraps the locators', async () => {
    const locators = [
      {
        description: 'Button label="Submit"',
        frame: { x: 0, y: 0, width: 100, height: 44 },
        suggestions: [
          { strategy: 'identifier', value: 'submit', confidence: 'high' },
        ],
      },
    ];
    const generateLocators = vi.fn().mockResolvedValue(locators);
    const context = createContext({ driver: { generateLocators } });

    const result = await generateLocatorsTool({}, context);

    expect(generateLocators).toHaveBeenCalledWith();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({ locators });
    }
  });

  it('returns an empty list when no interactive elements are found', async () => {
    const generateLocators = vi.fn().mockResolvedValue([]);
    const context = createContext({ driver: { generateLocators } });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toStrictEqual({ locators: [] });
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED when the driver throws', async () => {
    const generateLocators = vi
      .fn()
      .mockRejectedValue(new Error('locators boom'));
    const context = createContext({ driver: { generateLocators } });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('locators boom');
    }
  });

  it('returns MM_DEVICE_ACTION_FAILED for non-Error throwables', async () => {
    const generateLocators = vi.fn().mockRejectedValue('locators string error');
    const context = createContext({ driver: { generateLocators } });

    const result = await generateLocatorsTool({}, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.MM_DEVICE_ACTION_FAILED);
      expect(result.error.message).toContain('locators string error');
    }
  });
});
