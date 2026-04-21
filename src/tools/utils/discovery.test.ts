/**
 * Unit tests for discovery.ts
 *
 * Tests core discovery functions:
 * - collectTestIds: Collect visible test IDs from page
 * - collectTrimmedA11ySnapshot: Collect accessibility tree with refs
 * - resolveTarget: Resolve target to Playwright Locator
 * - waitForTarget: Wait for target to become visible
 */

import type { Page, Locator } from '@playwright/test';
import { describe, it, expect, vi } from 'vitest';

import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  parseAriaSnapshotYaml,
  resolveTarget,
  waitForTarget,
} from './discovery.js';

function createMockPage(
  options: {
    testIds?: { testId: string; visible: boolean; text?: string }[];
    a11ySnapshot?: string | null;
  } = {},
): Page {
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
        const testId = selector.match(/data-testid="([^"]+)"/u)?.[1];
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

function createMockLocator(
  options: {
    visible?: boolean;
    timeout?: boolean;
  } = {},
): Locator {
  const { visible = true, timeout = false } = options;

  return {
    waitFor: vi.fn().mockImplementation(async () => {
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
    expect(result[0]).toStrictEqual({
      testId: 'button-1',
      tag: 'element',
      text: 'Click me',
      visible: true,
    });
    expect(result[1]).toStrictEqual({
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

  it('handles isVisible rejection gracefully', async () => {
    const mockLocators = [
      {
        getAttribute: vi.fn().mockResolvedValue('btn-1'),
        isVisible: vi.fn().mockRejectedValue(new Error('detached')),
        textContent: vi.fn().mockResolvedValue('OK'),
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
    expect(result[0].visible).toBe(false);
  });

  it('handles textContent rejection gracefully', async () => {
    const mockLocators = [
      {
        getAttribute: vi.fn().mockResolvedValue('btn-1'),
        isVisible: vi.fn().mockResolvedValue(true),
        textContent: vi.fn().mockRejectedValue(new Error('detached')),
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
    expect(result[0].text).toBeUndefined();
  });

  it('handles page load state failure', async () => {
    const page = createMockPage({
      testIds: [{ testId: 'test-1', visible: true }],
    });
    vi.spyOn(page, 'waitForLoadState').mockRejectedValue(
      new Error('Load failed'),
    );

    const result = await collectTestIds(page);

    expect(result).toHaveLength(1);
  });
});

describe('collectTrimmedA11ySnapshot', () => {
  it('collects accessibility tree with deterministic refs', async () => {
    const a11yTree = `- main:\n  - button "Submit"\n  - button "Cancel"`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toStrictEqual({
      ref: 'e1',
      role: 'button',
      name: 'Submit',
      path: [],
    });
    expect(result.nodes[1]).toStrictEqual({
      ref: 'e2',
      role: 'button',
      name: 'Cancel',
      path: [],
    });
    expect(result.refMap.get('e1')).toBe('role=button[name="Submit"]');
    expect(result.refMap.get('e2')).toBe('role=button[name="Cancel"]');
  });

  it('filters roles to included set', async () => {
    const a11yTree = `- main:\n  - button "Click"\n  - div "Container"\n  - link "Go"`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].role).toBe('button');
    expect(result.nodes[1].role).toBe('link');
  });

  it('includes disabled, checked, expanded properties', async () => {
    const a11yTree = `- main:\n  - button "Disabled" [disabled]\n  - checkbox "Checked" [checked]\n  - button "Expanded" [expanded]`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes[0].disabled).toBe(true);
    expect(result.nodes[1].checked).toBe(true);
    expect(result.nodes[2].expanded).toBe(true);
  });

  it('handles checked="mixed" as false', async () => {
    const a11yTree = `- main:\n  - checkbox "Mixed" [checked=mixed]`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes[0].checked).toBe(false);
  });

  it('builds ancestor path for dialog and heading', async () => {
    const a11yTree = `- main:\n  - dialog "Confirm":\n    - heading "Title":\n      - button "OK"`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].path).toStrictEqual(['dialog:Confirm']);
    expect(result.nodes[1].path).toStrictEqual([
      'dialog:Confirm',
      'heading:Title',
    ]);
    expect(result.nodes[2].path).toStrictEqual([
      'dialog:Confirm',
      'heading:Title',
    ]);
  });

  it('escapes quotes in accessibility names', async () => {
    const a11yTree = '- main:\n  - button "Say \\"Hello\\""';

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

  it('handles empty parsed roots from valid yaml', async () => {
    const page = createMockPage({
      a11ySnapshot: '- text: just text\n- /url: https://example.com',
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(0);
    expect(result.refMap.size).toBe(0);
  });

  it('uses root selector when provided', async () => {
    const a11yTree = `- dialog:\n  - button "Close"`;

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
    const a11yTree = `- main:\n  - button "Parent":\n    - link "Child":\n      - button "Grandchild"`;

    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].name).toBe('Parent');
    expect(result.nodes[1].name).toBe('Child');
    expect(result.nodes[2].name).toBe('Grandchild');
  });

  it('collapses 3+ consecutive identical nodes into summary', async () => {
    const a11yTree = [
      '- main:',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "Submit"',
    ].join('\n');

    const page = createMockPage({ a11ySnapshot: a11yTree });
    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0]).toMatchObject({
      ref: 'e1',
      role: 'button',
      name: 'maskicon',
    });
    expect(result.nodes[1].name).toContain('3 more');
    expect(result.nodes[1].name).toContain('maskicon');
    expect(result.nodes[2]).toMatchObject({
      ref: 'e5',
      role: 'button',
      name: 'Submit',
    });
    expect(result.refMap.has('e1')).toBe(true);
    expect(result.refMap.has('e2')).toBe(true);
    expect(result.refMap.has('e3')).toBe(true);
    expect(result.refMap.has('e4')).toBe(true);
  });

  it('does not collapse nodes with same role and name but different paths', async () => {
    const a11yTree = [
      '- main:',
      '  - dialog "A":',
      '    - button "OK"',
      '    - button "OK"',
      '    - button "OK"',
      '  - dialog "B":',
      '    - button "OK"',
      '    - button "OK"',
      '    - button "OK"',
    ].join('\n');

    const page = createMockPage({ a11ySnapshot: a11yTree });
    const result = await collectTrimmedA11ySnapshot(page);

    const dialogAButtons = result.nodes.filter(
      (n) => n.role === 'button' && n.path.some((p) => p.includes('dialog:A')),
    );
    const dialogBButtons = result.nodes.filter(
      (n) => n.role === 'button' && n.path.some((p) => p.includes('dialog:B')),
    );
    expect(dialogAButtons.length).toBeGreaterThanOrEqual(1);
    expect(dialogBButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('does not collapse fewer than 3 identical nodes', async () => {
    const a11yTree = [
      '- main:',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "Submit"',
    ].join('\n');

    const page = createMockPage({ a11ySnapshot: a11yTree });
    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].name).toBe('maskicon');
    expect(result.nodes[1].name).toBe('maskicon');
    expect(result.nodes[2].name).toBe('Submit');
  });

  it('enriches nodes with short names using testId from DOM', async () => {
    const a11yTree = `- main:\n  - button "x"`;
    const mockGetAttribute = vi.fn().mockResolvedValue('action-button');
    const mockTextContent = vi.fn().mockResolvedValue('Click me');
    const mockBodyLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === 'body') {
          return { first: vi.fn().mockReturnValue(mockBodyLocator) };
        }
        return {
          first: vi.fn().mockReturnValue({
            getAttribute: mockGetAttribute,
            textContent: mockTextContent,
          }),
        };
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes[0].testId).toBe('action-button');
    expect(result.nodes[0].textContent).toBe('Click me');
  });

  it('skips textContent enrichment when text matches the node name', async () => {
    const a11yTree = `- main:\n  - button "maskicon"`;
    const mockBodyLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === 'body') {
          return { first: vi.fn().mockReturnValue(mockBodyLocator) };
        }
        return {
          first: vi.fn().mockReturnValue({
            getAttribute: vi.fn().mockResolvedValue(null),
            textContent: vi.fn().mockResolvedValue('maskicon'),
          }),
        };
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes[0].textContent).toBeUndefined();
    expect(result.nodes[0].testId).toBeUndefined();
  });

  it('skips enrichment when all node names exceed threshold', async () => {
    const a11yTree = `- main:\n  - button "A very long button name that exceeds threshold"`;
    const page = createMockPage({ a11ySnapshot: a11yTree });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].testId).toBeUndefined();
    expect(result.nodes[0].textContent).toBeUndefined();
  });

  it('handles enrichment errors when getAttribute/textContent reject', async () => {
    const a11yTree = `- main:\n  - button "x"`;
    const mockBodyLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === 'body') {
          return { first: vi.fn().mockReturnValue(mockBodyLocator) };
        }
        return {
          first: vi.fn().mockReturnValue({
            getAttribute: vi.fn().mockRejectedValue(new Error('detached')),
            textContent: vi.fn().mockRejectedValue(new Error('detached')),
          }),
        };
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].testId).toBeUndefined();
    expect(result.nodes[0].textContent).toBeUndefined();
  });

  it('handles enrichment errors when locator.first() throws', async () => {
    const a11yTree = `- main:\n  - button "y"`;
    const mockBodyLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === 'body') {
          return { first: vi.fn().mockReturnValue(mockBodyLocator) };
        }
        return {
          first: vi.fn().mockImplementation(() => {
            throw new Error('locator disposed');
          }),
        };
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].testId).toBeUndefined();
    expect(result.nodes[0].textContent).toBeUndefined();
  });

  it('does not collapse nodes with different textContent', async () => {
    const a11yTree = [
      '- main:',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "maskicon"',
      '  - button "maskicon"',
    ].join('\n');

    const textValues = ['Rename', 'Account details', 'Hide', 'Remove'];
    let callIdx = 0;
    const mockBodyLocator = {
      ariaSnapshot: vi.fn().mockResolvedValue(a11yTree),
    };

    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === 'body') {
          return { first: vi.fn().mockReturnValue(mockBodyLocator) };
        }
        const idx = callIdx;
        callIdx += 1;
        return {
          first: vi.fn().mockReturnValue({
            getAttribute: vi.fn().mockResolvedValue(null),
            textContent: vi
              .fn()
              .mockResolvedValue(textValues[idx % textValues.length]),
          }),
        };
      }),
    } as unknown as Page;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(4);
    expect(result.nodes[0].textContent).toBe('Rename');
    expect(result.nodes[1].textContent).toBe('Account details');
  });
});

