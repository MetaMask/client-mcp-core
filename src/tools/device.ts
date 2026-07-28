import type {
  CloseAppInput,
  DeviceClipboardInput,
  DeviceContextInput,
  DeviceLogsInput,
  DeviceSwipeInput,
  DismissAlertInput,
  LongPressInput,
  OpenAppInput,
  PressButtonInput,
  ScreenRecordingInput,
  ScrollToElementInput,
  TapCoordinatesInput,
  TargetSelection,
} from './types';
import { ErrorCodes } from './types/errors.js';
import type {
  CloseAppResult,
  DeviceClipboardResult,
  DeviceContextResult,
  DeviceLogsResult,
  DeviceSwipeResult,
  DismissAlertResult,
  DismissKeyboardResult,
  GenerateLocatorsResult,
  GetAlertTextResult,
  GetWindowSizeResult,
  LongPressResult,
  OpenAppResult,
  PressButtonResult,
  ScreenRecordingResult,
  ScrollToElementResult,
  TapCoordinatesResult,
} from './types/tool-outputs.js';
import { resolveWithinArtifactsDir } from './utils/paths.js';
import { validateTargetSelection } from './utils/targets.js';
import type { TargetType } from './utils/type-guards.js';
import {
  isInvalidTargetSelection,
  isValidTargetSelection,
} from './utils/type-guards.js';
import {
  createToolError,
  createToolSuccess,
  requireActiveSession,
} from './utils.js';
import type { ToolContext, ToolResponse } from '../types/http.js';

type ResolvedTarget = {
  targetType: TargetType;
  targetValue: string;
};

/**
 * Validates the target selection for device tools that target an element
 * (scroll_to_element, long_press). Returns an error response when the
 * selection is missing or ambiguous, otherwise the resolved target.
 *
 * @param input - The tool input carrying a target selection.
 * @returns Either an error response or the resolved target type/value.
 */
function resolveTargetSelection<TResult>(
  input: TargetSelection,
): { error: ToolResponse<TResult> } | ResolvedTarget {
  const validation = validateTargetSelection(input);
  if (isInvalidTargetSelection(validation)) {
    return {
      error: createToolError(ErrorCodes.MM_INVALID_INPUT, validation.error),
    };
  }
  if (!isValidTargetSelection(validation)) {
    return {
      error: createToolError(
        ErrorCodes.MM_INVALID_INPUT,
        'Invalid target selection',
      ),
    };
  }
  return { targetType: validation.type, targetValue: validation.value };
}

/**
 * Returns the screen dimensions of the connected mobile device. Mobile only
 * (iOS/Android) — the browser platform has no device window size concept.
 *
 * @param _input - No input parameters.
 * @param context - The tool execution context with session and driver access.
 * @returns The device width/height, or an error response.
 */
export async function getWindowSizeTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<GetWindowSizeResult>> {
  const missingSession = requireActiveSession<GetWindowSizeResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.getWindowSize) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'get_window_size is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    const size = await driver.getWindowSize();
    return createToolSuccess<GetWindowSizeResult>(size);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Getting window size failed: ${message}`,
    );
  }
}

/**
 * Scrolls the device screen until an element matching the target selection
 * becomes visible. Mobile only (iOS/Android) — the browser platform has no
 * device-level scroll gesture.
 *
 * @param input - The target selection plus optional direction and max attempts.
 * @param context - The tool execution context with session and driver access.
 * @returns The scroll result with the resolved target, or an error response.
 */
export async function scrollToElementTool(
  input: ScrollToElementInput,
  context: ToolContext,
): Promise<ToolResponse<ScrollToElementResult>> {
  const missingSession = requireActiveSession<ScrollToElementResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.scrollToElement) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'scroll_to_element is only available on mobile (iOS/Android) sessions.',
    );
  }

  const resolved = resolveTargetSelection<ScrollToElementResult>(input);
  if ('error' in resolved) {
    return resolved.error;
  }

  try {
    await driver.scrollToElement(
      resolved.targetType,
      resolved.targetValue,
      context.refMap,
      input.direction,
      input.maxAttempts,
    );
    return createToolSuccess<ScrollToElementResult>({
      scrolled: true,
      target: `${resolved.targetType}:${resolved.targetValue}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Scrolling to element failed: ${message}`,
    );
  }
}

/**
 * Performs a swipe gesture on the device screen. Mobile only (iOS/Android) —
 * the browser platform has no device-level swipe gesture.
 *
 * @param input - The swipe direction plus optional start coordinates and distance.
 * @param context - The tool execution context with session and driver access.
 * @returns The swipe result, or an error response.
 */
export async function deviceSwipeTool(
  input: DeviceSwipeInput,
  context: ToolContext,
): Promise<ToolResponse<DeviceSwipeResult>> {
  const missingSession = requireActiveSession<DeviceSwipeResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.swipe) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'device_swipe is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.swipe(
      input.direction,
      input.startX,
      input.startY,
      input.distance,
    );
    return createToolSuccess<DeviceSwipeResult>({ swiped: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Swiping failed: ${message}`,
    );
  }
}

