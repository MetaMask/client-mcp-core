/**
 * Unit tests for discovery.ts
 *
 * Tests core discovery functions:
 * - collectTestIds: Collect visible test IDs from page
 * - collectTrimmedA11ySnapshot: Collect accessibility tree with refs
 * - resolveTarget: Resolve target to Playwright Locator
 * - waitForTarget: Wait for target to become visible
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  resolveTarget,
  waitForTarget,
} from './discovery.js';
import type { RawA11yNode } from './types';

/**
 * Create a mock Playwright Page with test ID locators
 */
function createMockPage(options: {
  testIds?: Array<{ testId: string; visible: boolean; text?: string }>;
  a11ySnapshot?: RawA11yNode | null;
} = {}): Page {
  const { testIds = [], a11ySnapshot = null } = options;

  const mockLocators = testIds.map((item) => ({
    getAttribute: vi.fn().mockResolvedValue(item.testId),
    isVisible: vi.fn().mockResolvedValue(item.visible),
    textContent: vi.fn().mockResolvedValue(item.text ?? ''),
  }));

  const mockBodyLocator = {
    ariaSnapshot: vi.fn().mockResolvedValue(a11ySnapshot),
  };

  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((selector: string) => {
      if (selector === '[data-testid]') {
        return {
          all: vi.fn().mockResolvedValue(mockLocators),
        };
      }
      if (selector === 'body') {
        return {
          first: vi.fn().mockReturnValue(mockBodyLocator),
        };
      }
      if (selector.startsWith('[data-testid="')) {
        const testId = selector.match(/data-testid="([^"]+)"/)?.[1];
        return { testId };
      }
      if (selector.startsWith('role=')) {
        return { selector };
      }
      return {
        first: vi.fn().mockReturnValue(mockBodyLocator),
      };
    }),
  } as unknown as Page;
}

/**
 * Create a mock Playwright Locator
 */
function createMockLocator(options: {
  visible?: boolean;
  timeout?: boolean;
} = {}): Locator {
  const { visible = true, timeout = false } = options;

  return {
    waitFor: vi.fn().mockImplementation(() => {
      if (timeout) {
        return Promise.reject(new Error('Timeout waiting for element'));
      }
      return Promise.resolve();
    }),
    isVisible: vi.fn().mockResolvedValue(visible),
  } as unknown as Locator;
}

describe('collectTestIds', () => {
  it('collects visible test IDs from page', async () => {
    const page = createMockPage({
      testIds: [
        { testId: 'button-1', visible: true, text: 'Click me' },
        { testId: 'input-1', visible: true, text: '' },
      ],
    });

    const result = await collectTestIds(page);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      testId: 'button-1',
      tag: 'element',
      text: 'Click me',
      visible: true,
    });
    expect(result[1]).toEqual({
      testId: 'input-1',
      tag: 'element',
      text: '',
      visible: true,
    });
  });

  it('respects limit parameter', async () => {
    const page = createMockPage({
      testIds: [
        { testId: 'item-1', visible: true },
        { testId: 'item-2', visible: true },
        { testId: 'item-3', visible: true },
      ],
    });

    const result = await collectTestIds(page, 2);

    expect(result).toHaveLength(2);
  });

  it('handles invisible elements', async () => {
    const page = createMockPage({
      testIds: [
        { testId: 'visible', visible: true },
        { testId: 'hidden', visible: false },
      ],
    });

    const result = await collectTestIds(page);

    expect(result).toHaveLength(2);
    expect(result[0].visible).toBe(true);
    expect(result[1].visible).toBe(false);
  });

  it('handles elements without test IDs', async () => {
    const mockLocators = [
      {
        getAttribute: vi.fn().mockResolvedValue(null),
        isVisible: vi.fn().mockResolvedValue(true),
        textContent: vi.fn().mockResolvedValue(''),
      },
    ];

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue(mockLocators),
      }),
    } as unknown as Page;

    const result = await collectTestIds(page);

    expect(result).toHaveLength(0);
  });

  it('handles errors during collection', async () => {
    const mockLocators = [
      {
        getAttribute: vi.fn().mockRejectedValue(new Error('Element detached')),
        isVisible: vi.fn().mockResolvedValue(true),
        textContent: vi.fn().mockResolvedValue(''),
      },
      {
        getAttribute: vi.fn().mockResolvedValue('valid-id'),
        isVisible: vi.fn().mockResolvedValue(true),
        textContent: vi.fn().mockResolvedValue('Valid'),
      },
    ];

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue(mockLocators),
      }),
    } as unknown as Page;

    const result = await collectTestIds(page);

    expect(result).toHaveLength(1);
    expect(result[0].testId).toBe('valid-id');
  });

  it('truncates long text content', async () => {
    const longText = 'a'.repeat(300);
    const page = createMockPage({
      testIds: [{ testId: 'long-text', visible: true, text: longText }],
    });

    const result = await collectTestIds(page);

    expect(result[0].text?.length).toBeLessThanOrEqual(200);
  });

  it('handles page load state failure', async () => {
    const page = createMockPage({
      testIds: [{ testId: 'test-1', visible: true }],
    });
    page.waitForLoadState = vi.fn().mockRejectedValue(new Error('Load failed'));

    const result = await collectTestIds(page);

    expect(result).toHaveLength(1);
  });
});

