/**
 * Tests for the in-page functions. Each function is compiled from its own
 * source text (`fn.toString()`, as sent to the page) in a fresh `vm`
 * context whose only globals are the DOM fakes, so a function that uses a
 * module import or a closure fails here as it would in the page.
 */
import * as vm from 'node:vm';
import { describe, it, expect } from 'vitest';

import * as inPage from './in-page.js';
import {
  animationsSettled,
  collectTestIdsInPage,
  waitUntilInPage,
} from './in-page.js';

type Rect = { x: number; y: number; width: number; height: number };

type FakeStyle = { display?: string; visibility?: string };

type FakeNode = {
  nodeType: number;
  nextSibling: FakeNode | null;
  rect?: Rect;
};

type FakeElement = FakeNode & {
  testId?: string | null;
  text: string | null;
  style: FakeStyle;
  checkVisible: boolean;
  children: FakeNode[];
  firstChild: FakeNode | null;
  shadowRoot: FakeRoot | null;
  nodeName: string;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => DOMRect;
  checkVisibility?: () => boolean;
  closest: (selector: string) => FakeElement | null;
  open?: boolean;
  parent: FakeElement | null;
  readonly textContent: string | null;
};

type FakeRoot = {
  elements: FakeElement[];
  querySelectorAll: (selector: string) => FakeElement[];
};

/**
 * Builds a DOMRect-like object.
 *
 * @param rect - Position and size.
 * @returns The rect.
 */
function toDomRect(rect: Rect): DOMRect {
  return {
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  } as DOMRect;
}

/**
 * Builds a fake element.
 *
 * @param options - Element properties.
 * @param options.testId - The data-testid value (null: no attribute).
 * @param options.text - The textContent.
 * @param options.rect - The bounding box (default 10x10 at the origin).
 * @param options.style - Computed style values.
 * @param options.checkVisible - What checkVisibility() returns.
 * @param options.children - Child nodes (elements or text nodes).
 * @param options.shadowRoot - An attached open shadow root.
 * @param options.nodeName - The node name.
 * @returns The element.
 */
function element(
  options: {
    testId?: string | null;
    text?: string | null;
    rect?: Rect;
    style?: FakeStyle;
    checkVisible?: boolean;
    children?: FakeNode[];
    shadowRoot?: FakeRoot;
    nodeName?: string;
  } = {},
): FakeElement {
  const children = options.children ?? [];
  children.forEach((child, index) => {
    child.nextSibling = children[index + 1] ?? null;
  });
  const fake: FakeElement = {
    nodeType: 1,
    nextSibling: null,
    testId: options.testId,
    text: options.text === undefined ? '' : options.text,
    rect: options.rect ?? { x: 0, y: 0, width: 10, height: 10 },
    style: options.style ?? {},
    checkVisible: options.checkVisible ?? true,
    children,
    firstChild: children[0] ?? null,
    shadowRoot: options.shadowRoot ?? null,
    nodeName: options.nodeName ?? 'DIV',
    parent: null,
    get textContent() {
      return fake.text;
    },
    getAttribute: (name) =>
      name === 'data-testid' ? (fake.testId ?? null) : null,
    getBoundingClientRect: () => toDomRect(fake.rect as Rect),
    checkVisibility: () => fake.checkVisible,
    closest: (selector) => {
      for (
        let current: FakeElement | null = fake;
        current;
        current = current.parent
      ) {
        if (
          selector === 'details,summary' &&
          ['DETAILS', 'SUMMARY'].includes(current.nodeName)
        ) {
          return current;
        }
      }
      return null;
    },
  };
  for (const child of children) {
    if (child.nodeType === 1) {
      (child as FakeElement).parent = fake;
    }
  }
  return fake;
}

/**
 * Builds a fake text node.
 *
 * @param rect - The box of the text.
 * @returns The text node.
 */
function textNode(rect: Rect): FakeNode {
  return { nodeType: 3, nextSibling: null, rect };
}

/**
 * Builds a fake document or shadow root over a flat list of elements (in
 * DOM order), answering `[data-testid]` (elements with the attribute) and
 * `*` (all elements).
 *
 * @param elements - All elements of the root, in DOM order.
 * @returns The root.
 */