/**
 * Long-presses an element matching the target selection. Mobile only
 * (iOS/Android) — the browser platform has no long-press gesture.
 *
 * @param input - The target selection plus optional press duration.
 * @param context - The tool execution context with session and driver access.
 * @returns The long-press result with the resolved target, or an error response.
 */
export async function longPressTool(
  input: LongPressInput,
  context: ToolContext,
): Promise<ToolResponse<LongPressResult>> {
  const missingSession = requireActiveSession<LongPressResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.longPress) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'long_press is only available on mobile (iOS/Android) sessions.',
    );
  }

  const resolved = resolveTargetSelection<LongPressResult>(input);
  if ('error' in resolved) {
    return resolved.error;
  }

  try {
    await driver.longPress(
      resolved.targetType,
      resolved.targetValue,
      context.refMap,
      input.durationMs,
    );
    return createToolSuccess<LongPressResult>({
      pressed: true,
      target: `${resolved.targetType}:${resolved.targetValue}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Long press failed: ${message}`,
    );
  }
}

/**
 * Taps the device screen at the given absolute coordinates. Mobile only
 * (iOS/Android) — the browser platform has no coordinate tap gesture.
 *
 * @param input - The x and y coordinates to tap.
 * @param context - The tool execution context with session and driver access.
 * @returns The tap result echoing the coordinates, or an error response.
 */
export async function tapCoordinatesTool(
  input: TapCoordinatesInput,
  context: ToolContext,
): Promise<ToolResponse<TapCoordinatesResult>> {
  const missingSession = requireActiveSession<TapCoordinatesResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.tapCoordinates) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'tap_coordinates is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.tapCoordinates(input.x, input.y);
    return createToolSuccess<TapCoordinatesResult>({
      tapped: true,
      x: input.x,
      y: input.y,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Tapping coordinates failed: ${message}`,
    );
  }
}

/**
 * Dismisses the on-screen keyboard. Mobile only (iOS/Android) — the browser
 * platform has no soft keyboard to dismiss.
 *
 * @param _input - No input parameters.
 * @param context - The tool execution context with session and driver access.
 * @returns The dismiss result, or an error response.
 */
export async function dismissKeyboardTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<DismissKeyboardResult>> {
  const missingSession = requireActiveSession<DismissKeyboardResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.dismissKeyboard) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'dismiss_keyboard is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.dismissKeyboard();
    return createToolSuccess<DismissKeyboardResult>({ dismissed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Dismissing keyboard failed: ${message}`,
    );
  }
}

/**
 * Accepts or dismisses a native system alert. Mobile only (iOS/Android) — the
 * browser platform has no native alert surface here.
 *
 * @param input - Whether to accept (true) or dismiss (false) the alert.
 * @param context - The tool execution context with session and driver access.
 * @returns The dismiss result echoing the accepted flag, or an error response.
 */
