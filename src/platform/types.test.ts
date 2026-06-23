import { describe, it, expect } from 'vitest';

import type {
  PlatformType,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  GetTextActionResult,
  PlatformScreenshotOptions,
  WithinScope,
  IPlatformDriver,
} from './types.js';

describe('Platform Types', () => {
  it('should define IPlatformDriver interface', () => {
    // Type-level verification - if this compiles, the types are correctly defined
    const platformTypes: PlatformType[] = ['browser', 'ios', 'android'];
    expect(platformTypes).toHaveLength(3);
  });

  it('should define TargetType', () => {
    const targets: TargetType[] = ['a11yRef', 'testId', 'selector'];
    expect(targets).toHaveLength(3);
  });

  it('should define action result types', () => {
    const clickResult: ClickActionResult = {
      clicked: true,
      target: 'testId:foo',
    };
    expect(clickResult.clicked).toBe(true);

    const typeResult: TypeActionResult = {
      typed: true,
      target: 'testId:bar',
      textLength: 5,
    };
    expect(typeResult.typed).toBe(true);

    const getTextResult: GetTextActionResult = {
      text: 'hello',
      target: 'testId:greeting',
      length: 5,
    };
    expect(getTextResult).toHaveProperty('length', 5);
  });

  it('should define within scopes', () => {
    const within: WithinScope = {
      type: 'testId',
      value: 'parent-container',
    };

    expect(within).toStrictEqual({
      type: 'testId',
      value: 'parent-container',
    });
  });

  it('should define screenshot options', () => {
    const options: PlatformScreenshotOptions = { name: 'test' };
    expect(options.name).toBe('test');
  });

  it('should define the merged platform driver contract', async () => {
    const driver: IPlatformDriver = {
      async click() {
        return { clicked: true, target: 'testId:submit' };
      },
      async type() {
        return { typed: true, target: 'testId:input', textLength: 4 };
      },
      async waitForElement() {
        return undefined;
      },
      async getText() {
        return { text: 'done', target: 'testId:status', length: 4 };
      },
      isToolSupported(toolName: string) {
        return toolName === 'click';
      },
      async getAccessibilityTree() {
        return { nodes: [], refMap: new Map<string, string>() };
      },
      async getTestIds() {
        return [];
      },
      async screenshot() {
        return { path: '/tmp/test.png', width: 0, height: 0, base64: '' };
      },
      async getAppState() {
        return {
          isLoaded: true,
          currentUrl: '',
          extensionId: 'test-extension',
          isUnlocked: true,
          currentScreen: 'unknown',
          accountAddress: null,
          networkName: null,
          chainId: null,
          balance: null,
        };
      },
      getCurrentUrl() {
        return '';
      },
      getPlatform() {
        return 'ios';
      },
      getAppId() {
        return 'io.metamask.MetaMask.dev';
      },
      getMetroPort() {
        return 8082;
      },
      getPinnedHermesDeviceId() {
        return 'device-1';
      },
      setPinnedHermesDeviceId(_id: string) {
        return undefined;
      },
    };

    const textResult = await driver.getText(
      'testId',
      'status',
      new Map(),
      1000,
      {
        type: 'testId',
        value: 'root',
      },
    );
    expect(textResult).toMatchObject({ text: 'done' });
    expect(driver.isToolSupported('click')).toBe(true);
    expect(driver.getAppId?.()).toBe('io.metamask.MetaMask.dev');
    expect(driver.getMetroPort?.()).toBe(8082);
    expect(driver.getPinnedHermesDeviceId?.()).toBe('device-1');
  });
});
