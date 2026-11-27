import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  frameSelectorBase,
  nextFrameRefPrefix,
  resolveFrameElementSelector,
  resolveFrameSelector,
  resolveWithinScope,
  scopeTargetToFrame,
  selectorInFrame,
  testIdSelector,
} from './frame-scope.js';

/**
 * Builds a page for `resolveFrameElementSelector`: the iframe step of
 * `base` resolves after the wait to the given number of iframes.
 *
 * @param base - The frame target selector without the iframe step.
 * @param options - The iframe count, whether the target is an iframe, or
 * the error of the wait.
 * @param options.iframeCount - How many iframes the iframe step matches.
 * @param options.directIframe - Whether the target itself is an iframe.
 * @param options.waitError - The error of the wait, if it fails.
 * @returns The page and the wait mock.
 */
function frameElementPage(
  base: string,
  options: {
    iframeCount?: number;
    directIframe?: boolean;
    waitError?: Error;
  } = {},
): { page: Page; waitFor: ReturnType<typeof vi.fn> } {
  const { iframeCount = 0, directIframe = false, waitError } = options;
  const waitFor = waitError
    ? vi.fn().mockRejectedValue(waitError)
    : vi.fn().mockResolvedValue(undefined);
  const page = {
    locator: vi.fn((selector: string) => {
      if (selector === `${base} >> xpath=descendant-or-self::iframe`) {
        return {
          first: vi.fn().mockReturnValue({ waitFor }),
          count: vi.fn().mockResolvedValue(iframeCount),
        };
      }
      return {
        first: vi.fn().mockReturnValue({
          and: vi.fn().mockReturnValue({
            count: vi.fn().mockResolvedValue(directIframe ? 1 : 0),
          }),
        }),
      };
    }),
  } as unknown as Page;
  return { page, waitFor };
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

describe('frameSelectorBase', () => {
  it('keeps a selector without the iframe step', () => {
    expect(frameSelectorBase('[data-testid="chart"]')).toBe(
      '[data-testid="chart"]',
    );
  });

  it('removes the iframe step of a resolved frame selector', () => {
    expect(
      frameSelectorBase(
        '[data-testid="chart"] >> xpath=descendant-or-self::iframe',
      ),
    ).toBe('[data-testid="chart"]');
  });
});

describe('resolveFrameSelector', () => {
  const refMap = new Map([['e7', 'css=#host >> css=iframe']]);

  it.each([
    [
      { type: 'testId', value: 'chart' },
      '[data-testid="chart"] >> xpath=descendant-or-self::iframe',
    ],
    [
      { type: 'selector', value: 'iframe.chart' },
      'iframe.chart >> xpath=descendant-or-self::iframe',
    ],
    [{ type: 'a11yRef', value: 'e7' }, 'css=#host >> css=iframe'],
  ] as const)('resolves %j', (frame, selector) => {
    expect(resolveFrameSelector(frame, refMap)).toBe(selector);
  });

  it('throws for an unknown ref', () => {
    expect(() =>
      resolveFrameSelector({ type: 'a11yRef', value: 'e9' }, refMap),
    ).toThrowError('Unknown a11yRef: e9. Available refs: e7');
  });
});

describe('resolveFrameElementSelector', () => {
  const CHART = '[data-testid="advanced-chart-iframe"]';
  const refMap = new Map([['e7', 'css=#host >> css=iframe']]);

  it('waits for the only iframe of a wrapper and returns its selector', async () => {
    const { page, waitFor } = frameElementPage(CHART, { iframeCount: 1 });

    expect(
      await resolveFrameElementSelector(
        { type: 'testId', value: 'advanced-chart-iframe' },
        refMap,
        page,
      ),
    ).toBe(`${CHART} iframe`);
    expect(waitFor).toHaveBeenCalledWith({
      state: 'attached',
      timeout: 5000,
    });
  });

  it('keeps an element that is already an iframe', async () => {
    const { page } = frameElementPage('iframe.chart', {
      iframeCount: 1,
      directIframe: true,
    });

    expect(
      await resolveFrameElementSelector(
        { type: 'selector', value: 'iframe.chart' },
        refMap,
        page,
      ),
    ).toBe('iframe.chart');
  });

  it('throws when no iframe matches before the timeout', async () => {
    const timeout = new Error('Timeout 5000ms exceeded');
    timeout.name = 'TimeoutError';
    const { page } = frameElementPage(CHART, { waitError: timeout });

    await expect(
      resolveFrameElementSelector(
        { type: 'testId', value: 'advanced-chart-iframe' },
        refMap,
        page,
      ),
    ).rejects.toThrowError(`Frame not found: no iframe matches ${CHART}`);
  });

  it('throws with the count when the wrapper holds several iframes', async () => {
    const { page } = frameElementPage(CHART, { iframeCount: 2 });

    await expect(
      resolveFrameElementSelector(
        { type: 'testId', value: 'advanced-chart-iframe' },
        refMap,
        page,
      ),
    ).rejects.toThrowError(`Frame not found: ${CHART} resolves to 2 iframes`);
  });

  it('keeps an error other than a timeout, such as a closed page', async () => {
    const { page } = frameElementPage(CHART, {
      waitError: new Error('Target page, context or browser has been closed'),
    });

    await expect(
      resolveFrameElementSelector(
        { type: 'testId', value: 'advanced-chart-iframe' },
        refMap,
        page,
      ),
    ).rejects.toThrowError('Target page, context or browser has been closed');
  });

  it('returns a ref unchanged without reading the page', async () => {
    const page = { locator: vi.fn() } as unknown as Page;

    expect(
      await resolveFrameElementSelector(
        { type: 'a11yRef', value: 'e7' },
        refMap,
        page,
      ),
    ).toBe('css=#host >> css=iframe');
    expect(page.locator).not.toHaveBeenCalled();
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
