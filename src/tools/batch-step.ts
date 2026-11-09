/** Tools whose args include a target selection (a11yRef/testId/selector). */
const TARGET_TOOLS = new Set(['click', 'type', 'wait_for']);

/**
 * Maps CLI-style compound tool names to their registry name + injected args.
 * The CLI handles these conversions for standalone commands, but agents using
 * run-steps bypass CLI parsing and may send compound names directly.
 */
export const TOOL_ALIASES: Record<
  string,
  { tool: string; inject: Record<string, unknown> }
> = {
  navigate_home: { tool: 'navigate', inject: { screen: 'home' } },
  'navigate-home': { tool: 'navigate', inject: { screen: 'home' } },
  navigate_settings: { tool: 'navigate', inject: { screen: 'settings' } },
  'navigate-settings': { tool: 'navigate', inject: { screen: 'settings' } },
  navigate_notification: {
    tool: 'navigate',
    inject: { screen: 'notification' },
  },
  'navigate-notification': {
    tool: 'navigate',
    inject: { screen: 'notification' },
  },
  'scroll-to-element': { tool: 'scroll_to_element', inject: {} },
  'device-swipe': { tool: 'device_swipe', inject: {} },
  'long-press': { tool: 'long_press', inject: {} },
  'tap-coordinates': { tool: 'tap_coordinates', inject: {} },
  'dismiss-keyboard': { tool: 'dismiss_keyboard', inject: {} },
  'dismiss-alert': { tool: 'dismiss_alert', inject: {} },
  'get-alert-text': { tool: 'get_alert_text', inject: {} },
  'open-app': { tool: 'open_app', inject: {} },
  'close-app': { tool: 'close_app', inject: {} },
  'press-button': { tool: 'press_button', inject: {} },
  'device-context': { tool: 'device_context', inject: {} },
  'device-clipboard': { tool: 'device_clipboard', inject: {} },
  'screen-recording': { tool: 'screen_recording', inject: {} },
  'device-logs': { tool: 'device_logs', inject: {} },
  'generate-locators': { tool: 'generate_locators', inject: {} },
};

/**
 * A run_steps step with its tool name and arguments resolved.
 */
export type NormalisedStep = {
  tool: string;
  args: Record<string, unknown>;
};

/**
 * Resolves tool aliases and normalises shorthand arg keys.
 *
 * @param tool - Raw tool name (may be an alias like `navigate_home`).
 * @param args - Raw step arguments.
 * @returns Resolved tool name and normalised arguments.
 */
export function normaliseStep(
  tool: string,
  args: Record<string, unknown>,
): NormalisedStep {
  const alias = TOOL_ALIASES[tool];
  const resolvedTool = alias ? alias.tool : tool;
  let normalised = alias ? { ...alias.inject, ...args } : args;

  if (TARGET_TOOLS.has(resolvedTool)) {
    if ('ref' in normalised && !('a11yRef' in normalised)) {
      const { ref, ...rest } = normalised;
      normalised = { a11yRef: ref, ...rest };
    }

    if (typeof normalised.within === 'object' && normalised.within !== null) {
      const withinObj = normalised.within as Record<string, unknown>;
      if ('ref' in withinObj && !('a11yRef' in withinObj)) {
        const { ref: withinRef, ...withinRest } = withinObj;
        normalised = {
          ...normalised,
          within: { a11yRef: withinRef, ...withinRest },
        };
      }
    }
  }

  return { tool: resolvedTool, args: normalised };
}
