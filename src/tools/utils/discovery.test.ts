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
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import type { RawA11yNode } from '../types';
import { TESTID_COLLECT_TIMEOUT_MS } from './constants.js';
import {
  collectTestIds,
  collectTrimmedA11ySnapshot,
  parseAriaSnapshotYaml,
  resolveTarget,
  UNREACHABLE_REF_SELECTOR,
  waitForAnimationsToSettle,
  waitForTarget,
} from './discovery.js';
import { collectTestIdsInPage } from './in-page.js';
import type { InPageTestIdItem } from './in-page.js';

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
    testIds?: InPageTestIdItem[];
    isolatedWorldError?: Error;
    isolatedWorldException?: string;
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
    locatorTestIds?: {
      testId: string | null;
      visible: boolean;
      text?: string;
    }[];
  } = {},
): Page {
  const {
    testIds = [],
    isolatedWorldError,
    isolatedWorldException,
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
    locatorTestIds = [],
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
            case 'Page.getFrameTree':
              return { frameTree: { frame: { id: 'main-frame' } } };
            case 'Page.createIsolatedWorld':
              return { executionContextId: 7 };
            case 'Runtime.callFunctionOn': {
              if (params?.executionContextId !== undefined) {
                if (isolatedWorldError) {
                  throw isolatedWorldError;
                }
                if (isolatedWorldException) {
                  return {
                    result: { type: 'undefined' },
                    exceptionDetails: {
                      text: 'Uncaught',
                      exception: { description: isolatedWorldException },
                    },
                  };
                }
                return { result: { value: testIds } };
              }
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

  return {
    mockCdpSession,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue({
      newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
    }),
    locator: vi.fn((selector: string) => {
      if (selector === '[data-testid]') {
        return {
          all: vi.fn().mockResolvedValue(
            locatorTestIds.map((item) => ({
              getAttribute: vi.fn().mockResolvedValue(item.testId),
              isVisible: vi.fn().mockResolvedValue(item.visible),
              textContent: vi.fn().mockResolvedValue(item.text ?? null),
            })),
          ),
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
  it('collects test IDs with one isolated-world call', async () => {
    const page = createMockPage({
      testIds: [
        { testId: 'button-1', visible: true, text: 'Click me' },
        { testId: 'input-1', visible: false, text: '' },
      ],
    }) as MockPageWithCdpSession;

    const result = await collectTestIds(page);

    expect(result).toStrictEqual([
      { testId: 'button-1', tag: 'element', text: 'Click me', visible: true },
      { testId: 'input-1', tag: 'element', text: '', visible: false },
    ]);
    const calls = page.mockCdpSession.send.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      executionContextId: 7,
      arguments: [{ value: 150 }, { value: 100 }],
      returnByValue: true,
      awaitPromise: true,
    });
    expect(calls[0][1].functionDeclaration).toContain(
      collectTestIdsInPage.toString(),
    );
    expect(page.mockCdpSession.send).toHaveBeenCalledWith(
      'Page.createIsolatedWorld',
      { frameId: 'main-frame', worldName: '__mm_client_mcp_core__' },
    );
  });

  it('passes the limit to the page', async () => {
    const page = createMockPage() as MockPageWithCdpSession;

    await collectTestIds(page, 2);

    expect(page.mockCdpSession.send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ arguments: [{ value: 2 }, { value: 100 }] }),
    );
  });

  it('maps a null text to undefined', async () => {
    const page = createMockPage({
      testIds: [{ testId: 'no-text', visible: true, text: null }],
    });

    const result = await collectTestIds(page);

    expect(result).toStrictEqual([
      { testId: 'no-text', tag: 'element', text: undefined, visible: true },
    ]);
  });

  it('falls back to locators when the CDP call fails', async () => {
    const page = createMockPage({
      isolatedWorldError: new Error('Target closed'),
      locatorTestIds: [
        { testId: 'a', visible: true, text: '  Hello  ' },
        { testId: null, visible: true },
        { testId: 'b', visible: false },
      ],
    });

    expect(await collectTestIds(page)).toStrictEqual([
      { testId: 'a', tag: 'element', text: 'Hello', visible: true },
      { testId: 'b', tag: 'element', text: undefined, visible: false },
    ]);
    expect(page.locator).toHaveBeenCalledWith('[data-testid]');
  });

  it('falls back to locators when the page function throws', async () => {
    const page = createMockPage({
      isolatedWorldException: 'TypeError: boom',
      locatorTestIds: [{ testId: 'a', visible: true, text: 'A' }],
    });

    expect(await collectTestIds(page)).toStrictEqual([
      { testId: 'a', tag: 'element', text: 'A', visible: true },
    ]);
  });

  it('falls back to locators when the in-page call times out', async () => {
    vi.useFakeTimers();
    try {
      const page = createMockPage({
        locatorTestIds: [{ testId: 'slow', visible: true, text: 'S' }],
      }) as MockPageWithCdpSession;
      page.mockCdpSession.send.mockImplementation(async (method: string) => {
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'f' } } };
        }
        if (method === 'Page.createIsolatedWorld') {
          return { executionContextId: 3 };
        }
        return new Promise(() => undefined);
      });

      const pending = collectTestIds(page);
      let result: unknown;
      pending.then((value) => (result = value)).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(TESTID_COLLECT_TIMEOUT_MS - 1);
      expect(result).toBeUndefined();
      expect(page.locator).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toStrictEqual([
        { testId: 'slow', tag: 'element', text: 'S', visible: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects the limit and per-element errors in the locator fallback', async () => {
    const page = createMockPage({
      isolatedWorldError: new Error('Target closed'),
    });
    const locators = [
      {
        getAttribute: vi.fn().mockRejectedValue(new Error('detached')),
        isVisible: vi.fn(),
        textContent: vi.fn(),
      },
      {
        getAttribute: vi.fn().mockResolvedValue('a'),
        isVisible: vi.fn().mockRejectedValue(new Error('detached')),
        textContent: vi.fn().mockRejectedValue(new Error('detached')),
      },
      {
        getAttribute: vi.fn().mockResolvedValue('b'),
        isVisible: vi.fn().mockResolvedValue(true),
        textContent: vi.fn().mockResolvedValue('x'.repeat(300)),
      },
      {
        getAttribute: vi.fn().mockResolvedValue('c'),
        isVisible: vi.fn(),
        textContent: vi.fn(),
      },
    ];
    vi.mocked(page.locator).mockReturnValue({
      all: vi.fn().mockResolvedValue(locators),
    } as unknown as Locator);

    expect(await collectTestIds(page, 2)).toStrictEqual([
      { testId: 'a', tag: 'element', text: undefined, visible: false },
      { testId: 'b', tag: 'element', text: 'x'.repeat(100), visible: true },
    ]);
    expect(locators[3].getAttribute).not.toHaveBeenCalled();
  });

  it('returns an empty array when the locator fallback fails too', async () => {
    const page = createMockPage({
      isolatedWorldError: new Error('Target closed'),
    });
    vi.mocked(page.locator).mockReturnValue({
      all: vi.fn().mockRejectedValue(new Error('Target closed')),
    } as unknown as Locator);

    expect(await collectTestIds(page)).toStrictEqual([]);
  });

  it('returns an empty array when the page returns nothing', async () => {
    const page = createMockPage({
      testIds: undefined as unknown as InPageTestIdItem[],
    }) as MockPageWithCdpSession;
    page.mockCdpSession.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'f' } } };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: 1 };
      }
      return { result: {} };
    });

    expect(await collectTestIds(page)).toStrictEqual([]);
  });

  it('handles page load state failure', async () => {
    const page = createMockPage({
      testIds: [{ testId: 'test-1', visible: true, text: '' }],
    });
    vi.spyOn(page, 'waitForLoadState').mockRejectedValue(
      new Error('Load failed'),
    );

    const result = await collectTestIds(page);

    expect(result).toHaveLength(1);
  });
});

