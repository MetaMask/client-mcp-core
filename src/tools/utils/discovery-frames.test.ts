import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  collectTrimmedA11ySnapshot,
  UNREACHABLE_REF_SELECTOR,
} from './discovery.js';

type AxNode = {
  nodeId: string;
  ignored: boolean;
  role: { type: 'role'; value: string };
  name?: { type: 'string'; value: string };
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
};

type Spec = {
  role: string;
  name?: string;
  backendDOMNodeId?: number;
  children?: Spec[];
};

/**
 * Builds a flat CDP AX node list under a root web area.
 *
 * @param prefix - Prefix of the node ids, unique per tree.
 * @param specs - The children of the root, nested.
 * @returns The flat node list.
 */
function axTree(prefix: string, specs: Spec[]): AxNode[] {
  const nodes: AxNode[] = [];
  let next = 0;
  const add = (spec: Spec, parentId: string): string => {
    next += 1;
    const nodeId = `${prefix}-${next}`;
    const node: AxNode = {
      nodeId,
      ignored: false,
      role: { type: 'role', value: spec.role },
      parentId,
      ...(spec.name === undefined
        ? {}
        : { name: { type: 'string', value: spec.name } }),
      ...(spec.backendDOMNodeId === undefined
        ? {}
        : { backendDOMNodeId: spec.backendDOMNodeId }),
    };
    nodes.push(node);
    node.childIds = (spec.children ?? []).map((child) => add(child, nodeId));
    return nodeId;
  };
  const rootId = `${prefix}-root`;
  const root: AxNode = {
    nodeId: rootId,
    ignored: false,
    role: { type: 'role', value: 'RootWebArea' },
  };
  root.childIds = specs.map((spec) => add(spec, rootId));
  return [root, ...nodes];
}

type FramePageOptions = {
  pageAxNodes: AxNode[];
  /** `DOM.describeNode` of an iframe's backend node id gives its frame id. */
  frameIdsByBackendId?: Record<number, string>;
  /** Frames the page session reads with `getFullAXTree({ frameId })`. */
  sameProcessFrames?: Record<string, AxNode[]>;
  /**
   * Frames with their own CDP session, by iframe key: its selector, or
   * `stamped(<backend node id>)` for an iframe selected by its stamp.
   */
  outOfProcessFrames?: Record<string, AxNode[]>;
  /** `data-testid` of the iframe element, by its backend node id. */
  testIdsByBackendId?: Record<number, string>;
  /** Nodes that left the page: they cannot be stamped. */
  detachedBackendIds?: number[];
  /** Nodes inside a closed shadow root. */
  unreachableBackendIds?: number[];
  /** Frame id of the iframe a CSS selector matches. */
  cssFrameIds?: Record<string, string>;
  /** Iframe keys (see `outOfProcessFrames`). */
  hiddenSelectors?: string[];
  missingSelectors?: string[];
  notIframeSelectors?: string[];
  /** `Accessibility.disable` and frame session `detach()` reject. */
  failCleanup?: boolean;
};

/**
 * Builds a page whose iframes are same-process (read on the page session
 * with a frame id) or out-of-process (read on their own session), as in
 * Chromium with site isolation.
 *
 * @param options - The page.
 * @returns The page and its sessions.
 */
