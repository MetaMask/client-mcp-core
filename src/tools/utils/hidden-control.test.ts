import { describe, it, expect, vi } from 'vitest';

import {
  findLabelForHiddenControl,
  toXPathStringLiteral,
} from './hidden-control.js';

const CHECKABLE = 'xpath=self::input[@type="checkbox" or @type="radio"]';
const WRAPPING_LABEL = 'xpath=ancestor::label[1]';
const INTERACTIVE_DESCENDANT =
  'xpath=.//*[self::a[@href] or self::button or self::select or self::textarea or @role="link" or @role="button"]';

type FakeLocator = {
  boundingBox: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
};

/**
 * Builds a fake locator whose child locators are looked up by selector.
 *
 * @param options The fake's behaviour.
 * @param options.box The bounding box to report.
 * @param options.count The number of matched elements.
 * @param options.id The `id` attribute to report.
 * @param options.children The child locators by selector.
 * @returns The fake locator.
 */
function fakeLocator(
  options: {
    box?: { x: number; y: number; width: number; height: number } | null;
    count?: number;
    id?: string | null;
    children?: Record<string, FakeLocator>;
  } = {},
): FakeLocator {
  const children = options.children ?? {};
  return {
    boundingBox: vi.fn().mockResolvedValue(options.box ?? null),
    count: vi.fn().mockResolvedValue(options.count ?? 0),
    getAttribute: vi.fn().mockResolvedValue(options.id ?? null),
    locator: vi.fn(
      (selector: string) => children[selector] ?? fakeLocator({ count: 0 }),
    ),
  };
}

const HIDDEN_BOX = { x: 10, y: 10, width: 1, height: 1 };

describe('toXPathStringLiteral', () => {
  it('uses double quotes by default', () => {
    expect(toXPathStringLiteral('toggle-1')).toBe('"toggle-1"');
  });

  it('uses single quotes for a value with double quotes', () => {
    expect(toXPathStringLiteral('a"b')).toBe(`'a"b'`);
  });

  it('uses concat for a value with both quote kinds', () => {
    expect(toXPathStringLiteral(`a"b'c`)).toBe(`concat("a", '"', "b'c")`);
  });
});

describe('findLabelForHiddenControl', () => {
  it('ignores a target larger than 1x1', async () => {
    const target = fakeLocator({
      box: { x: 0, y: 0, width: 40, height: 20 },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
    expect(target.boundingBox).toHaveBeenCalledWith({ timeout: 5000 });
    expect(target.locator).not.toHaveBeenCalled();
  });

  it('ignores a target without a bounding box', async () => {
    const target = fakeLocator({ box: null });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
    expect(target.locator).not.toHaveBeenCalled();
  });

  it('treats a target that is thin on one side as hidden', async () => {
    const label = fakeLocator({ count: 1 });
    const control = fakeLocator({
      count: 1,
      children: { [WRAPPING_LABEL]: label },
    });
    const target = fakeLocator({
      box: { x: 0, y: 0, width: 40, height: 1 },
      children: { [CHECKABLE]: control },
    });

    expect(await findLabelForHiddenControl(target as any, 5000)).toBe(label);
  });

  it('ignores a hidden element that is not a checkbox or radio', async () => {
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: fakeLocator({ count: 0 }) },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
  });

  it('returns the wrapping label of a hidden checkbox', async () => {
    const label = fakeLocator({ count: 1 });
    const control = fakeLocator({
      count: 1,
      children: { [WRAPPING_LABEL]: label },
    });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(await findLabelForHiddenControl(target as any, 5000)).toBe(label);
    expect(control.getAttribute).not.toHaveBeenCalled();
  });

  it('returns the label pointing at the hidden checkbox by id', async () => {
    const label = fakeLocator({ count: 1 });
    const control = fakeLocator({
      count: 1,
      id: 'agree',
      children: {
        'xpath=ancestor::*[last()]//label[@for="agree"]': label,
      },
    });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(await findLabelForHiddenControl(target as any, 3000)).toBe(label);
    expect(control.getAttribute).toHaveBeenCalledWith('id', { timeout: 3000 });
  });

  it('returns undefined for a hidden checkbox without a label or id', async () => {
    const control = fakeLocator({ count: 1, id: null });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
  });

  it('returns undefined when the wrapping label has a link inside', async () => {
    const label = fakeLocator({
      count: 1,
      children: { [INTERACTIVE_DESCENDANT]: fakeLocator({ count: 1 }) },
    });
    const control = fakeLocator({
      count: 1,
      id: 'agree',
      children: {
        [WRAPPING_LABEL]: label,
        'xpath=ancestor::*[last()]//label[@for="agree"]': fakeLocator({
          count: 1,
        }),
      },
    });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
    expect(label.locator).toHaveBeenCalledWith(INTERACTIVE_DESCENDANT);
    expect(control.getAttribute).not.toHaveBeenCalled();
  });

  it('returns undefined when the label for the id has a button inside', async () => {
    const label = fakeLocator({
      count: 1,
      children: { [INTERACTIVE_DESCENDANT]: fakeLocator({ count: 2 }) },
    });
    const control = fakeLocator({
      count: 1,
      id: 'agree',
      children: {
        'xpath=ancestor::*[last()]//label[@for="agree"]': label,
      },
    });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
    expect(label.locator).toHaveBeenCalledWith(INTERACTIVE_DESCENDANT);
  });

  it('returns undefined when several labels point at the id', async () => {
    const control = fakeLocator({
      count: 1,
      id: 'agree',
      children: {
        'xpath=ancestor::*[last()]//label[@for="agree"]': fakeLocator({
          count: 2,
        }),
      },
    });
    const target = fakeLocator({
      box: HIDDEN_BOX,
      children: { [CHECKABLE]: control },
    });

    expect(
      await findLabelForHiddenControl(target as any, 5000),
    ).toBeUndefined();
  });
});