describe('waitForAnimationsToSettle', () => {
  it('runs the settle loop in the isolated world with the timeout', async () => {
    const page = createMockPage() as MockPageWithCdpSession;
    page.mockCdpSession.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'f' } } };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: 3 };
      }
      return { result: { value: true } };
    });

    expect(await waitForAnimationsToSettle(page, 1_000, 250)).toBe(true);

    const call = page.mockCdpSession.send.mock.calls.find(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(call?.[1]).toMatchObject({
      executionContextId: 3,
      arguments: [{ value: 1_000 }],
      awaitPromise: true,
    });
    expect(call?.[1].functionDeclaration).toContain('getAnimations');
    expect(call?.[1].functionDeclaration).toContain('requestAnimationFrame');
  });

  it('returns false when the CDP call fails', async () => {
    const page = createMockPage({
      isolatedWorldError: new Error('Target closed'),
    });

    expect(await waitForAnimationsToSettle(page, 1_000, 250)).toBe(false);
  });

  it('stops waiting after the timeout plus grace', async () => {
    vi.useFakeTimers();
    try {
      const page = createMockPage() as MockPageWithCdpSession;
      page.mockCdpSession.send.mockImplementation(async (method: string) => {
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'f' } } };
        }
        if (method === 'Page.createIsolatedWorld') {
          return { executionContextId: 3 };
        }
        return new Promise(() => undefined);
      });

      const pending = waitForAnimationsToSettle(page, 1_000, 250);
      await vi.advanceTimersByTimeAsync(1_249);
      let settled: boolean | undefined;
      pending.then((value) => (settled = value)).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    expect(result.refMap.get('e1')).toBe('role=button[name="Submit" s]');
    expect(result.refMap.get('e2')).toBe('role=button[name="Cancel" s]');
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

    expect(result.refMap.get('e1')).toBe(
      'role=button[name="Say \\"Hello\\"" s]',
    );
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
    // Each collapsed member keeps its own ref. Without DOM selectors they
    // share the role selector, so an action on one fails in strict mode.
    expect([1, 2, 3, 4].map((i) => result.refMap.get(`e${i}`))).toStrictEqual(
      [0, 1, 2, 3].map(() => 'role=button[name="maskicon" s]'),
    );
    expect(result.refMap.get('e5')).toBe('role=button[name="Submit" s]');
  });

  it('keeps the dialog and heading ancestry in path on the browser', async () => {
    const a11yTree = [
      '- main:',
      '  - heading "Send" [level=2]',
      '  - dialog "Transaction":',
      '    - button "Confirm"',
      '    - button "Confirm"',
      '    - button "Confirm"',
    ].join('\n');

    const page = createMockPage({ a11ySnapshot: a11yTree });
    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes.map((node) => [node.name, node.path])).toStrictEqual([
      ['Send', ['heading:Send']],
      ['Transaction', ['dialog:Transaction']],
      ['Confirm', ['dialog:Transaction']],
      ['\u2026 2 more "Confirm" (refs e3\u2013e5)', ['dialog:Transaction']],
    ]);
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
      (n) => n.role === 'button' && n.path?.some((p) => p.includes('dialog:A')),
    );
    const dialogBButtons = result.nodes.filter(
      (n) => n.role === 'button' && n.path?.some((p) => p.includes('dialog:B')),
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
        'role=button[name="x" s]': 'action-button',
      },
      textBySelector: {
        'role=button[name="x" s]': 'Click me',
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
        'role=button[name="maskicon" s]': 'maskicon',
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
    expect(result.refMap.get('e1')).toBe('role=button[name="Submit" s]');
    expect(result.refMap.get('e2')).toBe('role=link[name="Home" s]');
    expect(result.refMap.get('e3')).toBe('role=heading[name="Title" s]');

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
    expect(result.refMap.get('e1')).toBe('role=button[name="OK" s]');
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

/**
 * `waitForTarget` passes the time left until its deadline, which can be a
 * few ms below the budget on a slow runner.
 *
 * @param budgetMs - The timeout given to `waitForTarget`.
 * @returns An asymmetric matcher for a timeout in (budget - 100, budget].
 */
function expectRemaining(budgetMs: number): number {
  return expect.toSatisfy(
    (value: number) => value <= budgetMs && value > budgetMs - 100,
  ) as unknown as number;
}

describe('exact ref selectors', () => {
  /**
   * Builds a flat CDP AX node list: one `main` root with the given children.
   *
   * @param children - The child nodes (role, name, optional backend id).
   * @returns The AX nodes.
   */
  function flatTree(
    children: { role: string; name?: string; backendDOMNodeId?: number }[],
  ): MockAXNode[] {
    return [
      {
        nodeId: 'root',
        ignored: false,
        role: { type: 'role', value: 'main' },
        childIds: children.map((_, index) => `c${index}`),
      },
      ...children.map(
        (child, index): MockAXNode => ({
          nodeId: `c${index}`,
          ignored: false,
          role: { type: 'role', value: child.role },
          ...(child.name === undefined
            ? {}
            : { name: { type: 'string', value: child.name } }),
          parentId: 'root',
          backendDOMNodeId: child.backendDOMNodeId ?? 1000 + index,
        }),
      ),
    ];
  }

  it('keeps the plain role selector for duplicates without a DOM selector, so strict mode fails (AC1)', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Send' },
        { role: 'button', name: 'Send' },
      ]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.nodes.map((node) => node.ref)).toStrictEqual(['e1', 'e2']);
    // No nth index: AX order and Playwright order can differ.
    expect(result.refMap.get('e1')).toBe('role=button[name="Send" s]');
    expect(result.refMap.get('e2')).toBe('role=button[name="Send" s]');
  });

  it('resolves each duplicate ref to its own DOM selector (AC1)', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Send', backendDOMNodeId: 1 },
        { role: 'link', name: 'Send', backendDOMNodeId: 2 },
        { role: 'button', name: 'Send', backendDOMNodeId: 3 },
      ]),
      domSelectorsByBackendId: {
        1: 'button:nth-of-type(1)',
        3: 'button:nth-of-type(2)',
      },
    });
    const { refMap } = await collectTrimmedA11ySnapshot(page);
    vi.mocked(page.locator).mockClear();

    await resolveTarget(page, 'a11yRef', 'e1', refMap);
    await resolveTarget(page, 'a11yRef', 'e3', refMap);

    expect(vi.mocked(page.locator).mock.calls).toStrictEqual([
      ['button:nth-of-type(1)'],
      ['button:nth-of-type(2)'],
    ]);
    // Another role is another group: unique, no DOM lookup.
    expect(refMap.get('e2')).toBe('role=link[name="Send" s]');

    const locator = createMockLocator();
    const waitPage = {
      locator: vi.fn().mockReturnValue(locator),
    } as unknown as Page;
    await waitForTarget(waitPage, 'a11yRef', 'e3', refMap, 5000);
    expect(waitPage.locator).toHaveBeenCalledWith('button:nth-of-type(2)');
    expect(locator.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: expectRemaining(5000),
    });
  });

  // Playwright's role= engine already matches a quoted name exactly and
  // case-sensitively; this documents that refs rely on it ("Send" and "Send
  // max" are different selectors, so neither needs a DOM selector or nth).
  it('keeps different names in different selectors, without nth (AC2)', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Send' },
        { role: 'button', name: 'Send max' },
      ]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.refMap.get('e1')).toBe('role=button[name="Send" s]');
    expect(result.refMap.get('e2')).toBe('role=button[name="Send max" s]');
  });

  it('gives each duplicate a DOM selector when one can be built', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Send', backendDOMNodeId: 1 },
        { role: 'button', name: 'Send max', backendDOMNodeId: 2 },
        { role: 'button', name: 'Send', backendDOMNodeId: 3 },
      ]),
      domSelectorsByBackendId: {
        1: '[data-testid="send-a"]',
        2: '[data-testid="send-max"]',
        3: '#send-b',
      },
    });
    const { mockCdpSession } = page as MockPageWithCdpSession;

    const result = await collectTrimmedA11ySnapshot(page);

    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: '[data-testid="send-a"]',
      e2: 'role=button[name="Send max" s]',
      e3: '#send-b',
    });
    // Only duplicates pay for a DOM lookup.
    const resolved = mockCdpSession.send.mock.calls
      .filter(([method]) => method === 'DOM.resolveNode')
      .map(([, params]) => (params as { backendNodeId: number }).backendNodeId);
    expect(resolved.sort()).toStrictEqual([1, 3]);
  });

  it('keeps the plain role selector for duplicates whose DOM selector cannot be built', async () => {
    const page = createMockPage({
      axNodes: [
        ...flatTree([
          { role: 'button', name: 'OK', backendDOMNodeId: 1 },
          { role: 'button', name: 'OK', backendDOMNodeId: 2 },
          { role: 'button', name: 'OK', backendDOMNodeId: 3 },
        ]),
        {
          nodeId: 'no-backend',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'root',
        },
      ].map((node) =>
        node.nodeId === 'root'
          ? { ...node, childIds: [...(node.childIds ?? []), 'no-backend'] }
          : node,
      ),
      // 1: unique selector; 2: no unique selector (null); 3: resolve fails.
      domSelectorsByBackendId: { 1: '#ok-1' },
      resolveNodeErrorIds: new Set([3]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    // No unique selector, resolve failure (e.g. navigation mid-snapshot),
    // no backend node: the role selector matches the whole group, so an
    // action fails in strict mode instead of clicking another member.
    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: '#ok-1',
      e2: 'role=button[name="OK" s]',
      e3: 'role=button[name="OK" s]',
      e4: 'role=button[name="OK" s]',
    });
  });

  it('marks a duplicate inside a closed shadow root unreachable and skips its enrichment', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Send', backendDOMNodeId: 1 },
        { role: 'button', name: 'Send', backendDOMNodeId: 2 },
      ]),
      domSelectorsByBackendId: { 1: UNREACHABLE_REF_SELECTOR, 2: 'button' },
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: UNREACHABLE_REF_SELECTOR,
      e2: 'button',
    });
    expect(page.locator).not.toHaveBeenCalledWith(UNREACHABLE_REF_SELECTOR);
  });

  it('gives duplicates of a scoped snapshot DOM selectors without the root prefix', async () => {
    const page = createMockPage({
      queryAxTreeNodes: [
        {
          nodeId: 'scoped-root',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          childIds: ['ok-1', 'ok-2'],
          backendDOMNodeId: 200,
        },
        {
          nodeId: 'ok-1',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'scoped-root',
          backendDOMNodeId: 201,
        },
        {
          nodeId: 'ok-2',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'scoped-root',
          backendDOMNodeId: 202,
        },
      ],
      selectorNodes: { '.modal': { nodeId: 7, backendNodeId: 200 } },
      domSelectorsByBackendId: { 201: '#ok-1' },
    });

    const result = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: '#ok-1',
      e2: 'css=.modal >> nth=0 >> role=button[name="OK" s]',
    });
  });

  it('runs DOM selector lookups concurrently, at most 16 at a time', async () => {
    const count = 40;
    const page = createMockPage({
      axNodes: flatTree(
        Array.from({ length: count }, (_, index) => ({
          role: 'button',
          name: 'Send',
          backendDOMNodeId: index + 1,
        })),
      ),
      domSelectorsByBackendId: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          index + 1,
          `#send-${index + 1}`,
        ]),
      ),
    });
    const { mockCdpSession } = page as MockPageWithCdpSession;
    const send = mockCdpSession.send.getMockImplementation() as (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
    let inFlight = 0;
    let maxInFlight = 0;
    mockCdpSession.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method !== 'DOM.resolveNode') {
          return send(method, params);
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return send(method, params);
      },
    );

    const result = await collectTrimmedA11ySnapshot(page);

    expect(maxInFlight).toBe(16);
    expect(result.refMap.size).toBe(count);
    expect(result.refMap.get('e1')).toBe('#send-1');
    expect(result.refMap.get(`e${count}`)).toBe(`#send-${count}`);
  });

  it('escapes backslashes and quotes and normalizes whitespace in names', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button', name: 'Say "hi"' },
        { role: 'button', name: 'C:\\path\\' },
        { role: 'button', name: '  Line 1\n\tLine 2  ' },
        { role: 'button', name: 'Line 1 Line 2' },
        { role: 'link', name: 'a >> b' },
      ]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.refMap.get('e1')).toBe('role=button[name="Say \\"hi\\"" s]');
    expect(result.refMap.get('e2')).toBe(
      'role=button[name="C:\\\\path\\\\" s]',
    );
    // Same normalized name → same elements in Playwright → one selector.
    expect(result.refMap.get('e3')).toBe('role=button[name="Line 1 Line 2" s]');
    expect(result.refMap.get('e4')).toBe('role=button[name="Line 1 Line 2" s]');
    expect(result.refMap.get('e5')).toBe('role=link[name="a >> b" s]');
  });

  it('matches only an empty accessible name for unnamed nodes', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'button' },
        { role: 'button', name: '' },
        { role: 'button', name: 'Close' },
      ]),
    });

    const result = await collectTrimmedA11ySnapshot(page);

    expect(result.refMap.get('e1')).toBe('role=button[name="" s]');
    expect(result.refMap.get('e2')).toBe('role=button[name="" s]');
    expect(result.refMap.get('e3')).toBe('role=button[name="Close" s]');
  });

  it('keeps identical text= fallback selectors strict, without nth', async () => {
    const page = createMockPage({
      axNodes: flatTree([
        { role: 'generic', name: 'Account 1', backendDOMNodeId: 1 },
        { role: 'generic', name: 'Account 1', backendDOMNodeId: 2 },
        { role: 'generic', name: 'Say "hi" \\o/', backendDOMNodeId: 3 },
        { role: 'generic', name: 'Account 1', backendDOMNodeId: 4 },
      ]),
      domSelectorsByBackendId: { 4: '[data-testid="account-1"]' },
    });

    const result = await collectTrimmedA11ySnapshot(page);

    // text= also matches wrappers of the text: an nth index could point at
    // another element, so an ambiguous text ref fails in strict mode.
    expect(result.refMap.get('e1')).toBe('text="Account 1"');
    expect(result.refMap.get('e2')).toBe('text="Account 1"');
    expect(result.refMap.get('e3')).toBe('text="Say \\"hi\\" \\\\o/"');
    expect(result.refMap.get('e4')).toBe('[data-testid="account-1"]');
  });

  it('prefixes role and text selectors of a scoped snapshot with the root', async () => {
    const page = createMockPage({
      queryAxTreeNodes: [
        {
          nodeId: 'scoped-root',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          childIds: ['ok-1', 'ok-2', 'label', 'item'],
          backendDOMNodeId: 200,
        },
        ...flatTree([
          { role: 'button', name: 'OK' },
          { role: 'button', name: 'OK' },
          { role: 'generic', name: 'Fee', backendDOMNodeId: 1 },
          { role: 'generic', name: 'Row', backendDOMNodeId: 2 },
        ])
          .slice(1)
          .map((node, index) => ({
            ...node,
            nodeId: ['ok-1', 'ok-2', 'label', 'item'][index],
            parentId: 'scoped-root',
          })),
      ],
      selectorNodes: { ' .modal ': { nodeId: 7, backendNodeId: 200 } },
      domSelectorsByBackendId: { 2: '#row' },
    });

    const result = await collectTrimmedA11ySnapshot(page, ' .modal ');

    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: 'css=.modal >> nth=0 >> role=button[name="OK" s]',
      e2: 'css=.modal >> nth=0 >> role=button[name="OK" s]',
      e3: 'css=.modal >> nth=0 >> text="Fee"',
      e4: '#row',
    });
  });

  it('maps the scope root itself to the root selector', async () => {
    const page = createMockPage({
      queryAxTreeNodes: [
        {
          nodeId: 'dialog',
          ignored: false,
          role: { type: 'role', value: 'dialog' },
          name: { type: 'string', value: 'Confirm' },
          childIds: ['close'],
          backendDOMNodeId: 70,
        },
        {
          nodeId: 'close',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'Close' },
          parentId: 'dialog',
          backendDOMNodeId: 71,
        },
      ],
      selectorNodes: { '[role="dialog"]': { nodeId: 7, backendNodeId: 70 } },
    });

    const result = await collectTrimmedA11ySnapshot(page, '[role="dialog"]');

    expect(result.refMap.get('e1')).toBe('css=[role="dialog"] >> nth=0');
    expect(result.refMap.get('e2')).toBe(
      'css=[role="dialog"] >> nth=0 >> role=button[name="Close" s]',
    );
  });

  it('keeps relatives of the root page-wide in the getPartialAXTree fallback', async () => {
    const page = createMockPage({
      queryAxTreeError: new Error('queryAXTree unavailable'),
      partialAxNodes: [
        {
          nodeId: 'ancestor',
          ignored: false,
          role: { type: 'role', value: 'dialog' },
          name: { type: 'string', value: 'Wallet' },
          childIds: ['sibling', 'scoped-root'],
          backendDOMNodeId: 60,
        },
        {
          nodeId: 'sibling',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'ancestor',
          backendDOMNodeId: 61,
        },
        {
          nodeId: 'scoped-root',
          ignored: false,
          role: { type: 'role', value: 'generic' },
          parentId: 'ancestor',
          childIds: ['inner'],
          backendDOMNodeId: 70,
        },
        {
          nodeId: 'inner',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'string', value: 'OK' },
          parentId: 'scoped-root',
          backendDOMNodeId: 71,
        },
      ],
      selectorNodes: { '.modal': { nodeId: 7, backendNodeId: 70 } },
    });

    const result = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(Object.fromEntries(result.refMap)).toStrictEqual({
      e1: 'role=dialog[name="Wallet" s]',
      e2: 'role=button[name="OK" s]',
      e3: 'css=.modal >> nth=0 >> role=button[name="OK" s]',
    });
  });

  describe('Playwright selector parser round-trip', () => {
    type AttributePart = {
      name: string;
      op: string;
      value: unknown;
      caseSensitive: boolean;
    };
    type SelectorParser = {
      parseSelector: (selector: string) => {
        parts: { name: string; source: string }[];
      };
      parseAttributeSelector: (
        selector: string,
        allowUnquotedStrings: boolean,
      ) => { name: string; attributes: AttributePart[] };
    };

    // playwright-core does not export its selector parser; load the
    // internal file the injected script is built from (resolved through
    // `playwright`). The path is not public API: skip these tests when a
    // playwright-core version moves it.
    const requireFromRoot = createRequire(
      path.join(process.cwd(), 'package.json'),
    );
    const requireFromPlaywright = createRequire(
      requireFromRoot.resolve('playwright/package.json'),
    );
    const parserPath = path.join(
      path.dirname(
        requireFromPlaywright.resolve('playwright-core/package.json'),
      ),
      'lib/utils/isomorphic/selectorParser.js',
    );
    let parser: SelectorParser | undefined;
    try {
      parser = requireFromPlaywright(parserPath) as SelectorParser;
    } catch (error) {
      if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
    const parserMissing = parser === undefined;

    it
      .skipIf(parserMissing)
      .each([
        'Send',
        'Send max',
        'Say "hi"',
        'C:\\path\\',
        '\\"',
        'a >> b',
        'Ünïcode ✓',
        '',
      ])(
      'parses the role selector for %j back to the exact name (internal playwright-core selectorParser)',
      async (name) => {
        const page = createMockPage({
          queryAxTreeNodes: flatTree([
            { role: 'button', name },
            { role: 'button', name },
          ]),
          selectorNodes: { '.modal': { nodeId: 7, backendNodeId: 70 } },
        });

        const { refMap } = await collectTrimmedA11ySnapshot(page, '.modal');
        const { parts } = (parser as SelectorParser).parseSelector(
          refMap.get('e2') as string,
        );

        expect(parts.map((part) => part.name)).toStrictEqual([
          'css',
          'nth',
          'role',
        ]);
        expect(parts[0].source).toBe('.modal');
        const role = (parser as SelectorParser).parseAttributeSelector(
          parts[2].source,
          true,
        );
        expect(role.name).toBe('button');
        expect(role.attributes).toStrictEqual([
          expect.objectContaining({
            name: 'name',
            op: '=',
            value: name,
            caseSensitive: true,
          }),
        ]);
      },
    );

    it.skipIf(parserMissing)(
      'keeps a text= selector with quotes, backslashes and >> in one part (internal playwright-core selectorParser)',
      async () => {
        const name = 'a >> "b" \\ c';
        const page = createMockPage({
          axNodes: flatTree([
            { role: 'generic', name },
            { role: 'generic', name },
          ]),
        });

        const { refMap } = await collectTrimmedA11ySnapshot(page);
        const { parts } = (parser as SelectorParser).parseSelector(
          refMap.get('e1') as string,
        );

        expect(parts.map((part) => [part.name, part.source])).toStrictEqual([
          ['text', '"a >> \\"b\\" \\\\ c"'],
        ]);
      },
    );
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

  it('throws for a ref inside a closed shadow root instead of matching another element', async () => {
    const refMap = new Map([['e1', UNREACHABLE_REF_SELECTOR]]);
    const page = createMockPage();

    await expect(
      resolveTarget(page, 'a11yRef', 'e1', refMap),
    ).rejects.toThrowError(
      'Ref e1 is inside a closed shadow root: it cannot be targeted',
    );
    expect(page.locator).not.toHaveBeenCalled();
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
      timeout: expectRemaining(5000),
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
      timeout: expectRemaining(5000),
    });
    expect(firstParentLocator.locator).toHaveBeenCalledWith(
      '[data-testid="end-accessory"]',
    );
    expect(result).toBe(childLocator);
  });

  /**
   * Builds a page whose `e1` ref is the within parent and whose other refs
   * resolve to `refLocator`.
   *
   * @param counts - Match counts of the page-wide ref locator and of the
   * contained (`and`) locator.
   * @param counts.ref - Page-wide matches of the ref.
   * @param counts.contained - Matches of the ref inside the parent.
   * @returns The page, its locators and the ref map.
   */
  function createWithinRefPage(counts: { ref: number; contained: number }) {
    const refMap = new Map([
      ['e1', '[data-testid="account-cell"]'],
      ['e2', 'css=#list >> css=button:nth-of-type(2)'],
    ]);
    const contained = {
      ...createMockLocator({ visible: true }),
      count: vi.fn().mockResolvedValue(counts.contained),
    };
    const descendants = { kind: 'descendants' };
    const firstParentLocator = {
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(descendants),
    };
    const parentLocator = {
      first: vi.fn().mockReturnValue(firstParentLocator),
    };
    const firstRef = { waitFor: vi.fn().mockResolvedValue(undefined) };
    const refLocator = {
      and: vi.fn().mockReturnValue(contained),
      count: vi.fn().mockResolvedValue(counts.ref),
      first: vi.fn().mockReturnValue(firstRef),
    };
    const page = {
      locator: vi.fn((selector: string) =>
        selector === refMap.get('e1') ? parentLocator : refLocator,
      ),
    } as unknown as Page;
    return {
      page,
      refMap,
      contained,
      descendants,
      firstParentLocator,
      refLocator,
      firstRef,
    };
  }

  it('resolves an a11yRef page-wide and keeps it only inside the within parent', async () => {
    const {
      page,
      refMap,
      contained,
      descendants,
      firstParentLocator,
      refLocator,
    } = createWithinRefPage({ ref: 1, contained: 1 });

    const result = await waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
      type: 'a11yRef',
      value: 'e1',
    });

    // The ref selector is unique in the document, so it is not re-applied
    // inside the parent.
    expect(page.locator).toHaveBeenCalledWith(
      'css=#list >> css=button:nth-of-type(2)',
    );
    expect(firstParentLocator.locator).toHaveBeenCalledWith('*');
    expect(refLocator.and).toHaveBeenCalledWith(descendants);
    expect(contained.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: expectRemaining(5000),
    });
    expect(result).toBe(contained);
  });

  it('fails at once when the ref is on the page but outside the within parent', async () => {
    const { page, refMap, contained } = createWithinRefPage({
      ref: 1,
      contained: 0,
    });

    await expect(
      waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
        type: 'a11yRef',
        value: 'e1',
      }),
    ).rejects.toThrowError('Ref e2 is not inside the within element');
    // Checked twice (the page can change between the two counts).
    expect(contained.count).toHaveBeenCalledTimes(2);
    expect(contained.waitFor).not.toHaveBeenCalled();
  });

  it('waits instead of failing when the ref moves into the within parent between the checks', async () => {
    const { page, refMap, contained } = createWithinRefPage({
      ref: 1,
      contained: 0,
    });
    contained.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const result = await waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
      type: 'a11yRef',
      value: 'e1',
    });

    expect(contained.count).toHaveBeenCalledTimes(2);
    expect(contained.waitFor).toHaveBeenCalled();
    expect(result).toBe(contained);
  });

  it('waits for a ref that is not on the page yet instead of failing at once', async () => {
    const { page, refMap, contained, refLocator, firstRef } =
      createWithinRefPage({ ref: 0, contained: 0 });
    // Not on the page at the first check; one match once it is attached.
    refLocator.count.mockResolvedValueOnce(0).mockResolvedValue(1);

    const result = await waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
      type: 'a11yRef',
      value: 'e1',
    });

    // No containment verdict while it is not on the page: wait for it.
    expect(contained.count).not.toHaveBeenCalled();
    expect(firstRef.waitFor).toHaveBeenCalledWith({
      state: 'attached',
      timeout: expectRemaining(5000),
    });
    expect(contained.waitFor).toHaveBeenCalled();
    expect(result).toBe(contained);
  });

  it('throws instead of narrowing an ambiguous ref to the match inside the within parent', async () => {
    const { page, refMap, contained } = createWithinRefPage({
      ref: 9,
      contained: 1,
    });

    await expect(
      waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
        type: 'a11yRef',
        value: 'e1',
      }),
    ).rejects.toThrowError(
      'Ref e2 is ambiguous (9 matches); take a new snapshot or target it by testId or selector',
    );
    expect(contained.count).not.toHaveBeenCalled();
    expect(contained.waitFor).not.toHaveBeenCalled();
  });

  it('throws when a ref that appears later is ambiguous', async () => {
    const { page, refMap, contained, refLocator } = createWithinRefPage({
      ref: 0,
      contained: 1,
    });
    refLocator.count.mockResolvedValueOnce(0).mockResolvedValue(2);

    await expect(
      waitForTarget(page, 'a11yRef', 'e2', refMap, 5000, {
        type: 'a11yRef',
        value: 'e1',
      }),
    ).rejects.toThrowError('Ref e2 is ambiguous (2 matches)');
    expect(contained.waitFor).not.toHaveBeenCalled();
  });

  it('throws on timeout when no time is left after the within checks', async () => {
    const { page, refMap } = createWithinRefPage({ ref: 0, contained: 0 });
    const now = vi.spyOn(Date, 'now');
    // deadline = 0 + 1000; parent check at 0; the ref check at 2000.
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2000);

    await expect(
      waitForTarget(page, 'a11yRef', 'e2', refMap, 1000, {
        type: 'a11yRef',
        value: 'e1',
      }),
    ).rejects.toThrowError('Timeout 1000ms exceeded waiting for element');
    now.mockRestore();
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