function createFramePage(options: FramePageOptions): {
  page: Page;
  send: ReturnType<typeof vi.fn>;
  frameSessionDetach: ReturnType<typeof vi.fn>;
} {
  const {
    pageAxNodes,
    frameIdsByBackendId = {},
    sameProcessFrames = {},
    outOfProcessFrames = {},
    testIdsByBackendId = {},
    detachedBackendIds = [],
    unreachableBackendIds = [],
    cssFrameIds = {},
    hiddenSelectors = [],
    missingSelectors = [],
    notIframeSelectors = [],
    failCleanup = false,
  } = options;
  const cssSelectors = Object.keys(cssFrameIds);
  const backendIdsByToken = new Map<string, number>();
  const keyOf = (selector: string): string => {
    const token = /^\[data-mm-ref~="([^"]+)"\]$/u.exec(selector)?.[1];
    const backendId =
      token === undefined ? undefined : backendIdsByToken.get(token);
    return backendId === undefined ? selector : stamped(backendId);
  };
  const testIdCount = (selector: string): number =>
    Object.values(testIdsByBackendId).filter(
      (testId) => selector === `[data-testid="${testId}"]`,
    ).length;

  const send = vi.fn(
    async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case 'Accessibility.getFullAXTree': {
          const frameId = params.frameId as string | undefined;
          if (frameId === undefined) {
            return { nodes: pageAxNodes };
          }
          const frameNodes = sameProcessFrames[frameId];
          if (!frameNodes) {
            throw new Error('Frame with the given frameId is not found.');
          }
          return { nodes: frameNodes };
        }
        case 'Accessibility.queryAXTree':
          return { nodes: pageAxNodes };
        case 'Accessibility.disable':
          if (failCleanup) {
            throw new Error('Target closed');
          }
          return {};
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } };
        case 'DOM.querySelector': {
          const selector = String(params.selector);
          if (selector.includes('>>')) {
            throw new Error(`'${selector}' is not a valid selector`);
          }
          const index = cssSelectors.indexOf(selector);
          return { nodeId: index < 0 ? 0 : 100 + index };
        }
        case 'DOM.describeNode': {
          if (typeof params.backendNodeId === 'number') {
            return {
              node: {
                backendNodeId: params.backendNodeId,
                frameId: frameIdsByBackendId[params.backendNodeId],
                attributes:
                  testIdsByBackendId[params.backendNodeId] === undefined
                    ? ['id', 'frame']
                    : [
                        'id',
                        'frame',
                        'data-testid',
                        testIdsByBackendId[params.backendNodeId],
                      ],
              },
            };
          }
          const selector = cssSelectors[Number(params.nodeId) - 100];
          return {
            node: { backendNodeId: 900, frameId: cssFrameIds[selector] },
          };
        }
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'main' } } };
        case 'Page.createIsolatedWorld':
          return { executionContextId: 7 };
        case 'DOM.resolveNode':
          return {
            object: { objectId: `obj-${String(params.backendNodeId)}` },
          };
        case 'Runtime.callFunctionOn': {
          const backendNodeId = Number(
            String(params.objectId).replace('obj-', ''),
          );
          if (detachedBackendIds.includes(backendNodeId)) {
            return { result: { value: { status: 'detached' } } };
          }
          if (unreachableBackendIds.includes(backendNodeId)) {
            return { result: { value: { status: 'unreachable' } } };
          }
          const [, token] = params.arguments as { value: string }[];
          backendIdsByToken.set(token.value, backendNodeId);
          return { result: { value: { status: 'stamped', text: '' } } };
        }
        default:
          return {};
      }
    },
  );
  const pageSession = {
    send,
    on: vi.fn(),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const frameSessionDetach = failCleanup
    ? vi.fn().mockRejectedValue(new Error('Target closed'))
    : vi.fn().mockResolvedValue(undefined);
  const frames = new Map<string, { selector: string }>();
  const frameFor = (selector: string): { selector: string } => {
    const frame = frames.get(selector) ?? { selector };
    frames.set(selector, frame);
    return frame;
  };

  const page = {
    context: () => ({
      newCDPSession: vi.fn(async (target: unknown) => {
        if (target === page) {
          return pageSession;
        }
        const { selector } = target as { selector: string };
        const frameNodes = outOfProcessFrames[keyOf(selector)];
        if (!frameNodes) {
          throw new Error(
            "This frame does not have a separate CDP session, it is a part of the parent frame's session",
          );
        }
        return {
          send: vi.fn(async (method: string) =>
            method === 'Accessibility.getFullAXTree'
              ? { nodes: frameNodes }
              : {},
          ),
          detach: frameSessionDetach,
        };
      }),
    }),
    locator: vi.fn((selector: string) => ({
      count: vi.fn(async () => testIdCount(selector)),
      isVisible: vi.fn(async () => !hiddenSelectors.includes(keyOf(selector))),
      first: () => ({
        waitFor: missingSelectors.includes(selector)
          ? vi.fn().mockRejectedValue(new Error('Timeout 5000ms exceeded'))
          : vi.fn().mockResolvedValue(undefined),
        elementHandle: vi.fn().mockResolvedValue({
          contentFrame: vi
            .fn()
            .mockResolvedValue(
              notIframeSelectors.includes(keyOf(selector))
                ? null
                : frameFor(selector),
            ),
          dispose: vi.fn().mockResolvedValue(undefined),
        }),
        getAttribute: vi.fn().mockResolvedValue(null),
        textContent: vi.fn().mockResolvedValue(null),
      }),
    })),
  } as unknown as Page;

  return { page, send, frameSessionDetach };
}

