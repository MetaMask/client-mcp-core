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

import type { RawA11yNode } from '../types';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  parseAriaSnapshotYaml,
  resolveTarget,
  waitForTarget,
} from './discovery.js';

type MockAXProperty = {
  name: string;
  value: {
    type: string;
    value?: unknown;
  };
};

type MockAXNode = {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: MockAXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
};

type MockDomNode = {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  children?: MockDomNode[];
};

type MockPageWithCdpSession = Page & {
  mockCdpSession: {
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
};

function buildAxProperties(node: RawA11yNode): MockAXProperty[] | undefined {
  const properties: MockAXProperty[] = [];

  if (node.disabled !== undefined) {
    properties.push({
      name: 'disabled',
      value: { type: 'boolean', value: node.disabled },
    });
  }

  if (node.checked !== undefined) {
    properties.push({
      name: 'checked',
      value: {
        type: node.checked === 'mixed' ? 'tristate' : 'boolean',
        value: node.checked,
      },
    });
  }

  if (node.expanded !== undefined) {
    properties.push({
      name: 'expanded',
      value: { type: 'boolean', value: node.expanded },
    });
  }

  return properties.length > 0 ? properties : undefined;
}

function rawNodesToAxNodes(rawNodes: RawA11yNode[]): MockAXNode[] {
  const axNodes: MockAXNode[] = [];
  let nodeIdCounter = 1;
  let backendNodeIdCounter = 100;

  const visit = (node: RawA11yNode, parentId?: string): string => {
    const nodeId = `n${nodeIdCounter}`;
    nodeIdCounter += 1;

    const axNode: MockAXNode = {
      nodeId,
      ignored: false,
      role: node.role ? { type: 'role', value: node.role } : undefined,
      name:
        node.name === undefined
          ? undefined
          : { type: 'string', value: node.name },
      properties: buildAxProperties(node),
      parentId,
      backendDOMNodeId: backendNodeIdCounter,
    };
    backendNodeIdCounter += 1;
    axNodes.push(axNode);

    const childIds = (node.children ?? []).map((child) => visit(child, nodeId));
    if (childIds.length > 0) {
      axNode.childIds = childIds;
    }

    return nodeId;
  };

  for (const rawNode of rawNodes) {
    visit(rawNode);
  }

  return axNodes;
}

function createDomNode(
  nodeId: number,
  backendNodeId: number,
  children?: MockDomNode[],
): MockDomNode {
  return {
    nodeId,
    backendNodeId,
    nodeType: 1,
    nodeName: 'DIV',
    localName: 'div',
    nodeValue: '',
    children,
  };
}

function createMockPage(
  options: {
    testIds?: { testId: string; visible: boolean; text?: string }[];
    a11ySnapshot?: string | null;
    axNodes?: MockAXNode[];
    partialAxNodes?: MockAXNode[];
    queryAxTreeNodes?: MockAXNode[];
    fullAxTreeError?: Error;
    partialAxTreeError?: Error;
    queryAxTreeError?: Error;
    selectorNodes?: Record<
      string,
      {
        nodeId: number;
        backendNodeId: number;
        subtree?: MockDomNode;
      }
    >;
    domSelectorsByBackendId?: Record<number, string>;
    resolveNodeErrorIds?: Set<number>;
    testIdBySelector?: Record<string, string | null>;
    textBySelector?: Record<string, string | null>;
  } = {},
): Page {
  const {
    testIds = [],
    a11ySnapshot = null,
    axNodes,
    partialAxNodes,
    queryAxTreeNodes,
    fullAxTreeError,
    partialAxTreeError,
    queryAxTreeError,
    selectorNodes = {},
    domSelectorsByBackendId = {},
    resolveNodeErrorIds = new Set<number>(),
    testIdBySelector = {},
    textBySelector = {},
  } = options;

  const resolvedAxNodes =
    axNodes ??
    (a11ySnapshot
      ? rawNodesToAxNodes(parseAriaSnapshotYaml(a11ySnapshot))
      : []);

  const mockCdpSession = {
    send: vi
      .fn()
      .mockImplementation(
        async (method: string, params?: Record<string, unknown>) => {
          switch (method) {
            case 'Accessibility.enable':
            case 'Accessibility.disable':
            case 'Runtime.releaseObjectGroup':
              return {};
            case 'Accessibility.getFullAXTree':
              if (fullAxTreeError) {
                throw fullAxTreeError;
              }
              return { nodes: resolvedAxNodes };
            case 'Accessibility.getPartialAXTree':
              if (partialAxTreeError) {
                throw partialAxTreeError;
              }
              return { nodes: partialAxNodes ?? resolvedAxNodes };
            case 'Accessibility.queryAXTree':
              if (queryAxTreeError) {
                throw queryAxTreeError;
              }
              return { nodes: queryAxTreeNodes ?? resolvedAxNodes };
            case 'DOM.getDocument':
              return { root: { nodeId: 1 } };
            case 'DOM.querySelector': {
              const selector = params?.selector;
              if (typeof selector !== 'string') {
                return { nodeId: 0 };
              }
              return { nodeId: selectorNodes[selector]?.nodeId ?? 0 };
            }
            case 'DOM.describeNode': {
              const nodeId =
                typeof params?.nodeId === 'number' ? params.nodeId : undefined;
              const backendNodeId =
                typeof params?.backendNodeId === 'number'
                  ? params.backendNodeId
                  : undefined;

              if (nodeId !== undefined) {
                const selectorNode = Object.values(selectorNodes).find(
                  (candidate) => candidate.nodeId === nodeId,
                );

                if (selectorNode) {
                  return {
                    node:
                      params?.depth === -1 && selectorNode.subtree
                        ? selectorNode.subtree
                        : createDomNode(nodeId, selectorNode.backendNodeId),
                  };
                }
              }

              if (backendNodeId !== undefined) {
                return {
                  node: createDomNode(backendNodeId, backendNodeId),
                };
              }

              return { node: createDomNode(1, 1) };
            }
            case 'DOM.resolveNode': {
              const backendNodeId =
                typeof params?.backendNodeId === 'number'
                  ? params.backendNodeId
                  : 0;
              if (resolveNodeErrorIds.has(backendNodeId)) {
                throw new Error(
                  `Could not find node with given id (${backendNodeId})`,
                );
              }
              return { object: { objectId: `obj-${backendNodeId}` } };
            }
            case 'Runtime.callFunctionOn': {
              const objectId = params?.objectId;
              const backendNodeId = Number(
                String(objectId).replace('obj-', ''),
              );
              return {
                result: {
                  value: domSelectorsByBackendId[backendNodeId] ?? null,
                },
              };
            }
            default:
              return {};
          }
        },
      ),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const mockLocators = testIds.map((item) => ({
    getAttribute: vi.fn().mockResolvedValue(item.testId),
    isVisible: vi.fn().mockResolvedValue(item.visible),
    textContent: vi.fn().mockResolvedValue(item.text ?? ''),
  }));

  return {
    mockCdpSession,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue({
      newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
    }),
    locator: vi.fn((selector: string) => {
      if (selector === '[data-testid]') {
        return {
          all: vi.fn().mockResolvedValue(mockLocators),
        };
      }
      if (selector.startsWith('[data-testid="')) {
        const testId = selector.match(/data-testid="([^"]+)"/u)?.[1];
        return {
          testId,
          first: vi.fn().mockReturnValue({
            getAttribute: vi
              .fn()
              .mockResolvedValue(testIdBySelector[selector] ?? testId ?? null),
            textContent: vi
              .fn()
              .mockResolvedValue(textBySelector[selector] ?? null),
          }),
        };
      }
      if (selector.startsWith('role=')) {
        return {
          selector,
          first: vi.fn().mockReturnValue({
            getAttribute: vi
              .fn()
              .mockResolvedValue(testIdBySelector[selector] ?? null),
            textContent: vi
              .fn()
              .mockResolvedValue(textBySelector[selector] ?? null),
          }),
        };
      }
      return {
        first: vi.fn().mockReturnValue({
          waitFor: vi.fn().mockResolvedValue(undefined),
          evaluate: vi.fn().mockResolvedValue(undefined),
          getAttribute: vi
            .fn()
            .mockResolvedValue(testIdBySelector[selector] ?? null),
          textContent: vi
            .fn()
            .mockResolvedValue(textBySelector[selector] ?? null),
        }),
      };
    }),
  } as unknown as MockPageWithCdpSession;
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
    const { mockCdpSession } = page as MockPageWithCdpSession;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(mockCdpSession.send).toHaveBeenCalledWith(
      'Accessibility.getFullAXTree',
    );
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

  it('detaches CDP session on success', async () => {
    const page = createMockPage({ a11ySnapshot: '- button "Submit"' });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    await collectTrimmedA11ySnapshot(page);

    expect(mockCdpSession.detach).toHaveBeenCalled();
  });

  it('detaches CDP session on failure', async () => {
    const page = createMockPage({ fullAxTreeError: new Error('CDP failed') });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    await expect(collectTrimmedA11ySnapshot(page)).rejects.toThrowError(
      'CDP failed',
    );
    expect(mockCdpSession.detach).toHaveBeenCalled();
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
    const page = createMockPage({
      queryAxTreeNodes: rawNodesToAxNodes(
        parseAriaSnapshotYaml(`- dialog:\n  - button "Close"`),
      ),
      selectorNodes: {
        '.modal': {
          nodeId: 7,
          backendNodeId: 70,
        },
      },
    });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    const result = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(page.locator).toHaveBeenCalledWith('.modal');
    expect(mockCdpSession.send).toHaveBeenCalledWith('DOM.querySelector', {
      nodeId: 1,
      selector: '.modal',
    });
    expect(mockCdpSession.send).toHaveBeenCalledWith(
      'Accessibility.queryAXTree',
      { backendNodeId: 70 },
    );
    expect(result.nodes).toHaveLength(2);
  });

  it('falls back to getPartialAXTree when queryAXTree fails', async () => {
    const subtreeNodes: MockAXNode[] = [
      {
        nodeId: 'dialog',
        ignored: false,
        role: { type: 'role', value: 'dialog' },
        name: { type: 'string', value: 'Modal' },
        childIds: ['button'],
        backendDOMNodeId: 70,
      },
      {
        nodeId: 'button',
        ignored: false,
        role: { type: 'role', value: 'button' },
        name: { type: 'string', value: 'Close' },
        parentId: 'dialog',
        backendDOMNodeId: 80,
      },
    ];

    const page = createMockPage({
      partialAxNodes: subtreeNodes,
      queryAxTreeError: new Error('queryAXTree unavailable'),
      selectorNodes: {
        '.modal': {
          nodeId: 7,
          backendNodeId: 70,
        },
      },
    });

    const result = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].name).toBe('Modal');
    expect(result.nodes[1].name).toBe('Close');
  });

  it('does not leak ancestor nodes in scoped queryAXTree snapshots', async () => {
    const subtreeNodes: MockAXNode[] = [
      {
        nodeId: 'scoped-root',
        ignored: false,
        role: { type: 'role', value: 'generic' },
        childIds: ['submit', 'cancel'],
        backendDOMNodeId: 200,
      },
      {
        nodeId: 'submit',
        ignored: false,
        role: { type: 'role', value: 'button' },
        name: { type: 'string', value: 'Submit' },
        parentId: 'scoped-root',
        backendDOMNodeId: 201,
      },
      {
        nodeId: 'cancel',
        ignored: false,
        role: { type: 'role', value: 'button' },
        name: { type: 'string', value: 'Cancel' },
        parentId: 'scoped-root',
        backendDOMNodeId: 202,
      },
    ];

    const page = createMockPage({
      queryAxTreeNodes: subtreeNodes,
      selectorNodes: {
        '.scoped': {
          nodeId: 10,
          backendNodeId: 200,
        },
      },
    });

    const result = await collectTrimmedA11ySnapshot(page, '.scoped');

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({ role: 'button', name: 'Submit' });
    expect(result.nodes[1]).toMatchObject({ role: 'button', name: 'Cancel' });
    expect(result.nodes.every((n) => n.role !== 'dialog')).toBe(true);
    expect(result.nodes.every((n) => n.role !== 'main')).toBe(true);
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
    const page = createMockPage({
      a11ySnapshot: a11yTree,
      testIdBySelector: {
        'role=button[name="x"]': 'action-button',
      },
      textBySelector: {
        'role=button[name="x"]': 'Click me',
      },
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes[0].testId).toBe('action-button');
    expect(result.nodes[0].textContent).toBe('Click me');
  });

  it('skips textContent enrichment when text matches the node name', async () => {
    const a11yTree = `- main:\n  - button "maskicon"`;
    const page = createMockPage({
      a11ySnapshot: a11yTree,
      textBySelector: {
        'role=button[name="maskicon"]': 'maskicon',
      },
    });

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
    const page = {
      ...createMockPage({ a11ySnapshot: a11yTree }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid]') {
          return { all: vi.fn().mockResolvedValue([]) };
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
    const page = {
      ...createMockPage({ a11ySnapshot: a11yTree }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid]') {
          return { all: vi.fn().mockResolvedValue([]) };
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
    const page = {
      ...createMockPage({ a11ySnapshot: a11yTree }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid]') {
          return { all: vi.fn().mockResolvedValue([]) };
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

  it('includes named generic popover items exposed only by the AX tree', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['popover'],
        },
        {
          nodeId: 'popover',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          parentId: 'root',
          childIds: ['item-1', 'item-2'],
          backendDOMNodeId: 500,
        },
        {
          nodeId: 'item-1',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Rename account' },
          parentId: 'popover',
          backendDOMNodeId: 501,
        },
        {
          nodeId: 'item-2',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Account details' },
          parentId: 'popover',
          backendDOMNodeId: 502,
        },
      ],
      domSelectorsByBackendId: {
        501: '[data-testid="rename-account"]',
        502: '[data-testid="account-details"]',
      },
      textBySelector: {
        '[data-testid="rename-account"]': 'Rename account',
        '[data-testid="account-details"]': 'Account details',
      },
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({
      ref: 'e1',
      role: 'generic',
      name: 'Rename account',
    });
    expect(result.nodes[1]).toMatchObject({
      ref: 'e2',
      role: 'generic',
      name: 'Account details',
    });
    expect(result.refMap.get('e1')).toBe('[data-testid="rename-account"]');
    expect(result.refMap.get('e2')).toBe('[data-testid="account-details"]');
  });

  it('uses ancestor-path selector when data-testid is not unique', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['item-1', 'item-2'],
        },
        {
          nodeId: 'item-1',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Account A' },
          parentId: 'root',
          backendDOMNodeId: 510,
        },
        {
          nodeId: 'item-2',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Account B' },
          parentId: 'root',
          backendDOMNodeId: 511,
        },
      ],
      domSelectorsByBackendId: {
        510: 'div > div:nth-of-type(1) > span',
        511: 'div > div:nth-of-type(2) > span',
      },
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.refMap.get('e1')).toBe('div > div:nth-of-type(1) > span');
    expect(result.refMap.get('e2')).toBe('div > div:nth-of-type(2) > span');
  });

  it('falls back to text selector when selector resolution returns null for a generic node', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['orphan-generic'],
        },
        {
          nodeId: 'orphan-generic',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Unresolvable item' },
          parentId: 'root',
          backendDOMNodeId: 520,
        },
      ],
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      role: 'generic',
      name: 'Unresolvable item',
    });
    expect(result.refMap.get('e1')).toBe('text="Unresolvable item"');
  });

  it('excludes unnamed generic wrappers while still traversing their children', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['wrapper'],
        },
        {
          nodeId: 'wrapper',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          parentId: 'root',
          childIds: ['child-button'],
          backendDOMNodeId: 600,
        },
        {
          nodeId: 'child-button',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'Continue' },
          parentId: 'wrapper',
          backendDOMNodeId: 601,
        },
      ],
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ role: 'button', name: 'Continue' });
  });

  it('excludes nodes marked as ignored by the browser', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['hidden-btn'],
        },
        {
          nodeId: 'hidden-btn',
          ignored: true,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'Hidden' },
          parentId: 'root',
          backendDOMNodeId: 700,
        },
      ],
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(0);
    expect(result.refMap.size).toBe(0);
  });

  it('falls back to text selector when DOM.resolveNode fails for a generic node', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['stale-generic'],
        },
        {
          nodeId: 'stale-generic',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Stale item' },
          parentId: 'root',
          backendDOMNodeId: 900,
        },
      ],
      resolveNodeErrorIds: new Set([900]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      ref: 'e1',
      role: 'generic',
      name: 'Stale item',
    });
    expect(result.refMap.get('e1')).toBe('text="Stale item"');
  });

  it('drops a generic node entirely when DOM resolution fails and no name exists', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['stale-unnamed'],
        },
        {
          nodeId: 'stale-unnamed',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          parentId: 'root',
          backendDOMNodeId: 910,
          properties: [
            { name: 'expanded', value: { type: 'boolean', value: true } },
          ],
        },
      ],
      resolveNodeErrorIds: new Set([910]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(0);
    expect(result.refMap.size).toBe(0);
  });

  it('does not call DOM.resolveNode for included-role nodes', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['btn', 'link', 'heading'],
        },
        {
          nodeId: 'btn',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'Submit' },
          parentId: 'root',
          backendDOMNodeId: 920,
        },
        {
          nodeId: 'link',
          ignored: false,
          role: { type: 'role', value: 'link' },
          name: { type: 'string', value: 'Home' },
          parentId: 'root',
          backendDOMNodeId: 921,
        },
        {
          nodeId: 'heading',
          ignored: false,
          role: { type: 'role', value: 'heading' },
          name: { type: 'string', value: 'Title' },
          parentId: 'root',
          backendDOMNodeId: 922,
        },
      ],
    });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(3);
    expect(result.refMap.get('e1')).toBe('role=button[name="Submit"]');
    expect(result.refMap.get('e2')).toBe('role=link[name="Home"]');
    expect(result.refMap.get('e3')).toBe('role=heading[name="Title"]');

    const resolveNodeCalls = mockCdpSession.send.mock.calls.filter(
      (call) => call[0] === 'DOM.resolveNode',
    );
    expect(resolveNodeCalls).toHaveLength(0);
  });

  it('still resolves DOM selectors for generic nodes alongside included-role nodes', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['btn', 'generic-item'],
        },
        {
          nodeId: 'btn',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'root',
          backendDOMNodeId: 930,
        },
        {
          nodeId: 'generic-item',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          name: { type: 'string', value: 'Menu action' },
          parentId: 'root',
          backendDOMNodeId: 931,
        },
      ],
      domSelectorsByBackendId: {
        931: '[data-testid="menu-action"]',
      },
    });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(2);
    expect(result.refMap.get('e1')).toBe('role=button[name="OK"]');
    expect(result.refMap.get('e2')).toBe('[data-testid="menu-action"]');

    const resolveNodeCalls = mockCdpSession.send.mock.calls.filter(
      (call) => call[0] === 'DOM.resolveNode',
    );
    expect(resolveNodeCalls).toHaveLength(1);
    expect(resolveNodeCalls[0][1]).toMatchObject({ backendNodeId: 931 });
  });

  it('includes non-ignored children inside an ignored generic wrapper', async () => {
    const page = createMockPage({
      axNodes: [
        {
          nodeId: 'root',
          ignored: false,
          role: { type: 'role', value: 'main' },
          childIds: ['ignored-wrapper'],
        },
        {
          nodeId: 'ignored-wrapper',
          ignored: true,
          role: { type: 'role', value: 'generic' },
          parentId: 'root',
          childIds: ['visible-btn'],
          backendDOMNodeId: 800,
        },
        {
          nodeId: 'visible-btn',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'Visible' },
          parentId: 'ignored-wrapper',
          backendDOMNodeId: 801,
        },
      ],
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      role: 'button',
      name: 'Visible',
    });
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