function root(elements: FakeElement[]): FakeRoot {
  return {
    elements,
    querySelectorAll: (selector) => {
      if (selector === '[data-testid]') {
        return elements.filter(
          (item) => item.testId !== undefined && item.testId !== null,
        );
      }
      if (selector === '*') {
        return elements;
      }
      throw new Error(`Unexpected selector ${selector}`);
    },
  };
}

/**
 * Compiles an in-page function from its source text in a new context.
 *
 * @param fn - The function to compile.
 * @param globals - The context's globals.
 * @returns The compiled function.
 */
function compileInPage<TFn>(
  fn: (...args: never[]) => unknown,
  globals: Record<string, unknown>,
): TFn {
  return vm.runInNewContext(`(${fn.toString()})`, globals) as TFn;
}

/**
 * Runs collectTestIdsInPage against a fake document.
 *
 * @param documentRoot - The fake document.
 * @param limit - Item limit.
 * @param maxTextLength - Text preview length.
 * @returns The collected items.
 */
function collect(
  documentRoot: FakeRoot,
  limit = 150,
  maxTextLength = 100,
): ReturnType<typeof collectTestIdsInPage> {
  const fakeDocument = {
    ...documentRoot,
    createRange: () => {
      let selected: FakeNode | undefined;
      return {
        selectNodeContents: (node: FakeNode) => {
          selected = node;
        },
        getBoundingClientRect: () => toDomRect(selected?.rect as Rect),
      };
    },
  };
  const fakeWindow = {
    getComputedStyle: (target: FakeElement) => ({
      display: target.style.display ?? 'block',
      visibility: target.style.visibility ?? 'visible',
    }),
  };
  const fn = compileInPage<typeof collectTestIdsInPage>(collectTestIdsInPage, {
    document: fakeDocument,
    window: fakeWindow,
  });
  // Round-trip through JSON like returnByValue does.
  return JSON.parse(JSON.stringify(fn(limit, maxTextLength)));
}