export async function dismissAlertTool(
  input: DismissAlertInput,
  context: ToolContext,
): Promise<ToolResponse<DismissAlertResult>> {
  const missingSession = requireActiveSession<DismissAlertResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.dismissAlert) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'dismiss_alert is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.dismissAlert(input.accept);
    return createToolSuccess<DismissAlertResult>({
      dismissed: true,
      accepted: input.accept,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Dismissing alert failed: ${message}`,
    );
  }
}

/**
 * Reads the text of the currently displayed native system alert. Mobile only
 * (iOS/Android) — the browser platform has no native alert surface here.
 * Categorized as read-only.
 *
 * @param _input - No input parameters.
 * @param context - The tool execution context with session and driver access.
 * @returns The alert text, or an error response.
 */
export async function getAlertTextTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<GetAlertTextResult>> {
  const missingSession = requireActiveSession<GetAlertTextResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.getAlertText) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'get_alert_text is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    const text = await driver.getAlertText();
    return createToolSuccess<GetAlertTextResult>({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Getting alert text failed: ${message}`,
    );
  }
}

/**
 * Launches (or brings to the foreground) an app by bundle identifier. Mobile
 * only (iOS/Android) — the browser platform has no app launch concept.
 *
 * @param input - The bundle identifier of the app to open.
 * @param context - The tool execution context with session and driver access.
 * @returns The open result echoing the bundle identifier, or an error response.
 */
export async function openAppTool(
  input: OpenAppInput,
  context: ToolContext,
): Promise<ToolResponse<OpenAppResult>> {
  const missingSession = requireActiveSession<OpenAppResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.openApp) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'open_app is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.openApp(input.bundleId);
    return createToolSuccess<OpenAppResult>({
      opened: true,
      bundleId: input.bundleId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Opening app failed: ${message}`,
    );
  }
}

/**
 * Terminates an app by bundle identifier. Mobile only (iOS/Android) — the
 * browser platform has no app termination concept.
 *
 * @param input - The bundle identifier of the app to close.
 * @param context - The tool execution context with session and driver access.
 * @returns The close result echoing the bundle identifier, or an error response.
 */
export async function closeAppTool(
  input: CloseAppInput,
  context: ToolContext,
): Promise<ToolResponse<CloseAppResult>> {
  const missingSession = requireActiveSession<CloseAppResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.closeApp) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'close_app is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.closeApp(input.bundleId);
    return createToolSuccess<CloseAppResult>({
      closed: true,
      bundleId: input.bundleId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Closing app failed: ${message}`,
    );
  }
}

/**
 * Presses a physical or system device button (e.g. home, back, enter). Mobile
 * only (iOS/Android) — the browser platform has no hardware buttons.
 *
 * @param input - The button identifier to press.
 * @param context - The tool execution context with session and driver access.
 * @returns The press result echoing the button, or an error response.
 */
export async function pressButtonTool(
  input: PressButtonInput,
  context: ToolContext,
): Promise<ToolResponse<PressButtonResult>> {
  const missingSession = requireActiveSession<PressButtonResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.pressButton) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'press_button is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    await driver.pressButton(input.button);
    return createToolSuccess<PressButtonResult>({
      pressed: true,
      button: input.button,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Pressing button failed: ${message}`,
    );
  }
}

/**
 * Lists the available device automation contexts or switches to a named one.
 * Mobile only (iOS/Android) — the browser platform has no device contexts.
 *
 * @param input - Either a `list` request or a `switch` request with a context name.
 * @param context - The tool execution context with session and driver access.
 * @returns The context list or switch result, or an error response.
 */
export async function deviceContextTool(
  input: DeviceContextInput,
  context: ToolContext,
): Promise<ToolResponse<DeviceContextResult>> {
  const missingSession = requireActiveSession<DeviceContextResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.getDeviceContexts || !driver?.setDeviceContext) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'device_context is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    if (input.action === 'list') {
      const contexts = await driver.getDeviceContexts();
      return createToolSuccess<DeviceContextResult>({
        action: 'list',
        contexts,
      });
    }
    await driver.setDeviceContext(input.name);
    return createToolSuccess<DeviceContextResult>({
      action: 'switch',
      switched: true,
      name: input.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Device context operation failed: ${message}`,
    );
  }
}

/**
 * Reads from or writes to the device clipboard. Mobile only (iOS/Android) —
 * the browser platform uses the CDP-backed `clipboard` tool instead.
 *
 * @param input - Either a `read` request or a `write` request with text.
 * @param context - The tool execution context with session and driver access.
 * @returns The clipboard read text or write result, or an error response.
 */
