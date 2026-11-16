import type { Page } from '@playwright/test';

import { isPageClosedError } from './error-classification.js';
import type {
  ResetViewportInput,
  ResetViewportResult,
  SetViewportInput,
  SetViewportResult,
  ViewportSize,
} from './types';
import { ErrorCodes } from './types';
import { callInIsolatedWorld } from './utils/cdp.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';
import { extractErrorMessage } from '../utils';

/**
 * The viewport of each page before its first `set_viewport`. Kept per page,
 * so a tab opened later gets the browser context's viewport.
 */
const originalViewports = new WeakMap<Page, ViewportSize>();

/**
 * Returns the page's viewport size. A page without a fixed viewport follows
 * the window, so its size is read from the page.
 *
 * @param page - The Playwright page.
 * @returns The viewport size in CSS pixels.
 */
async function currentViewport(page: Page): Promise<ViewportSize> {
  return (
    page.viewportSize() ??
    (await callInIsolatedWorld<ViewportSize>(
      page,
      '() => ({ width: window.innerWidth, height: window.innerHeight })',
    ))
  );
}

/**
 * Builds the error response of a failed viewport change.
 *
 * @param error - The error thrown by Playwright or CDP.
 * @returns The error response.
 */
function viewportError<TResult>(error: unknown): ToolResponse<TResult> {
  const message = extractErrorMessage(error);
  if (isPageClosedError(error)) {
    return createToolError(ErrorCodes.MM_PAGE_CLOSED, message);
  }
  return createToolError(
    ErrorCodes.MM_VIEWPORT_FAILED,
    `Viewport change failed: ${message}`,
  );
}

/**
 * Sets the viewport of the active page, for example to check a layout at a
 * narrow width. It stays until `reset_viewport`, also across reloads and
 * navigations of that page.
 *
 * @param input - The width and height in CSS pixels.
 * @param context - The tool execution context.
 * @returns The new size and the size before the first change.
 */
export async function setViewportTool(
  input: SetViewportInput,
  context: ToolContext,
): Promise<ToolResponse<SetViewportResult>> {
  const missingSession = requireActiveSession<SetViewportResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { page } = context;
  try {
    const original =
      originalViewports.get(page) ?? (await currentViewport(page));
    originalViewports.set(page, original);
    await page.setViewportSize({ width: input.width, height: input.height });
    return createToolSuccess({
      width: input.width,
      height: input.height,
      original,
    });
  } catch (error) {
    return viewportError<SetViewportResult>(error);
  }
}

/**
 * Restores the viewport the active page had before its first `set_viewport`.
 * Does nothing when `set_viewport` was not used on this page.
 *
 * @param _input - No options.
 * @param context - The tool execution context.
 * @returns Whether a size was restored, and the viewport after the reset.
 */
export async function resetViewportTool(
  _input: ResetViewportInput,
  context: ToolContext,
): Promise<ToolResponse<ResetViewportResult>> {
  const missingSession = requireActiveSession<ResetViewportResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { page } = context;
  const original = originalViewports.get(page);
  if (!original) {
    return createToolSuccess({ reset: false, viewport: page.viewportSize() });
  }

  try {
    await page.setViewportSize(original);
    originalViewports.delete(page);
    return createToolSuccess({ reset: true, viewport: original });
  } catch (error) {
    return viewportError<ResetViewportResult>(error);
  }
}