describe('collectTestIdsInPage', () => {
  it('returns testId, trimmed text and visibility in DOM order', () => {
    const items = collect(
      root([
        element({ testId: 'a', text: '  Hello\n ' }),
        element({ testId: 'b', text: '' }),
        element({ testId: 'c', text: null }),
      ]),
    );

    expect(items).toStrictEqual([
      { testId: 'a', text: 'Hello', visible: true },
      { testId: 'b', text: '', visible: true },
      { testId: 'c', text: null, visible: true },
    ]);
  });

  it('cuts the text after trimming', () => {
    const items = collect(
      root([element({ testId: 'a', text: `  ${'x'.repeat(20)}` })]),
      150,
      5,
    );

    expect(items[0].text).toBe('xxxxx');
  });

  it('skips empty testIds without counting them towards the limit', () => {
    const items = collect(
      root([
        element({ testId: '' }),
        element({ testId: 'a' }),
        element({ testId: '' }),
        element({ testId: 'b' }),
        element({ testId: 'c' }),
      ]),
      2,
    );

    expect(items.map((item) => item.testId)).toStrictEqual(['a', 'b']);
  });

  it('returns nothing for a limit of 0', () => {
    expect(collect(root([element({ testId: 'a' })]), 0)).toStrictEqual([]);
  });

  it('reports empty boxes as not visible', () => {
    const items = collect(
      root([
        element({
          testId: 'zero-width',
          rect: { x: 0, y: 0, width: 0, height: 5 },
        }),
        element({
          testId: 'zero-height',
          rect: { x: 0, y: 0, width: 5, height: 0 },
        }),
      ]),
    );

    expect(items.map((item) => item.visible)).toStrictEqual([false, false]);
  });

  it('reports visibility hidden and collapse as not visible', () => {
    const items = collect(
      root([
        element({ testId: 'hidden', style: { visibility: 'hidden' } }),
        element({ testId: 'collapse', style: { visibility: 'collapse' } }),
      ]),
    );

    expect(items.map((item) => item.visible)).toStrictEqual([false, false]);
  });

  it('reports elements that fail checkVisibility() as not visible', () => {
    const items = collect(
      root([element({ testId: 'display-none', checkVisible: false })]),
    );

    expect(items[0].visible).toBe(false);
  });

  it('reports off-screen elements with a box as visible', () => {
    const items = collect(
      root([
        element({
          testId: 'off-screen',
          rect: { x: -5000, y: 9000, width: 10, height: 10 },
        }),
      ]),
    );

    expect(items[0].visible).toBe(true);
  });

  it('uses the closed <details> fallback when checkVisibility() is missing', () => {
    const inside = element({ testId: 'inside' });
    const summary = element({ testId: 'summary', nodeName: 'SUMMARY' });
    const details = element({
      testId: 'details',
      nodeName: 'DETAILS',
      children: [summary, inside],
    });
    for (const item of [inside, summary, details]) {
      delete item.checkVisibility;
    }

    const items = collect(root([details, summary, inside]));

    expect(items).toStrictEqual([
      { testId: 'details', text: '', visible: true },
      { testId: 'summary', text: '', visible: true },
      { testId: 'inside', text: '', visible: false },
    ]);

    details.open = true;
    expect(collect(root([inside]))[0].visible).toBe(true);
  });

  describe('display: contents', () => {
    it('is visible when a child element is visible', () => {
      const child = element({ testId: 'child' });
      const contents = element({
        testId: 'contents',
        style: { display: 'contents' },
        rect: { x: 0, y: 0, width: 0, height: 0 },
        children: [element({ checkVisible: false }), child],
      });

      const items = collect(root([contents, child]));

      expect(items[0]).toStrictEqual({
        testId: 'contents',
        text: '',
        visible: true,
      });
    });

    it('is visible when a child text node has a box', () => {
      const contents = element({
        testId: 'contents',
        style: { display: 'contents' },
        children: [
          textNode({ x: 0, y: 0, width: 0, height: 0 }),
          textNode({ x: 0, y: 0, width: 8, height: 12 }),
        ],
      });

      expect(collect(root([contents]))[0].visible).toBe(true);
    });

    it('is not visible without a visible child', () => {
      const contents = element({
        testId: 'contents',
        style: { display: 'contents' },
        children: [
          { nodeType: 8, nextSibling: null },
          textNode({ x: 0, y: 0, width: 0, height: 0 }),
          element({ style: { visibility: 'hidden' } }),
          element({
            style: { display: 'contents' },
            children: [element({ rect: { x: 0, y: 0, width: 0, height: 0 } })],
          }),
        ],
      });

      expect(collect(root([contents]))[0].visible).toBe(false);
    });
  });

  it('reports an element whose style cannot be read as not visible', () => {
    const broken = element({ testId: 'broken' });
    broken.getBoundingClientRect = () => {
      throw new Error('detached');
    };

    expect(collect(root([broken]))).toStrictEqual([
      { testId: 'broken', text: '', visible: false },
    ]);
  });

  it('adds open shadow root matches after the document matches', () => {
    const inner = element({ testId: 'inner' });
    const nestedHost = element({ shadowRoot: root([inner]) });
    const shadowItem = element({ testId: 'shadow' });
    const host = element({
      testId: 'host',
      shadowRoot: root([shadowItem, nestedHost]),
    });
    const after = element({ testId: 'after' });

    const items = collect(root([host, after]));

    expect(items.map((item) => item.testId)).toStrictEqual([
      'host',
      'after',
      'shadow',
      'inner',
    ]);
  });

  it('applies the limit across shadow roots', () => {
    const host = element({
      testId: 'host',
      shadowRoot: root([element({ testId: 's1' }), element({ testId: 's2' })]),
    });
    const second = element({
      shadowRoot: root([element({ testId: 's3' })]),
    });

    expect(
      collect(root([host, second]), 2).map((item) => item.testId),
    ).toStrictEqual(['host', 's1']);
    expect(
      collect(root([host, second]), 3).map((item) => item.testId),
    ).toStrictEqual(['host', 's1', 's2']);
    expect(
      collect(root([host, second]), 1).map((item) => item.testId),
    ).toStrictEqual(['host']);
  });
});

type FakeAnimation = {
  playState: string;
  effect: {
    getComputedTiming: () => { iterations: number; endTime: number };
    target?: unknown;
  } | null;
};