export async function deviceClipboardTool(
  input: DeviceClipboardInput,
  context: ToolContext,
): Promise<ToolResponse<DeviceClipboardResult>> {
  const missingSession = requireActiveSession<DeviceClipboardResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.getClipboard || !driver?.setClipboard) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'device_clipboard is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    if (input.action === 'read') {
      const text = await driver.getClipboard();
      return createToolSuccess<DeviceClipboardResult>({
        action: 'read',
        text,
      });
    }
    await driver.setClipboard(input.text);
    return createToolSuccess<DeviceClipboardResult>({
      action: 'write',
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Device clipboard operation failed: ${message}`,
    );
  }
}

/**
 * Starts or stops screen recording on the device. Mobile only (iOS/Android) —
 * the browser platform has no device screen recording. Categorized as
 * read-only since start/stop do not change the app UI.
 *
 * @param input - Either a `start` request (with optional output path) or a `stop` request.
 * @param context - The tool execution context with session and driver access.
 * @returns The recording start flag or the saved file path, or an error response.
 */
export async function screenRecordingTool(
  input: ScreenRecordingInput,
  context: ToolContext,
): Promise<ToolResponse<ScreenRecordingResult>> {
  const missingSession = requireActiveSession<ScreenRecordingResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.startScreenRecording || !driver?.stopScreenRecording) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'screen_recording is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    if (input.action === 'start') {
      let { outputPath } = input;
      if (outputPath !== undefined) {
        const resolved = resolveWithinArtifactsDir(
          outputPath,
          context.workflowContext.config?.artifactsDir,
        );
        if (!resolved.ok) {
          return createToolError(ErrorCodes.MM_INVALID_INPUT, resolved.reason);
        }
        outputPath = resolved.resolvedPath;
      }
      await driver.startScreenRecording(outputPath);
      return createToolSuccess<ScreenRecordingResult>({
        action: 'start',
        recording: true,
      });
    }
    const path = await driver.stopScreenRecording();
    return createToolSuccess<ScreenRecordingResult>({
      action: 'stop',
      path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Screen recording operation failed: ${message}`,
    );
  }
}

/**
 * Retrieves recent device logs, optionally scoped by duration and filter.
 * Mobile only (iOS/Android) — the browser platform has no device log stream.
 * Categorized as read-only.
 *
 * @param input - Optional duration (seconds) and filter substring.
 * @param context - The tool execution context with session and driver access.
 * @returns The log entries and their source, or an error response.
 */
export async function deviceLogsTool(
  input: DeviceLogsInput,
  context: ToolContext,
): Promise<ToolResponse<DeviceLogsResult>> {
  const missingSession = requireActiveSession<DeviceLogsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.getLogs) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'device_logs is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    const logs = await driver.getLogs(input.durationSeconds, input.filter);
    return createToolSuccess<DeviceLogsResult>(logs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Getting device logs failed: ${message}`,
    );
  }
}

/**
 * Generates ranked locator suggestions for all interactive elements on the
 * current screen. Each element gets a prioritized list of selector strategies
 * (identifier > label > text > type) with confidence levels. Useful for
 * discovering stable selectors when authoring mobile automation. Mobile only
 * (iOS/Android) — the browser platform has no device snapshot hierarchy.
 *
 * @param _input - No input parameters.
 * @param context - The tool execution context with session and driver access.
 * @returns The ranked element locators, or an error response.
 */
export async function generateLocatorsTool(
  _input: Record<string, never>,
  context: ToolContext,
): Promise<ToolResponse<GenerateLocatorsResult>> {
  const missingSession = requireActiveSession<GenerateLocatorsResult>(context);
  if (missingSession) {
    return missingSession;
  }

  const { driver } = context;
  if (!driver?.generateLocators) {
    return createToolError(
      ErrorCodes.MM_DEVICE_NOT_AVAILABLE,
      'generate_locators is only available on mobile (iOS/Android) sessions.',
    );
  }

  try {
    const locators = await driver.generateLocators();
    return createToolSuccess<GenerateLocatorsResult>({ locators });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createToolError(
      ErrorCodes.MM_DEVICE_ACTION_FAILED,
      `Generating locators failed: ${message}`,
    );
  }
}
