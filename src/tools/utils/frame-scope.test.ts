import { describe, expect, it } from 'vitest';

import {
  resolveFrameSelector,
  scopeTargetToFrame,
  selectorInFrame,
} from './frame-scope.js';

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
