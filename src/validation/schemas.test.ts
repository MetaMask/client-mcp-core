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
  webSocketMockDefinitionSchema,
  mockWebSocketInputSchema,
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

describe('webSocketMockDefinitionSchema', () => {
  const baseMock = {
    url: 'wss://api.example.com/ws',
    rules: [{ id: 'rule-1', match: { includes: 'hello' } }],
  };

  it('accepts a valid wss URL without wildcards', () => {
    const result = webSocketMockDefinitionSchema.safeParse(baseMock);

    expect(result.success).toBe(true);
  });

  it('accepts a valid ws URL without wildcards', () => {
    const result = webSocketMockDefinitionSchema.safeParse({
      ...baseMock,
      url: 'ws://api.example.com/ws',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a wss URL containing double asterisk wildcard', () => {
    const result = webSocketMockDefinitionSchema.safeParse({
      ...baseMock,
      url: 'wss://example.com/**',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Wildcard patterns are not supported for WebSocket URLs; use an exact ws:// or wss:// URL',
      );
    }
  });

  it('rejects a wss URL containing single asterisk wildcard', () => {
    const result = webSocketMockDefinitionSchema.safeParse({
      ...baseMock,
      url: 'wss://example.com/*/ws',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Wildcard patterns are not supported for WebSocket URLs; use an exact ws:// or wss:// URL',
      );
    }
  });

  it('rejects non-WebSocket URLs', () => {
    const result = webSocketMockDefinitionSchema.safeParse({
      ...baseMock,
      url: 'https://example.com/ws',
    });

    expect(result.success).toBe(false);
  });
});

describe('mockWebSocketInputSchema', () => {
  const validMock = {
    url: 'wss://api.example.com/ws',
    rules: [{ id: 'rule-1', match: { includes: 'hello' } }],
  };

  it('accepts add with mock only', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'add',
      mock: validMock,
    });
    expect(result.success).toBe(true);
  });

  it('accepts add with mocks only', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'add',
      mocks: [validMock],
    });
    expect(result.success).toBe(true);
  });

  it('rejects add with both mock and mocks', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'add',
      mock: validMock,
      mocks: [validMock],
    });
    expect(result.success).toBe(false);
  });

  it('rejects add with neither mock nor mocks', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'add',
    });
    expect(result.success).toBe(false);
  });

  it('accepts clear action', () => {
    const result = mockWebSocketInputSchema.safeParse({ action: 'clear' });
    expect(result.success).toBe(true);
  });

  it('accepts list action', () => {
    const result = mockWebSocketInputSchema.safeParse({ action: 'list' });
    expect(result.success).toBe(true);
  });

  it('accepts messages action with optional limit', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'messages',
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects messages action with limit exceeding 500', () => {
    const result = mockWebSocketInputSchema.safeParse({
      action: 'messages',
      limit: 501,
    });
    expect(result.success).toBe(false);
  });
});
