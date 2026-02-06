/**
 * Playwright mock factories for unit testing.
 *
 * Provides factory functions that return fresh mock Playwright objects:
 * - createMockPage() - Mock Playwright Page with all used methods
 * - createMockLocator() - Mock Playwright Locator with chainable methods
 * - createMockBrowserContext() - Mock BrowserContext
 *
 * Each factory call returns NEW instances with fresh vi.fn() mocks.
 */

import type { Page, Locator, BrowserContext } from '@playwright/test';
import { vi } from 'vitest';

export type MockPageOptions = {
  url?: string;
  locatorMock?: Locator;
};

export type MockLocatorOptions = {
  clickMock?: () => Promise<void>;
  fillMock?: (text: string) => Promise<void>;
  isVisibleMock?: () => Promise<boolean>;
  getAttributeMock?: (name: string) => Promise<string | null>;
  textContentMock?: () => Promise<string | null>;
  allMock?: () => Promise<Locator[]>;
  firstMock?: () => Locator;
  nthMock?: (index: number) => Locator;
};

export type MockBrowserContextOptions = {
  pages?: Page[];
};

/**
 * Create a fresh mock Playwright Locator instance.
 *
 * Includes all methods used in tool handlers:
 * - click() - async mock
 * - fill(text) - async mock
 * - isVisible() - async mock
 * - getAttribute(name) - async mock
 * - textContent() - async mock
 * - all() - async mock
 * - first() - returns mock locator
 * - nth(index) - returns mock locator
 *
 * Methods are chainable where appropriate.
 *
 * @param options - Customize mock behavior
 * @returns Fresh Locator mock
 */
export function createMockLocator(options: MockLocatorOptions = {}): Locator {
  const mockLocator: any = {
    click: vi.fn().mockResolvedValue(options.clickMock?.() ?? undefined),
    fill: vi.fn().mockResolvedValue(options.fillMock?.('') ?? undefined),
    isVisible: vi.fn().mockResolvedValue(options.isVisibleMock?.() ?? true),
    getAttribute: vi
      .fn()
      .mockResolvedValue(options.getAttributeMock?.('') ?? null),
    textContent: vi.fn().mockResolvedValue(options.textContentMock?.() ?? null),
    all: vi.fn().mockResolvedValue(options.allMock?.() ?? []),
    clear: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    blur: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue([]),
    selectText: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    setChecked: vi.fn().mockResolvedValue(undefined),
    dragTo: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateAll: vi.fn().mockResolvedValue([]),
    evaluateHandle: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(1),
    boundingBox: vi.fn().mockResolvedValue(null),
    elementHandle: vi.fn().mockResolvedValue(null),
    elementHandles: vi.fn().mockResolvedValue([]),
    isChecked: vi.fn().mockResolvedValue(false),
    isDisabled: vi.fn().mockResolvedValue(false),
    isEditable: vi.fn().mockResolvedValue(true),
    isEnabled: vi.fn().mockResolvedValue(true),
    innerHTML: vi.fn().mockResolvedValue(''),
    inputValue: vi.fn().mockResolvedValue(''),
    page: vi.fn(),
    first: vi.fn().mockReturnValue(options.firstMock?.() ?? {}),
    nth: vi.fn().mockReturnValue(options.nthMock?.(0) ?? {}),
  };

  return mockLocator as Locator;
}

/**
 * Create a fresh mock Playwright Page instance.
 *
 * Includes all methods used in tool handlers:
 * - locator(selector) - returns mock locator
 * - waitForLoadState() - async mock
 * - url() - returns string
 * - context() - returns mock context
 * - screenshot(options) - async mock
 *
 * @param options - Customize mock behavior
 * @returns Fresh Page mock
 */
export function createMockPage(options: MockPageOptions = {}): Page {
  const mockLocator = options.locatorMock ?? createMockLocator();

  const page: any = {
    locator: vi.fn().mockReturnValue(mockLocator),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(options.url ?? 'about:blank'),
    screenshot: vi.fn().mockResolvedValue({
      buffer: Buffer.from(''),
      path: '/path/to/screenshot.png',
    }),
    goto: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateHandle: vi.fn().mockResolvedValue({}),
    getByTestId: vi.fn().mockReturnValue(mockLocator),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    getByLabel: vi.fn().mockReturnValue(mockLocator),
    getByPlaceholder: vi.fn().mockReturnValue(mockLocator),
    getByText: vi.fn().mockReturnValue(mockLocator),
    getByAltText: vi.fn().mockReturnValue(mockLocator),
    getByTitle: vi.fn().mockReturnValue(mockLocator),
    frameLocator: vi.fn().mockReturnValue(mockLocator),
    waitForFunction: vi.fn().mockResolvedValue(null),
    waitForNavigation: vi.fn().mockResolvedValue(null),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(mockLocator),
    title: vi.fn().mockResolvedValue(''),
    content: vi.fn().mockResolvedValue(''),
    reload: vi.fn().mockResolvedValue(null),
    goBack: vi.fn().mockResolvedValue(null),
    goForward: vi.fn().mockResolvedValue(null),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    emulateMedia: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    exposeBinding: vi.fn().mockResolvedValue(undefined),
    removeExposedBindings: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn().mockResolvedValue(Buffer.from('')),
    accessibility: {
      snapshot: vi.fn().mockResolvedValue(null),
    },
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
      insertText: vi.fn().mockResolvedValue(undefined),
    },
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      dblclick: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    touchscreen: {
      tap: vi.fn().mockResolvedValue(undefined),
    },
    context: vi.fn(),
    page: vi.fn(),
  };

  page.context.mockReturnValue({
    pages: vi.fn().mockReturnValue([]),
    newPage: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  });
  page.page.mockReturnValue(page);

  return page as Page;
}

/**
 * Create a fresh mock Playwright BrowserContext instance.
 *
 * @param options - Customize mock behavior
 * @returns Fresh BrowserContext mock
 */
export function createMockBrowserContext(
  options: MockBrowserContextOptions = {},
): Partial<BrowserContext> {
  const context: any = {
    pages: vi.fn().mockReturnValue(options.pages ?? []),
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    browser: vi.fn().mockReturnValue(null),
    addCookies: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    exposeBinding: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    grantPermissions: vi.fn().mockResolvedValue(undefined),
    revokePermissions: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setGeolocation: vi.fn().mockResolvedValue(undefined),
    setOffline: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue(null),
    tracing: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(Buffer.from('')),
    },
  };

  context.newPage.mockResolvedValue({
    locator: vi.fn().mockReturnValue({}),
    url: vi.fn().mockReturnValue('about:blank'),
    close: vi.fn().mockResolvedValue(undefined),
  });

  return context as Partial<BrowserContext>;
}