/**
 * Key of an iframe selected by its stamp (see `createFramePage`).
 *
 * @param backendNodeId - The backend node id of the iframe element.
 * @returns The key.
 */
function stamped(backendNodeId: number): string {
  return `stamped:${backendNodeId}`;
}

const STAMP = /^\[data-mm-ref~="[^"]+"\]$/u;
const CHART_TEST_ID = 'advanced-chart-iframe';
const CHART = `[data-testid="${CHART_TEST_ID}"]`;
const SAME = '[data-testid="same-frame"]';
const inChart = (selector: string): string =>
  `${CHART} >> internal:control=enter-frame >> ${selector}`;

describe('collectTrimmedA11ySnapshot with iframes', () => {
  const chartTree = axTree('chart', [
    { role: 'heading', name: 'Chart' },
    { role: 'button', name: 'Zoom in' },
  ]);

  it('gives iframe elements a ref and adds the content of same-process and out-of-process iframes after the page nodes', async () => {
    const { page, frameSessionDetach } = createFramePage({
      pageAxNodes: axTree('page', [
        { role: 'button', name: 'Send' },
        {
          role: 'dialog',
          name: 'Perps',
          children: [
            { role: 'Iframe', name: 'Advanced chart', backendDOMNodeId: 10 },
          ],
        },
        { role: 'Iframe', name: 'Same', backendDOMNodeId: 11 },
      ]),
      frameIdsByBackendId: { 10: 'CHART', 11: 'SAME' },
      sameProcessFrames: {
        SAME: axTree('same', [{ role: 'button', name: 'Inside same' }]),
      },
      outOfProcessFrames: { [CHART]: chartTree },
      testIdsByBackendId: { 10: CHART_TEST_ID },
    });

    const { nodes, refMap } = await collectTrimmedA11ySnapshot(page);

    expect(
      nodes.map(({ ref, role, name, path }) => ({ ref, role, name, path })),
    ).toStrictEqual([
      { ref: 'e1', role: 'button', name: 'Send', path: [] },
      { ref: 'e2', role: 'dialog', name: 'Perps', path: ['dialog:Perps'] },
      {
        ref: 'e3',
        role: 'iframe',
        name: 'Advanced chart',
        path: ['dialog:Perps'],
      },
      { ref: 'e4', role: 'iframe', name: 'Same', path: [] },
      {
        ref: 'f1e1',
        role: 'heading',
        name: 'Chart',
        path: ['dialog:Perps', 'iframe:Advanced chart', 'heading:Chart'],
      },
      {
        ref: 'f1e2',
        role: 'button',
        name: 'Zoom in',
        path: ['dialog:Perps', 'iframe:Advanced chart'],
      },
      {
        ref: 'f2e1',
        role: 'button',
        name: 'Inside same',
        path: ['iframe:Same'],
      },
    ]);
    expect(refMap.get('e3')).toBe(CHART);
    expect(refMap.get('f1e2')).toBe(inChart('role=button[name="Zoom in" s]'));
    const sameSelector = refMap.get('e4');
    expect(sameSelector).toMatch(STAMP);
    expect(refMap.get('f2e1')).toBe(
      `${sameSelector} >> internal:control=enter-frame >> role=button[name="Inside same" s]`,
    );
    expect(frameSessionDetach).toHaveBeenCalledOnce();
  });

  it('enters an iframe by its stamp when its test ID is not unique', async () => {
    const { page } = createFramePage({
      pageAxNodes: axTree('page', [
        { role: 'Iframe', backendDOMNodeId: 10 },
        { role: 'Iframe', backendDOMNodeId: 11 },
      ]),
      frameIdsByBackendId: { 10: 'CHART', 11: 'OTHER' },
      outOfProcessFrames: { [stamped(10)]: chartTree },
      testIdsByBackendId: { 10: CHART_TEST_ID, 11: CHART_TEST_ID },
    });

    const { refMap } = await collectTrimmedA11ySnapshot(page);

    const iframeSelector = refMap.get('e1');
    expect(iframeSelector).toMatch(STAMP);
    expect(refMap.get('f1e2')).toBe(
      `${iframeSelector} >> internal:control=enter-frame >> role=button[name="Zoom in" s]`,
    );
  });

  it('keeps role selectors for duplicates in a frame and gives generic nodes a text selector, without DOM lookups', async () => {
    const { page, send } = createFramePage({
      pageAxNodes: axTree('page', [{ role: 'Iframe', backendDOMNodeId: 10 }]),
      frameIdsByBackendId: { 10: 'CHART' },
      outOfProcessFrames: {
        [CHART]: axTree('chart', [
          { role: 'button', name: 'Reset', backendDOMNodeId: 5 },
          { role: 'button', name: 'Reset', backendDOMNodeId: 6 },
          { role: 'generic', name: 'O 3201.22', backendDOMNodeId: 7 },
        ]),
      },
      testIdsByBackendId: { 10: CHART_TEST_ID },
    });

    const { refMap } = await collectTrimmedA11ySnapshot(page);

    expect(Object.fromEntries(refMap)).toStrictEqual({
      e1: CHART,
      f1e1: inChart('role=button[name="Reset" s]'),
      f1e2: inChart('role=button[name="Reset" s]'),
      f1e3: inChart('text="O 3201.22"'),
    });
    const resolved = send.mock.calls
      .filter(([method]) => method === 'DOM.resolveNode')
      .map(([, params]) => (params as { backendNodeId: number }).backendNodeId);
    expect(resolved).toStrictEqual([10]);
  });

  it('leaves out hidden iframes, iframes without a ref, frames that cannot be read and frames without nodes, numbering the others in order', async () => {
    const { page } = createFramePage({
      pageAxNodes: axTree('page', [
        { role: 'Iframe', name: 'Hidden', backendDOMNodeId: 1 },
        { role: 'Iframe', name: 'Detached', backendDOMNodeId: 2 },
        { role: 'Iframe', name: 'Closed shadow', backendDOMNodeId: 3 },
        { role: 'Iframe', name: 'Empty', backendDOMNodeId: 4 },
        { role: 'Iframe', name: 'Unreadable', backendDOMNodeId: 5 },
        { role: 'Iframe', name: 'Not iframe', backendDOMNodeId: 6 },
        { role: 'Iframe', name: 'Chart', backendDOMNodeId: 7 },
      ]),
      frameIdsByBackendId: { 4: 'EMPTY' },
      sameProcessFrames: { EMPTY: axTree('empty', []) },
      outOfProcessFrames: { [CHART]: chartTree },
      testIdsByBackendId: { 7: CHART_TEST_ID },
      detachedBackendIds: [2],
      unreachableBackendIds: [3],
      hiddenSelectors: [stamped(1)],
      notIframeSelectors: [stamped(6)],
    });

    const { nodes, refMap } = await collectTrimmedA11ySnapshot(page);

    expect(nodes.map(({ ref, name }) => `${ref}:${name}`)).toStrictEqual([
      'e1:Hidden',
      'e2:Closed shadow',
      'e3:Empty',
      'e4:Unreadable',
      'e5:Not iframe',
      'e6:Chart',
      'f1e1:Chart',
      'f1e2:Zoom in',
    ]);
    expect(refMap.get('e2')).toBe(UNREACHABLE_REF_SELECTOR);
  });

  it('reads at most 5 iframes with content and does not read iframes inside iframes', async () => {
    const iframes = Array.from({ length: 6 }, (_, index) => ({
      role: 'Iframe',
      backendDOMNodeId: index + 1,
    }));
    const frameIds = Object.fromEntries(
      iframes.map((_, index) => [index + 1, `F${index + 1}`]),
    );
    const { page } = createFramePage({
      pageAxNodes: axTree('page', iframes),
      frameIdsByBackendId: frameIds,
      sameProcessFrames: Object.fromEntries(
        iframes.map((_, index) => [
          `F${index + 1}`,
          axTree(`f${index + 1}`, [
            { role: 'button', name: `Frame ${index + 1}` },
            { role: 'Iframe', backendDOMNodeId: 50 + index },
          ]),
        ]),
      ),
    });

    const { nodes } = await collectTrimmedA11ySnapshot(page);

    expect(
      nodes.map(({ ref }) => ref).filter((ref) => ref.startsWith('f')),
    ).toStrictEqual(['f1e1', 'f2e1', 'f3e1', 'f4e1', 'f5e1']);
  });

  it('tries at most 10 iframes, hidden and empty ones included', async () => {
    const iframes = Array.from({ length: 12 }, (_, index) => ({
      role: 'Iframe',
      name: `Frame ${index + 1}`,
      backendDOMNodeId: index + 1,
    }));
    const { page, send } = createFramePage({
      pageAxNodes: axTree('page', iframes),
      frameIdsByBackendId: { 11: 'F11', 12: 'F12' },
      sameProcessFrames: {
        F11: axTree('f11', [{ role: 'button', name: 'Frame 11' }]),
        F12: axTree('f12', [{ role: 'button', name: 'Frame 12' }]),
      },
      hiddenSelectors: Array.from({ length: 10 }, (_, index) =>
        stamped(index + 1),
      ),
    });

    const { nodes } = await collectTrimmedA11ySnapshot(page);

    expect(nodes).toHaveLength(12);
    expect(nodes.some(({ ref }) => ref.startsWith('f'))).toBe(false);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === 'DOM.describeNode' &&
          typeof (params as { backendNodeId?: number }).backendNodeId ===
            'number',
      ),
    ).toHaveLength(10);
  });

  it('does not read iframes in a scoped snapshot', async () => {
    const { page, send } = createFramePage({
      pageAxNodes: axTree('page', [
        { role: 'button', name: 'Send', backendDOMNodeId: 900 },
        { role: 'Iframe', backendDOMNodeId: 10 },
      ]),
      frameIdsByBackendId: { 10: 'CHART' },
      outOfProcessFrames: { [CHART]: chartTree },
      testIdsByBackendId: { 10: CHART_TEST_ID },
      cssFrameIds: { '.modal': '' },
    });

    const { nodes } = await collectTrimmedA11ySnapshot(page, '.modal');

    expect(nodes.map(({ ref }) => ref)).toStrictEqual(['e1', 'e2']);
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === 'Accessibility.getFullAXTree' && params !== undefined,
      ),
    ).toBe(false);
  });

  describe('with a frame', () => {
    it('snapshots only the content of an out-of-process iframe, with the given ref prefix', async () => {
      const { page } = createFramePage({
        pageAxNodes: axTree('page', [{ role: 'button', name: 'Send' }]),
        cssFrameIds: { [CHART]: 'CHART' },
        outOfProcessFrames: { [CHART]: chartTree },
      });

      const { nodes, refMap } = await collectTrimmedA11ySnapshot(
        page,
        undefined,
        { selector: CHART, refPrefix: 'f3' },
      );

      expect(
        nodes.map(({ ref, name, path }) => ({ ref, name, path })),
      ).toStrictEqual([
        { ref: 'f3e1', name: 'Chart', path: ['heading:Chart'] },
        { ref: 'f3e2', name: 'Zoom in', path: [] },
      ]);
      expect([...refMap.keys()]).toStrictEqual(['f3e1', 'f3e2']);
      expect(refMap.get('f3e2')).toBe(inChart('role=button[name="Zoom in" s]'));
    });

    it('snapshots a same-process iframe found by a CSS selector', async () => {
      const { page } = createFramePage({
        pageAxNodes: [],
        cssFrameIds: { [SAME]: 'SAME' },
        sameProcessFrames: {
          SAME: axTree('same', [{ role: 'button', name: 'Inside same' }]),
        },
      });

      const { nodes } = await collectTrimmedA11ySnapshot(page, undefined, {
        selector: SAME,
        refPrefix: 'f1',
      });

      expect(nodes.map(({ ref, name }) => `${ref}:${name}`)).toStrictEqual([
        'f1e1:Inside same',
      ]);
    });

    it('reads an out-of-process iframe matched by a non-CSS selector', async () => {
      const selector = 'css=#host >> css=iframe';
      const { page } = createFramePage({
        pageAxNodes: [],
        outOfProcessFrames: { [selector]: chartTree },
      });

      const { nodes } = await collectTrimmedA11ySnapshot(page, undefined, {
        selector,
        refPrefix: 'f1',
      });

      expect(nodes).toHaveLength(2);
    });

    it.each([
      [
        'no element matches it',
        { missingSelectors: [CHART] },
        `Frame not found: no element matches ${CHART}`,
      ],
      [
        'it is not an iframe',
        { notIframeSelectors: [CHART] },
        `Frame not found: ${CHART} is not an iframe`,
      ],
      [
        'a same-process iframe has no CSS selector',
        {},
        `Frame ${CHART} cannot be read: target the iframe by testId or CSS selector`,
      ],
    ])('fails when %s', async (_label, options, message) => {
      const { page } = createFramePage({ pageAxNodes: [], ...options });

      await expect(
        collectTrimmedA11ySnapshot(page, undefined, {
          selector: CHART,
          refPrefix: 'f1',
        }),
      ).rejects.toThrowError(message);
    });

    it('cannot be combined with a root selector', async () => {
      const { page } = createFramePage({ pageAxNodes: [] });

      await expect(
        collectTrimmedA11ySnapshot(page, '.modal', {
          selector: CHART,
          refPrefix: 'f1',
        }),
      ).rejects.toThrowError('rootSelector cannot be combined with frame');
    });
  });

  it('returns the snapshot when closing the sessions fails', async () => {
    const { page, frameSessionDetach } = createFramePage({
      pageAxNodes: axTree('page', [
        { role: 'Iframe', name: 'Advanced chart', backendDOMNodeId: 10 },
      ]),
      frameIdsByBackendId: { 10: 'CHART' },
      outOfProcessFrames: { [CHART]: chartTree },
      testIdsByBackendId: { 10: CHART_TEST_ID },
      failCleanup: true,
    });

    const page1 = await collectTrimmedA11ySnapshot(page);
    const frame1 = await collectTrimmedA11ySnapshot(page, undefined, {
      selector: CHART,
      refPrefix: 'f1',
    });

    expect(page1.refMap.get('f1e2')).toBe(
      inChart('role=button[name="Zoom in" s]'),
    );
    expect(frame1.refMap.get('f1e2')).toBe(
      inChart('role=button[name="Zoom in" s]'),
    );
    expect(frameSessionDetach).toHaveBeenCalledTimes(2);
  });
});