describe('resolveTarget', () => {
  it('resolves a11yRef to selector from refMap', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const page = createMockPage();

    await resolveTarget(page, 'a11yRef', 'e1', refMap);

    expect(page.locator).toHaveBeenCalledWith('role=button[name="Submit"]');
  });

  it('throws error for unknown a11yRef', async () => {
    const refMap = new Map([['e1', 'role=button[name="Submit"]']]);
    const page = createMockPage();

    await expect(
      resolveTarget(page, 'a11yRef', 'e99', refMap),
    ).rejects.toThrowError('Unknown a11yRef: e99');
  });

  it('includes available refs in error message', async () => {
    const refMap = new Map([
      ['e1', 'role=button[name="A"]'],
      ['e2', 'role=button[name="B"]'],
    ]);
    const page = createMockPage();

    await expect(
      resolveTarget(page, 'a11yRef', 'e99', refMap),
    ).rejects.toThrowError('Available refs: e1, e2');
  });

  it('resolves testId to data-testid selector', async () => {
    const page = createMockPage();

    await resolveTarget(page, 'testId', 'submit-btn', new Map());

    expect(page.locator).toHaveBeenCalledWith('[data-testid="submit-btn"]');
  });

  it('resolves selector directly', async () => {
    const page = createMockPage();

    await resolveTarget(page, 'selector', '.submit-button', new Map());

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

    await waitForTarget(page, 'a11yRef', 'e1', refMap, 5000);

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
    ).rejects.toThrowError('Timeout waiting for element');
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

  it('scopes target within a parent when within is provided', async () => {
    const childLocator = createMockLocator({ visible: true });
    const firstParentLocator = {
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(childLocator),
    };
    const parentLocator = {
      first: vi.fn().mockReturnValue(firstParentLocator),
    };

    const page = {
      locator: vi.fn().mockReturnValue(parentLocator),
    } as unknown as Page;

    const result = await waitForTarget(
      page,
      'testId',
      'end-accessory',
      new Map(),
      5000,
      { type: 'testId', value: 'account-cell' },
    );

    expect(page.locator).toHaveBeenCalledWith('[data-testid="account-cell"]');
    expect(parentLocator.first).toHaveBeenCalled();
    expect(firstParentLocator.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 5000,
    });
    expect(firstParentLocator.locator).toHaveBeenCalledWith(
      '[data-testid="end-accessory"]',
    );
    expect(result).toBe(childLocator);
  });
});