/**
 * Builds a fake animation.
 *
 * @param options - Animation properties.
 * @param options.playState - The play state.
 * @param options.iterations - Computed iterations.
 * @param options.endTime - Computed end time.
 * @param options.target - The effect target (default: a 10x10 element in view).
 * @param options.effect - False for an animation without an effect.
 * @returns The animation.
 */
function animation(
  options: {
    playState?: string;
    iterations?: number;
    endTime?: number;
    target?: unknown;
    effect?: boolean;
  } = {},
): FakeAnimation {
  if (options.effect === false) {
    return { playState: options.playState ?? 'running', effect: null };
  }
  return {
    playState: options.playState ?? 'running',
    effect: {
      getComputedTiming: () => ({
        iterations: options.iterations ?? 1,
        endTime: options.endTime ?? 300,
      }),
      target:
        'target' in options ? options.target : targetElement({ x: 0, y: 0 }),
    },
  };
}

/**
 * Builds a fake animation target element.
 *
 * @param rect - Position and size (size defaults to 10x10).
 * @param rect.x - Left.
 * @param rect.y - Top.
 * @param rect.width - Width.
 * @param rect.height - Height.
 * @returns The target.
 */
function targetElement(rect: {
  x: number;
  y: number;
  width?: number;
  height?: number;
}): { getBoundingClientRect: () => DOMRect } {
  return {
    getBoundingClientRect: () => toDomRect({ width: 10, height: 10, ...rect }),
  };
}

/**
 * Runs animationsSettled against fake animations in a 800x600 viewport.
 *
 * @param animations - The page's animations.
 * @returns The predicate result.
 */
function settled(animations: FakeAnimation[]): boolean {
  const fn = compileInPage<typeof animationsSettled>(animationsSettled, {
    window: { innerWidth: 800, innerHeight: 600 },
    document: { getAnimations: () => animations },
  });
  return fn();
}

describe('animationsSettled', () => {
  it('is settled without animations', () => {
    expect(settled([])).toBe(true);
  });

  it('is not settled with a running finite animation in the viewport', () => {
    expect(settled([animation()])).toBe(false);
  });

  it('ignores animations that are not running', () => {
    expect(
      settled([
        animation({ playState: 'finished' }),
        animation({ playState: 'paused' }),
        animation({ playState: 'idle' }),
      ]),
    ).toBe(true);
  });

  it('ignores infinite animations', () => {
    expect(
      settled([
        animation({ iterations: Infinity, endTime: Infinity }),
        animation({ iterations: 1, endTime: Infinity }),
      ]),
    ).toBe(true);
  });

  it('ignores animations without an effect or an element target', () => {
    expect(
      settled([
        animation({ effect: false }),
        animation({ target: null }),
        animation({ target: { pseudo: true } }),
      ]),
    ).toBe(true);
  });

  it('ignores targets outside the viewport', () => {
    expect(
      settled([
        animation({ target: targetElement({ x: -10, y: 0 }) }),
        animation({ target: targetElement({ x: 0, y: -10 }) }),
        animation({ target: targetElement({ x: 800, y: 0 }) }),
        animation({ target: targetElement({ x: 0, y: 600 }) }),
      ]),
    ).toBe(true);
  });

  it('ignores targets with an empty box', () => {
    expect(
      settled([
        animation({ target: targetElement({ x: 5, y: 5, width: 0 }) }),
        animation({ target: targetElement({ x: 5, y: 5, height: 0 }) }),
      ]),
    ).toBe(true);
  });

  it('counts targets that only partly intersect the viewport', () => {
    expect(
      settled([animation({ target: targetElement({ x: -5, y: 595 }) })]),
    ).toBe(false);
  });

  it('is not settled when one animation still counts', () => {
    expect(settled([animation({ iterations: Infinity }), animation()])).toBe(
      false,
    );
  });
});

