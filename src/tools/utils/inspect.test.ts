import { describe, it, expect, vi, afterEach } from 'vitest';

import * as cdpModule from './cdp.js';
import {
  captureMarkedElementInPage,
  inspectCapturedElementInPage,
} from './in-page.js';
import type { InPageElementInspection } from './in-page.js';
import { inspectLocator, PLAYWRIGHT_MARK_TARGET_EVENT } from './inspect.js';

const INSPECTION: InPageElementInspection = {
  tagName: 'input',
  attributes: { 'data-testid': 'nickname', readonly: '' },
  readOnly: true,
  styles: { color: 'rgb(18, 18, 18)' },
  effectiveOpacity: 1,
};

/**
 * Mocks `callInIsolatedWorld`: the capture call resolves, the inspection
 * call resolves with `inspection`.
 *
 * @param inspection - What the inspection call returns.
 * @returns The spy.
 */
function mockIsolatedWorld(inspection: InPageElementInspection | null) {
  return vi
    .spyOn(cdpModule, 'callInIsolatedWorld')
    .mockImplementation(async (_page, declaration) =>
      declaration === inspectCapturedElementInPage.toString()
        ? inspection
        : undefined,
    );
}

describe('inspectLocator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the element of the isDisabled call, then reads it', async () => {
    const page = {} as any;
    const calls: string[] = [];
    const spy = mockIsolatedWorld(INSPECTION);
    spy.mockImplementation(async (_page, declaration) => {
      if (declaration === captureMarkedElementInPage.toString()) {
        calls.push('capture');
        return undefined;
      }
      calls.push('inspect');
      return INSPECTION;
    });
    const locator = {
      isDisabled: vi.fn(async () => {
        calls.push('isDisabled');
        return false;
      }),
    } as any;

    const result = await inspectLocator(page, locator, ['color'], 5000);

    expect(result).toStrictEqual({ ...INSPECTION, disabled: false });
    expect(calls).toStrictEqual(['capture', 'isDisabled', 'inspect']);
    const [captureCall, inspectCall] = spy.mock.calls;
    expect(captureCall[0]).toBe(page);
    expect(captureCall[2]).toStrictEqual([
      PLAYWRIGHT_MARK_TARGET_EVENT,
      expect.any(String),
    ]);
    expect(inspectCall[2]).toStrictEqual([captureCall[2]?.[1], ['color']]);
    expect(locator.isDisabled).toHaveBeenCalledWith({
      timeout: expect.any(Number),
    });
  });

  it('reports the disabled flag from Playwright', async () => {
    mockIsolatedWorld(INSPECTION);
    const locator = { isDisabled: vi.fn().mockResolvedValue(true) } as any;

    const result = await inspectLocator({} as any, locator, [], 5000);

    expect(result.disabled).toBe(true);
  });

  it('uses a new key for each inspection', async () => {
    const spy = mockIsolatedWorld(INSPECTION);
    const locator = { isDisabled: vi.fn().mockResolvedValue(false) } as any;

    await inspectLocator({} as any, locator, [], 5000);
    await inspectLocator({} as any, locator, [], 5000);

    const keys = spy.mock.calls
      .filter(
        ([, declaration]) =>
          declaration !== inspectCapturedElementInPage.toString(),
      )
      .map(([, , args]) => args?.[1]);
    expect(new Set(keys).size).toBe(2);
  });

  it('throws when Playwright did not report the element', async () => {
    mockIsolatedWorld(null);
    const locator = { isDisabled: vi.fn().mockResolvedValue(false) } as any;

    await expect(
      inspectLocator({} as any, locator, [], 5000),
    ).rejects.toThrowError('Playwright did not report the element');
  });

  it('drops the capture and rethrows when the locator call fails', async () => {
    const spy = mockIsolatedWorld(INSPECTION);
    const error = new Error('Timeout 5000ms exceeded.');
    const locator = { isDisabled: vi.fn().mockRejectedValue(error) } as any;

    await expect(
      inspectLocator({} as any, locator, ['color'], 5000),
    ).rejects.toBe(error);
    const [, inspectCall] = spy.mock.calls;
    expect(inspectCall[1]).toBe(inspectCapturedElementInPage.toString());
    expect(inspectCall[2]).toStrictEqual([spy.mock.calls[0][2]?.[1], []]);
  });

  it('rethrows the locator error when dropping the capture fails too', async () => {
    const spy = mockIsolatedWorld(INSPECTION);
    spy.mockImplementation(async (_page, declaration) => {
      if (declaration === inspectCapturedElementInPage.toString()) {
        throw new Error('session closed');
      }
      return undefined;
    });
    const error = new Error('Element is not attached');
    const locator = { isDisabled: vi.fn().mockRejectedValue(error) } as any;

    await expect(inspectLocator({} as any, locator, [], 5000)).rejects.toBe(
      error,
    );
  });

  it('throws a timeout when the budget is spent before the element is read', async () => {
    mockIsolatedWorld(INSPECTION);
    const locator = { isDisabled: vi.fn().mockResolvedValue(false) } as any;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000);
    nowSpy.mockReturnValueOnce(1000);
    nowSpy.mockReturnValueOnce(1000);
    nowSpy.mockReturnValueOnce(7000);

    await expect(
      inspectLocator({} as any, locator, [], 5000),
    ).rejects.toThrowError('Timeout 5000ms exceeded');
  });
});