describe('parseAriaSnapshotYaml', () => {
  it('parses basic leaf nodes', () => {
    const yaml = `- button "Submit"`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'button', name: 'Submit' }]);
  });

  it('parses nested children', () => {
    const yaml = `- main:\n  - button "Parent":\n    - link "Child":\n      - button "Grandchild"`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([
      {
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
      },
    ]);
  });

  it('parses attributes', () => {
    const yaml = `- main:\n  - button "Disabled" [disabled]\n  - checkbox "Checked" [checked]\n  - checkbox "Mixed" [checked=mixed]\n  - button "Expanded" [expanded]`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([
      {
        role: 'main',
        children: [
          { role: 'button', name: 'Disabled', disabled: true },
          { role: 'checkbox', name: 'Checked', checked: true },
          { role: 'checkbox', name: 'Mixed', checked: 'mixed' },
          { role: 'button', name: 'Expanded', expanded: true },
        ],
      },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseAriaSnapshotYaml('')).toStrictEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseAriaSnapshotYaml('  \n  ')).toStrictEqual([]);
  });

  it('unescapes quoted names', () => {
    const yaml = '- button "Say \\"Hello\\""';

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'button', name: 'Say "Hello"' }]);
  });

  it('skips text nodes', () => {
    const yaml = `- text: some content\n- button "Submit"`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'button', name: 'Submit' }]);
  });

  it('skips property lines', () => {
    const yaml = `- /url: https://example.com\n- link "Home"`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'link', name: 'Home' }]);
  });

  it('handles nodes without names', () => {
    const yaml = `- listitem`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'listitem' }]);
  });

  it('handles inline text values', () => {
    const yaml = `- listitem: Item text`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([{ role: 'listitem' }]);
  });

  it('parses multiple root nodes', () => {
    const yaml = `- button "First"\n- button "Second"`;

    const result = parseAriaSnapshotYaml(yaml);

    expect(result).toStrictEqual([
      { role: 'button', name: 'First' },
      { role: 'button', name: 'Second' },
    ]);
  });
});
