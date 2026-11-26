import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  nextFrameRefPrefix,
  resolveFrameSelector,
  resolveWithinScope,
  scopeTargetToFrame,
  selectorInFrame,
  testIdSelector,
} from './frame-scope.js';

/**
 * Builds a page whose first frame target is the given element.
 *
 * @param target - The element's tag and iframe count, or undefined for none.
 * @returns The page.
 */
function framePage(
  target: { tagName: string; iframeCount: number } | undefined,
): Page {
  const element = {
    and: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(target?.tagName === 'IFRAME' ? 1 : 0),
    }),
    locator: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(target?.iframeCount ?? 0),
    }),
  };
  const targetLocator = {
    count: vi.fn().mockResolvedValue(target ? 1 : 0),
    first: vi.fn().mockReturnValue(element),
  };
  return {
    locator: vi.fn().mockReturnValue(targetLocator),
  } as unknown as Page;
}

describe('testIdSelector', () => {
  it('selects the data-testid attribute', () => {
    expect(testIdSelector('chart')).toBe('[data-testid="chart"]');
  });
});

describe('resolveWithinScope', () => {
  it.each([
    [undefined, undefined],
    [{}, undefined],
    [{ a11yRef: 'e3' }, { type: 'a11yRef', value: 'e3' }],
    [{ testId: 'modal' }, { type: 'testId', value: 'modal' }],
    [{ selector: '.modal' }, { type: 'selector', value: '.modal' }],
  ] as const)('resolves %j', (within, scope) => {
    expect(resolveWithinScope(within)).toStrictEqual(scope);
  });
});

describe('nextFrameRefPrefix', () => {
  it('starts above the frame numbers of page snapshots', () => {
    expect(nextFrameRefPrefix(new Map([['e1', 'a']]))).toBe('f6');
    expect(
      nextFrameRefPrefix(
        new Map([
          ['f1e1', 'a'],
          ['f5e2', 'b'],
        ]),
      ),
    ).toBe('f6');
  });

  it('takes the number after the highest frame ref', () => {
    const refMap = new Map([
      ['e12', 'a'],
      ['f2e1', 'b'],
      ['f10e3', 'c'],
      ['f1e1', 'd'],
    ]);

    expect(nextFrameRefPrefix(refMap)).toBe('f11');
  });
});

describe('selectorInFrame', () => {
  it('continues the selector inside the iframe', () => {
    expect(selectorInFrame('iframe.chart', 'role=button')).toBe(
      'iframe.chart >> internal:control=enter-frame >> role=button',
    );
  });
});

describe('resolveFrameSelector', () => {
  const refMap = new Map([['e7', 'css=#host >> css=iframe']]);

  it.each([
    [{ type: 'testId', value: 'chart' }, '[data-testid="chart"]'],
    [{ type: 'selector', value: 'iframe.chart' }, 'iframe.chart'],
    [{ type: 'a11yRef', value: 'e7' }, 'css=#host >> css=iframe'],
  ] as const)('resolves %j', async (frame, selector) => {
    const page = framePage({ tagName: 'IFRAME', iframeCount: 0 });

    expect(await resolveFrameSelector(frame, refMap, page)).toBe(selector);
  });

  it('resolves a wrapper element to its only iframe', async () => {
    const page = framePage({ tagName: 'DIV', iframeCount: 1 });

    expect(
      await resolveFrameSelector(
        { type: 'testId', value: 'advanced-chart-iframe' },
        refMap,
        page,
      ),
    ).toBe('[data-testid="advanced-chart-iframe"] iframe');
  });

  it('throws when the element is not an iframe and holds none', async () => {
    const page = framePage({ tagName: 'DIV', iframeCount: 0 });

    await expect(
      resolveFrameSelector({ type: 'selector', value: '.chart' }, refMap, page),
    ).rejects.toThrowError('Frame not found: .chart is not an iframe');
  });

  it('throws with the count when the element holds several iframes', async () => {
    const page = framePage({ tagName: 'DIV', iframeCount: 2 });

    await expect(
      resolveFrameSelector(
        { type: 'selector', value: '.charts' },
        refMap,
        page,
      ),
    ).rejects.toThrowError(
      'Frame not found: .charts is not an iframe and contains 2 iframes',
    );
  });

  it('leaves a target that matches no element to the caller', async () => {
    const page = framePage(undefined);

    expect(
      await resolveFrameSelector(
        { type: 'testId', value: 'later' },
        refMap,
        page,
      ),
    ).toBe('[data-testid="later"]');
  });

  it('throws for an unknown ref', async () => {
    await expect(
      resolveFrameSelector(
        { type: 'a11yRef', value: 'e9' },
        refMap,
        framePage(undefined),
      ),
    ).rejects.toThrowError('Unknown a11yRef: e9. Available refs: e7');
  });
});

describe('scopeTargetToFrame', () => {
  it('moves a testId target into the frame', () => {
    expect(
      scopeTargetToFrame(
        { targetType: 'testId', targetValue: 'zoom-in' },
        undefined,
        'iframe',
      ),
    ).toStrictEqual({
      target: {
        targetType: 'selector',
        targetValue:
          'iframe >> internal:control=enter-frame >> [data-testid="zoom-in"]',
      },
      within: undefined,
    });
  });

  it('moves the within parent into the frame and keeps the target', () => {
    expect(
      scopeTargetToFrame(
        { targetType: 'testId', targetValue: 'zoom-in' },
        { type: 'selector', value: '.toolbar' },
        'iframe',
      ),
    ).toStrictEqual({
      target: { targetType: 'testId', targetValue: 'zoom-in' },
      within: {
        type: 'selector',
        value: 'iframe >> internal:control=enter-frame >> .toolbar',
      },
    });
  });

  it.each([
    [{ targetType: 'a11yRef', targetValue: 'f1e1' }, undefined],
    [
      { targetType: 'testId', targetValue: 'zoom-in' },
      { type: 'a11yRef', value: 'e2' },
    ],
  ] as const)('rejects refs: %j within %j', (target, within) => {
    expect(() => scopeTargetToFrame(target, within, 'iframe')).toThrowError(
      'frame cannot be used with a ref',
    );
  });
});
