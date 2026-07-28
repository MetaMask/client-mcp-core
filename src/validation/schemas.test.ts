/**
 * Unit tests for Zod schema refinement validations.
 *
 * Tests the custom refine() validations for:
 * - switchToTabInputSchema (role or url required)
 * - closeTabInputSchema (role or url required)
 * - clipboardInputSchema (text required when action is 'write')
 */

import { describe, it, expect } from 'vitest';

import {
  switchToTabInputSchema,
  closeTabInputSchema,
  clipboardInputSchema,
  navigateInputSchema,
  networkMockRouteRuleSchema,
  mockNetworkInputSchema,
  launchInputSchema,
  scrollToElementInputSchema,
  deviceSwipeInputSchema,
  tapCoordinatesInputSchema,
  dismissAlertInputSchema,
  openAppInputSchema,
  deviceContextInputSchema,
  deviceClipboardInputSchema,
  screenRecordingInputSchema,
  deviceLogsInputSchema,
} from './schemas.js';

describe('switchToTabInputSchema', () => {
  describe('refine validation: role or url required', () => {
    it('passes with role only', () => {
      const input = { role: 'extension' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url only', () => {
      const input = { url: 'https://example.com' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with both role and url', () => {
      const input = { role: 'dapp' as const, url: 'https://example.com' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails with neither role nor url', () => {
      const input = {};
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty role and no url', () => {
      const input = { role: undefined };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty url and no role', () => {
      const input = { url: undefined };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('passes with notification role', () => {
      const input = { role: 'notification' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with other role', () => {
      const input = { role: 'other' as const };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url containing special characters', () => {
      const input = { url: 'https://app.uniswap.org/swap?chain=ethereum' };
      const result = switchToTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});

describe('closeTabInputSchema', () => {
  describe('refine validation: role or url required', () => {
    it('passes with role only', () => {
      const input = { role: 'notification' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url only', () => {
      const input = { url: 'https://example.com' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with both role and url', () => {
      const input = { role: 'dapp' as const, url: 'https://example.com' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails with neither role nor url', () => {
      const input = {};
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty role and no url', () => {
      const input = { role: undefined };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('fails with empty url and no role', () => {
      const input = { url: undefined };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Either role or url must be provided',
        );
      }
    });

    it('passes with dapp role', () => {
      const input = { role: 'dapp' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with other role', () => {
      const input = { role: 'other' as const };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with url containing special characters', () => {
      const input = { url: 'https://app.uniswap.org/swap?chain=ethereum' };
      const result = closeTabInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});

describe('clipboardInputSchema', () => {
  describe('refine validation: text required when action is write', () => {
    it('passes write action with text', () => {
      const input = { action: 'write' as const, text: 'hello world' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action without text', () => {
      const input = { action: 'read' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action with text (text is optional for read)', () => {
      const input = { action: 'read' as const, text: 'ignored' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails write action without text', () => {
      const input = { action: 'write' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('fails write action with undefined text', () => {
      const input = { action: 'write' as const, text: undefined };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('fails write action with empty string text', () => {
      const input = { action: 'write' as const, text: '' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "text is required when action is 'write'",
        );
      }
    });

    it('passes write action with whitespace text', () => {
      const input = { action: 'write' as const, text: '   ' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with long text', () => {
      const longText = 'a'.repeat(10000);
      const input = { action: 'write' as const, text: longText };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with special characters', () => {
      const input = {
        action: 'write' as const,
        text: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes write action with newlines', () => {
      const input = { action: 'write' as const, text: 'line1\nline2\nline3' };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes read action without any text property', () => {
      const input = { action: 'read' as const };
      const result = clipboardInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });
  });
});

describe('navigateInputSchema', () => {
  describe('refine validation: url required when screen is "url"', () => {
    it('passes with screen "home"', () => {
      const input = { screen: 'home' as const };
      const result = navigateInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with screen "settings"', () => {
      const input = { screen: 'settings' as const };
      const result = navigateInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('passes with screen "url" and url provided', () => {
      const input = { screen: 'url' as const, url: 'https://example.com' };
      const result = navigateInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('fails with screen "url" and no url', () => {
      const input = { screen: 'url' as const };
      const result = navigateInputSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'url is required when screen is "url"',
        );
      }
    });

    it('fails with screen "url" and empty url', () => {
      const input = { screen: 'url' as const, url: '' };
      const result = navigateInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });
});

describe('network mock schemas', () => {
  const route = {
    id: 'accounts-supported-networks',
    method: 'get',
    url: 'https://accounts.api.cx.metamask.io/v2/supportedNetworks',
    response: { json: { fullSupport: [1] } },
  };

  it('normalizes route methods and applies response defaults', () => {
    const result = networkMockRouteRuleSchema.safeParse(route);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.method).toBe('GET');
      expect(result.data.response.status).toBe(200);
    }
  });

  it('rejects non-http URLs', () => {
    const result = networkMockRouteRuleSchema.safeParse({
      ...route,
      url: 'chrome-extension://abc/home.html',
    });

    expect(result.success).toBe(false);
  });

  it('rejects malformed URLs', () => {
    const result = networkMockRouteRuleSchema.safeParse({
      ...route,
      url: 'not a url',
    });

    expect(result.success).toBe(false);
  });

  it('requires a response body', () => {
    const result = networkMockRouteRuleSchema.safeParse({
      ...route,
      response: { status: 200 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects response with both json and body', () => {
    const result = networkMockRouteRuleSchema.safeParse({
      ...route,
      response: { json: { ok: true }, body: 'ok' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts mock-network add with one route', () => {
    const result = mockNetworkInputSchema.safeParse({
      action: 'add',
      rule: route,
    });

    expect(result.success).toBe(true);
  });

  it('rejects mock-network add with both rule and routes', () => {
    const result = mockNetworkInputSchema.safeParse({
      action: 'add',
      rule: route,
      routes: [route],
    });

    expect(result.success).toBe(false);
  });
});

describe('launchInputSchema', () => {
  it('preserves platform field', () => {
    const input = { platform: 'ios' };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe('ios');
    }
  });

  it('preserves deviceId field', () => {
    const input = { deviceId: 'emulator-5554' };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deviceId).toBe('emulator-5554');
    }
  });

  it('preserves platform and deviceId together', () => {
    const input = {
      platform: 'android' as const,
      deviceId: 'emulator-5554',
      stateMode: 'default' as const,
    };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe('android');
      expect(result.data.deviceId).toBe('emulator-5554');
      expect(result.data.stateMode).toBe('default');
    }
  });

  it('rejects invalid platform value', () => {
    const input = { platform: 'windows' };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(false);
  });

  it('rejects empty deviceId', () => {
    const input = { deviceId: '' };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(false);
  });

  it('accepts launch input without platform or deviceId', () => {
    const input = { stateMode: 'default' as const };
    const result = launchInputSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBeUndefined();
      expect(result.data.deviceId).toBeUndefined();
    }
  });
});

describe('device tool schemas', () => {
  describe('scrollToElementInputSchema', () => {
    it('accepts a target with direction and maxAttempts', () => {
      const result = scrollToElementInputSchema.safeParse({
        testId: 'foo',
        direction: 'down',
        maxAttempts: 5,
      });

      expect(result.success).toBe(true);
    });

    it('rejects when no target selector is provided', () => {
      const result = scrollToElementInputSchema.safeParse({
        direction: 'down',
      });

      expect(result.success).toBe(false);
    });

    it('rejects an invalid direction', () => {
      const result = scrollToElementInputSchema.safeParse({
        testId: 'foo',
        direction: 'left',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('deviceSwipeInputSchema', () => {
    it('accepts a valid direction', () => {
      const result = deviceSwipeInputSchema.safeParse({ direction: 'up' });

      expect(result.success).toBe(true);
    });

    it('rejects a missing direction', () => {
      const result = deviceSwipeInputSchema.safeParse({});

      expect(result.success).toBe(false);
    });

    it('rejects an invalid direction', () => {
      const result = deviceSwipeInputSchema.safeParse({
        direction: 'diagonal',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('tapCoordinatesInputSchema', () => {
    it('accepts numeric coordinates', () => {
      const result = tapCoordinatesInputSchema.safeParse({ x: 5, y: 10 });

      expect(result.success).toBe(true);
    });

    it('rejects negative coordinates', () => {
      const result = tapCoordinatesInputSchema.safeParse({ x: -1, y: 10 });

      expect(result.success).toBe(false);
    });

    it('rejects missing coordinates', () => {
      const result = tapCoordinatesInputSchema.safeParse({ x: 5 });

      expect(result.success).toBe(false);
    });
  });

  describe('dismissAlertInputSchema', () => {
    it('accepts a boolean accept flag', () => {
      const result = dismissAlertInputSchema.safeParse({ accept: true });

      expect(result.success).toBe(true);
    });

    it('rejects a missing accept flag', () => {
      const result = dismissAlertInputSchema.safeParse({});

      expect(result.success).toBe(false);
    });
  });

  describe('openAppInputSchema', () => {
    it('accepts a non-empty bundleId', () => {
      const result = openAppInputSchema.safeParse({ bundleId: 'io.metamask' });

      expect(result.success).toBe(true);
    });

    it('rejects an empty bundleId', () => {
      const result = openAppInputSchema.safeParse({ bundleId: '' });

      expect(result.success).toBe(false);
    });
  });

  describe('deviceContextInputSchema', () => {
    it('accepts a list action', () => {
      const result = deviceContextInputSchema.safeParse({ action: 'list' });

      expect(result.success).toBe(true);
    });

    it('accepts a switch action with a name', () => {
      const result = deviceContextInputSchema.safeParse({
        action: 'switch',
        name: 'WEBVIEW_1',
      });

      expect(result.success).toBe(true);
    });

    it('rejects a switch action without a name', () => {
      const result = deviceContextInputSchema.safeParse({ action: 'switch' });

      expect(result.success).toBe(false);
    });

    it('rejects an unknown action', () => {
      const result = deviceContextInputSchema.safeParse({ action: 'reset' });

      expect(result.success).toBe(false);
    });
  });

  describe('deviceClipboardInputSchema', () => {
    it('accepts a read action', () => {
      const result = deviceClipboardInputSchema.safeParse({ action: 'read' });

      expect(result.success).toBe(true);
    });

    it('accepts a write action with text', () => {
      const result = deviceClipboardInputSchema.safeParse({
        action: 'write',
        text: 'hello',
      });

      expect(result.success).toBe(true);
    });

    it('rejects a write action without text', () => {
      const result = deviceClipboardInputSchema.safeParse({ action: 'write' });

      expect(result.success).toBe(false);
    });
  });

  describe('screenRecordingInputSchema', () => {
    it('accepts a start action without outputPath', () => {
      const result = screenRecordingInputSchema.safeParse({
        action: 'start',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a start action with outputPath', () => {
      const result = screenRecordingInputSchema.safeParse({
        action: 'start',
        outputPath: '/tmp/rec.mp4',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a stop action', () => {
      const result = screenRecordingInputSchema.safeParse({ action: 'stop' });

      expect(result.success).toBe(true);
    });

    it('rejects an unknown action', () => {
      const result = screenRecordingInputSchema.safeParse({
        action: 'pause',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('deviceLogsInputSchema', () => {
    it('accepts an empty input', () => {
      const result = deviceLogsInputSchema.safeParse({});

      expect(result.success).toBe(true);
    });

    it('accepts durationSeconds and filter', () => {
      const result = deviceLogsInputSchema.safeParse({
        durationSeconds: 30,
        filter: 'MetaMask',
      });

      expect(result.success).toBe(true);
    });

    it('rejects a non-positive durationSeconds', () => {
      const result = deviceLogsInputSchema.safeParse({ durationSeconds: 0 });

      expect(result.success).toBe(false);
    });
  });
});
