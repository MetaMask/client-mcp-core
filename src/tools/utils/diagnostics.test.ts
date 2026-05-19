import { describe, it, expect, vi, afterEach } from 'vitest';

import { collectInteractionDiagnostics } from './diagnostics.js';

function createMockLocator(
  overrides?: Partial<{
    count: () => Promise<number>;
    first: () => {
      isVisible: () => Promise<boolean>;
      isEnabled: () => Promise<boolean>;
      boundingBox: () => Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>;
    };
  }>,
) {
  const first =
    overrides?.first ??
    (() => ({
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      boundingBox: vi
        .fn()
        .mockResolvedValue({ x: 100, y: 100, width: 80, height: 40 }),
    }));

  return {
    count: overrides?.count ?? vi.fn().mockResolvedValue(1),
    first,
  };
}

function createMockPage(
  overrides?: Partial<{
    isClosed: () => boolean;
    viewportSize: () => { width: number; height: number } | null;
    context: () => { pages: () => unknown[] };
    locator: (selector: string) => unknown;
  }>,
) {
  return {
    isClosed: overrides?.isClosed ?? (() => false),
    viewportSize:
      overrides?.viewportSize ?? (() => ({ width: 800, height: 600 })),
    context: overrides?.context ?? (() => ({ pages: () => [{}] })),
    locator: overrides?.locator ?? vi.fn(() => createMockLocator()),
  };
}

describe('collectInteractionDiagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconstructs locator and collects diagnostics when locator is undefined for testId', async () => {
    const page = createMockPage();
    const result = await collectInteractionDiagnostics(
      page as any,
      undefined,
      'testId',
      'my-button',
      500,
      501,
      'visibility-target',
    );

    expect(result.phase).toBe('visibility-target');
    expect(result.targetType).toBe('testId');
    expect(result.targetValue).toBe('my-button');
    expect(result.timeoutMs).toBe(500);
    expect(result.elapsedMs).toBe(501);
    expect(result.elementFound).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(page.locator).toHaveBeenCalledWith('[data-testid="my-button"]');
  });

  it('returns unknown cause when locator is undefined for a11yRef (cannot reconstruct)', async () => {
    const page = createMockPage();
    const result = await collectInteractionDiagnostics(
      page as any,
      undefined,
      'a11yRef',
      'e5',
      500,
      501,
      'visibility-target',
    );

    expect(result.phase).toBe('visibility-target');
    expect(result.suspectedCause).toBe('unknown');
    expect(result.elementFound).toBeUndefined();
  });

  it('collects all fields for healthy visible enabled element', async () => {
    const page = createMockPage();
    const locator = createMockLocator();
    const result = await collectInteractionDiagnostics(
      page as any,
      locator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    expect(result.elementFound).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(result.elementVisible).toBe(true);
    expect(result.elementEnabled).toBe(true);
    expect(result.boundingBox).toStrictEqual({
      x: 100,
      y: 100,
      width: 80,
      height: 40,
    });
  });

  it('returns element-offscreen when bounding box is outside viewport', async () => {
    const page = createMockPage({
      viewportSize: () => ({ width: 400, height: 600 }),
    });
    const locator = createMockLocator({
      first: () => ({
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(true),
        boundingBox: vi
          .fn()
          .mockResolvedValue({ x: 500, y: 100, width: 80, height: 40 }),
      }),
    });

    const result = await collectInteractionDiagnostics(
      page as any,
      locator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    expect(result.suspectedCause).toBe('element-offscreen');
  });

  it('returns element-not-actionable when element is visible but disabled', async () => {
    const page = createMockPage();
    const locator = createMockLocator({
      first: () => ({
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(false),
        boundingBox: vi
          .fn()
          .mockResolvedValue({ x: 100, y: 100, width: 80, height: 40 }),
      }),
    });

    const result = await collectInteractionDiagnostics(
      page as any,
      locator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    expect(result.suspectedCause).toBe('element-not-actionable');
    expect(result.elementEnabled).toBe(false);
  });

  it('returns page-closed when page is closed', async () => {
    const page = createMockPage({
      isClosed: () => true,
    });
    const locator = createMockLocator();

    const result = await collectInteractionDiagnostics(
      page as any,
      locator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    expect(result.suspectedCause).toBe('page-closed');
  });

  it('returns elementFound: false when locator.count() returns 0', async () => {
    const page = createMockPage();
    const locator = createMockLocator({
      count: vi.fn().mockResolvedValue(0),
    });

    const result = await collectInteractionDiagnostics(
      page as any,
      locator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    expect(result.elementFound).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.elementVisible).toBeUndefined();
    expect(result.suspectedCause).toBe('element-not-found');
  });

  it('reconstructs scoped locator when within is provided for testId', async () => {
    const childLocator = createMockLocator();
    const childLocatorFn = vi.fn(() => childLocator);
    const firstResult = {
      locator: childLocatorFn,
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      boundingBox: vi
        .fn()
        .mockResolvedValue({ x: 100, y: 100, width: 80, height: 40 }),
    };
    const parentLocator = {
      first: vi.fn(() => firstResult),
    };
    const page = createMockPage({
      locator: vi.fn(() => parentLocator as any),
    });

    const result = await collectInteractionDiagnostics(
      page as any,
      undefined,
      'testId',
      'my-button',
      500,
      501,
      'visibility-target',
      { type: 'testId', value: 'parent-row' },
    );

    expect(page.locator).toHaveBeenCalledWith('[data-testid="parent-row"]');
    expect(parentLocator.first).toHaveBeenCalled();
    expect(childLocatorFn).toHaveBeenCalledWith('[data-testid="my-button"]');
    expect(result.elementFound).toBe(true);
    expect(result.matchCount).toBe(1);
  });

  it('falls back to page-level locator when within parent is a11yRef', async () => {
    const page = createMockPage();

    const result = await collectInteractionDiagnostics(
      page as any,
      undefined,
      'testId',
      'my-button',
      500,
      501,
      'visibility-target',
      { type: 'a11yRef', value: 'e5' },
    );

    expect(page.locator).toHaveBeenCalledWith('[data-testid="my-button"]');
    expect(result.elementFound).toBe(true);
  });

  it('resolves per-call when individual Playwright queries are slow', async () => {
    vi.useFakeTimers();

    const page = createMockPage();
    const SLOW_DELAY = 10_000;
    const slowLocator = {
      count: vi
        .fn()
        .mockImplementation(
          async () =>
            new Promise<number>((resolve) =>
              setTimeout(() => resolve(1), SLOW_DELAY),
            ),
        ),
      first: () => ({
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(true),
        boundingBox: vi
          .fn()
          .mockResolvedValue({ x: 0, y: 0, width: 10, height: 10 }),
      }),
    };

    const resultPromise = collectInteractionDiagnostics(
      page as any,
      slowLocator as any,
      'testId',
      'btn',
      500,
      501,
      'action',
    );

    // Per-call cap is 500ms — advance past it so count() times out
    await vi.advanceTimersByTimeAsync(501);

    // Advance past the slow delay so the abandoned count() settles
    await vi.advanceTimersByTimeAsync(SLOW_DELAY);

    const result = await resultPromise;

    expect(result.phase).toBe('action');
    expect(result.elapsedMs).toBe(501);
    expect(result.matchCount).toBeUndefined();
    expect(result.suspectedCause).toBe('unknown');
  });
});
