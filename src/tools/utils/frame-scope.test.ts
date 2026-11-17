import { describe, expect, it } from 'vitest';

import {
  nextFrameRefPrefix,
  resolveFrameSelector,
  resolveWithinScope,
  scopeTargetToFrame,
  selectorInFrame,
  testIdSelector,
} from './frame-scope.js';

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
  it('starts at f1 when no frame ref is taken', () => {
    expect(nextFrameRefPrefix(new Map([['e1', 'a']]))).toBe('f1');
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
  ] as const)('resolves %j', (frame, selector) => {
    expect(resolveFrameSelector(frame, refMap)).toBe(selector);
  });

  it('throws for an unknown ref', () => {
    expect(() =>
      resolveFrameSelector({ type: 'a11yRef', value: 'e9' }, refMap),
    ).toThrowError('Unknown a11yRef: e9. Available refs: e7');
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