describe('collectTrimmedA11ySnapshot', () => {
  it('collects accessibility tree with deterministic refs', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [
        { role: 'button', name: 'Submit' },
        { role: 'button', name: 'Cancel' },
      ],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toEqual({
      ref: 'e1',
      role: 'button',
      name: 'Submit',
      path: [],
    });
    expect(result.nodes[1]).toEqual({
      ref: 'e2',
      role: 'button',
      name: 'Cancel',
      path: [],
    });
    expect(result.refMap.get('e1')).toBe('role=button[name="Submit"]');
    expect(result.refMap.get('e2')).toBe('role=button[name="Cancel"]');
  });

  it('filters roles to included set', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [
        { role: 'button', name: 'Click' },
        { role: 'div', name: 'Container' },
        { role: 'link', name: 'Go' },
      ],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].role).toBe('button');
    expect(result.nodes[1].role).toBe('link');
  });

  it('includes disabled, checked, expanded properties', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [
        { role: 'button', name: 'Disabled', disabled: true },
        { role: 'checkbox', name: 'Checked', checked: true },
        { role: 'button', name: 'Expanded', expanded: true },
      ],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes[0].disabled).toBe(true);
    expect(result.nodes[1].checked).toBe(true);
    expect(result.nodes[2].expanded).toBe(true);
  });

  it('handles checked="mixed" as false', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [{ role: 'checkbox', name: 'Mixed', checked: 'mixed' }],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes[0].checked).toBe(false);
  });

  it('builds ancestor path for dialog and heading', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [
        {
          role: 'dialog',
          name: 'Confirm',
          children: [
            {
              role: 'heading',
              name: 'Title',
              children: [{ role: 'button', name: 'OK' }],
            },
          ],
        },
      ],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].path).toEqual(['dialog:Confirm']);
    expect(result.nodes[1].path).toEqual(['dialog:Confirm', 'heading:Title']);
    expect(result.nodes[2].path).toEqual(['dialog:Confirm', 'heading:Title']);
  });

  it('escapes quotes in accessibility names', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [{ role: 'button', name: 'Say "Hello"' }],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.refMap.get('e1')).toBe('role=button[name="Say \\"Hello\\""]');
  });

  it('handles empty accessibility tree', async () => {
    const page = createMockPage({ a11ySnapshot: null });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(0);
    expect(result.refMap.size).toBe(0);
  });

  it('uses root selector when provided', async () => {
    const a11yTree: RawA11yNode = {
      role: 'dialog',
      children: [{ role: 'button', name: 'Close' }],
    };

    const mockLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue(mockLocator),
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(page.locator).toHaveBeenCalledWith('.modal');
    expect(result.nodes).toHaveLength(2);
  });

  it('handles nested children recursively', async () => {
    const a11yTree: RawA11yNode = {
      role: 'main',
      children: [
        {
          role: 'button',
          name: 'Parent',
          children: [
            {
              role: 'link',
              name: 'Child',
              children: [{ role: 'button', name: 'Grandchild' }],
            },
          ],
        },
      ],
    };

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].name).toBe('Parent');
    expect(result.nodes[1].name).toBe('Child');
    expect(result.nodes[2].name).toBe('Grandchild');
  });
});

describe('resolveTarget', () => {
  it('resolves a11yRef to selector from refMap', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const page = createMockPage();

    const locator = await resolveTarget(page, 'a11yRef', 'e1', refMap);

    expect(page.locator).toHaveBeenCalledWith('role=button[name="Submit"]');
  });

  it('throws error for unknown a11yRef', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const page = createMockPage();

    await expect(
      resolveTarget(page, 'a11yRef', 'e99', refMap),
    ).rejects.toThrow('Unknown a11yRef: e99');
  });

  it('includes available refs in error message', async () => {
    const refMap = new Map([
      ['e1', 'role=button[name="A"]'],
      ['e2', 'role=button[name="B"]'],
    ]);
    const page = createMockPage();

    await expect(
      resolveTarget(page, 'a11yRef', 'e99', refMap),
    ).rejects.toThrow('Available refs: e1, e2');
  });

  it('resolves testId to data-testid selector', async () => {
    const page = createMockPage();

    const locator = await resolveTarget(page, 'testId', 'submit-btn', new Map());

    expect(page.locator).toHaveBeenCalledWith('[data-testid="submit-btn"]');
  });

  it('resolves selector directly', async () => {
    const page = createMockPage();

    const locator = await resolveTarget(page, 'selector', '.submit-button', new Map());

    expect(page.locator).toHaveBeenCalledWith('.submit-button');
  });
});

describe('waitForTarget', () => {
  it('waits for target to become visible', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const mockLocator = createMockLocator({ visible: true });

    const page = {
      locator: vi.fn().mockReturnValue(mockLocator),
    } as unknown as Page;

    const locator = await waitForTarget(page, 'a11yRef', 'e1', refMap, 5000);

    expect(mockLocator.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 5000,
    });
  });

  it('throws error on timeout', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const mockLocator = createMockLocator({ timeout: true });

    const page = {
      locator: vi.fn().mockReturnValue(mockLocator),
    } as unknown as Page;

    await expect(
      waitForTarget(page, 'a11yRef', 'e1', refMap, 1000),
    ).rejects.toThrow('Timeout waiting for element');
  });

  it('resolves testId target', async () => {
    const mockLocator = createMockLocator({ visible: true });

    const page = {
      locator: vi.fn().mockReturnValue(mockLocator),
    } as unknown as Page;

    await waitForTarget(page, 'testId', 'submit-btn', new Map(), 5000);

    expect(page.locator).toHaveBeenCalledWith('[data-testid="submit-btn"]');
  });

  it('resolves selector target', async () => {
    const mockLocator = createMockLocator({ visible: true });

    const page = {
      locator: vi.fn().mockReturnValue(mockLocator),
    } as unknown as Page;

    await waitForTarget(page, 'selector', '.submit-button', new Map(), 5000);

    expect(page.locator).toHaveBeenCalledWith('.submit-button');
  });
});