describe('waitUntilInPage', () => {
  /**
   * Runs waitUntilInPage with a manual animation-frame queue and timers.
   *
   * @param predicate - The polled predicate.
   * @param frames - Number of frames to run.
   * @param timeoutAfterFrames - Fire the timeout after this many frames.
   * @returns The result and the number of predicate calls.
   */
  async function run(
    predicate: () => boolean,
    frames: number,
    timeoutAfterFrames?: number,
  ): Promise<{ result: boolean; calls: number; cleared: boolean }> {
    const queue: (() => void)[] = [];
    let timeoutCallback: (() => void) | undefined;
    let cleared = false;
    let calls = 0;
    const fn = compileInPage<typeof waitUntilInPage>(waitUntilInPage, {
      Promise,
      document: { hidden: false },
      requestAnimationFrame: (callback: () => void) => queue.push(callback),
      setTimeout: (callback: () => void) => {
        timeoutCallback = callback;
        return 1;
      },
      clearTimeout: () => {
        cleared = true;
      },
    });
    const pending = fn(() => {
      calls += 1;
      return predicate();
    }, 1_000);
    for (let frame = 0; frame < frames; frame++) {
      if (frame === timeoutAfterFrames) {
        timeoutCallback?.();
      }
      queue.shift()?.();
    }
    return { result: await pending, calls, cleared };
  }

  it('first checks in the next frame and resolves true once it passes', async () => {
    let remaining = 2;
    const outcome = await run(() => {
      remaining -= 1;
      return remaining < 0;
    }, 5);

    expect(outcome).toStrictEqual({ result: true, calls: 3, cleared: true });
  });

  it('resolves false on timeout and stops polling', async () => {
    const outcome = await run(() => false, 5, 2);

    expect(outcome).toStrictEqual({ result: false, calls: 2, cleared: false });
  });

  it('treats a throwing predicate as settled', async () => {
    const outcome = await run(() => {
      throw new Error('boom');
    }, 1);

    expect(outcome.result).toBe(true);
  });

  it('checks with a 16 ms setTimeout when the document is hidden', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    let rafCalls = 0;
    let remaining = 1;
    const fn = compileInPage<typeof waitUntilInPage>(waitUntilInPage, {
      Promise,
      document: { hidden: true },
      requestAnimationFrame: () => {
        rafCalls += 1;
      },
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: () => undefined,
    });

    const pending = fn(() => {
      remaining -= 1;
      return remaining < 0;
    }, 1_000);
    // timers[0] is the overall timeout; the first check follows.
    expect(timers.map(({ delay }) => delay)).toStrictEqual([1_000, 16]);
    timers[1].callback();
    expect(timers.map(({ delay }) => delay)).toStrictEqual([1_000, 16, 16]);
    timers[2].callback();

    expect(await pending).toBe(true);
    expect(rafCalls).toBe(0);
    expect(timers).toHaveLength(3);
  });

  it('composes with animationsSettled as source text', async () => {
    const queue: (() => void)[] = [];
    const animations = [animation()];
    const composed = vm.runInNewContext(
      `(function (timeoutMs) {
        return (${waitUntilInPage.toString()})(${animationsSettled.toString()}, timeoutMs);
      })`,
      {
        Promise,
        window: { innerWidth: 800, innerHeight: 600 },
        document: { hidden: false, getAnimations: () => animations },
        requestAnimationFrame: (callback: () => void) => queue.push(callback),
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    ) as (timeoutMs: number) => Promise<boolean>;

    const pending = composed(1_000);
    queue.shift()?.();
    animations[0].playState = 'finished';
    queue.shift()?.();

    expect(await pending).toBe(true);
    expect(queue).toHaveLength(0);
  });
});

describe('in-page function source', () => {
  const inPageFunctions = Object.entries(inPage).filter(
    (entry): entry is [string, (...args: never[]) => unknown] =>
      typeof entry[1] === 'function',
  );

  it('exports the in-page functions', () => {
    expect(inPageFunctions.map(([name]) => name).sort()).toStrictEqual([
      'animationsSettled',
      'collectTestIdsInPage',
      'waitUntilInPage',
    ]);
  });

  // Instrumentation or bundler helpers (coverage counters, `__vite_ssr_*`,
  // `__publicField`...) are undefined in the page. Only `__name` is defined
  // by callInIsolatedWorld.
  it.each(inPageFunctions)(
    '%s references no injected helper other than __name',
    (_name, fn) => {
      const helpers = (fn.toString().match(/\b__\w+/gu) ?? []).filter(
        (identifier) => identifier !== '__name',
      );

      expect(helpers).toStrictEqual([]);
    },
  );
});
