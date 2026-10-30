import { z } from 'zod';

import { OBSERVE_LEVELS } from './observe-level.js';
import { SMART_CONTRACT_NAMES, HARDFORKS } from '../tools/types/seeding.js';

export const observeLevelSchema = z
  .enum(OBSERVE_LEVELS)
  .describe(
    'Observation to return after the call: ' +
      'none = skip it (fastest), ' +
      'diff = only what changed since the previous observation, ' +
      'full = the whole screen. ' +
      'Default: diff for mutating tools and run_steps, none for the others.',
  );

export type ObserveLevel = z.infer<typeof observeLevelSchema>;

const observeFieldSchema = z.object({
  observe: observeLevelSchema.optional(),
});

/**
 * Adds the optional `observe` field to a tool input schema. Uses an
 * intersection so it works for every schema shape (objects, refined objects,
 * unions and discriminated unions).
 *
 * @param schema - The tool input schema.
 * @returns The schema with an optional `observe` field.
 */
export function withObserve<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodIntersection<Schema, typeof observeFieldSchema> {
  return schema.and(observeFieldSchema);
}

/**
 * Removes the `observe` field from validated tool input. `observe` is read by
 * the daemon, so tool handlers get their input without it.
 *
 * @param input - Validated tool input.
 * @returns The input without `observe` (non-objects are returned unchanged).
 */
export function omitObserve<Input>(input: Input): Input {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !('observe' in input)
  ) {
    return input;
  }
  const { observe: _observe, ...rest } = input as Record<string, unknown>;
  return rest as Input;
}

export const a11yRefPattern = z
  .string()
  .regex(/^e[0-9]+$/u)
  .describe(
    'Accessibility ref from accessibility_snapshot (e.g., e1, e2). ' +
      'These refs are ephemeral and only valid within the current screen state.',
  );

export const targetSelectionSchema = z
  .object({
    a11yRef: a11yRefPattern.optional(),
    testId: z
      .string()
      .min(1)
      .describe(
        'data-testid attribute value (stable, preferred for interactions)',
      )
      .optional(),
    selector: z
      .string()
      .min(1)
      .describe('CSS selector (fallback, less stable than testId)')
      .optional(),
  })
  .refine(
    (data) => {
      const provided = [data.a11yRef, data.testId, data.selector].filter(
        Boolean,
      );
      return provided.length === 1;
    },
    {
      message: 'Exactly one of a11yRef, testId, or selector must be provided',
    },
  );

const smartContractNames = SMART_CONTRACT_NAMES;
const hardforks = HARDFORKS;

const networkMockResponseSchema = z
  .object({
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .default(200)
      .describe('HTTP status code for the mocked response'),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .describe('Additional response headers')
      .optional(),
    json: z.unknown().describe('JSON response body').optional(),
    body: z.string().describe('Text response body').optional(),
  })
  .refine(
    (data) =>
      (data.json !== undefined || data.body !== undefined) &&
      !(data.json !== undefined && data.body !== undefined),
    {
      message: 'Exactly one of response.json or response.body must be provided',
    },
  );

export const networkMockRouteRuleSchema = z.object({
  id: z.string().min(1).describe('Stable identifier for this mock route'),
  method: z
    .string()
    .min(1)
    .transform((method) => method.toUpperCase())
    .describe('HTTP method to match'),
  url: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'url must be an absolute http(s) URL or URL glob' },
    )
    .describe('Absolute URL or URL glob to match'),
  response: networkMockResponseSchema,
});

export const networkMockConfigSchema = z.object({
  routes: z.array(networkMockRouteRuleSchema).default([]),
});

export const buildInputSchema = z.object({
  buildType: z
    .enum(['build:test'])
    .default('build:test')
    .describe('Build command to run. Currently only build:test is supported.'),
  force: z
    .boolean()
    .default(false)
    .describe('Force rebuild even if a build already exists'),
});

export const launchInputSchema = z
  .object({
    autoBuild: z
      .boolean()
      .default(true)
      .describe('Automatically run build if extension is not found'),
    context: z
      .enum(['e2e', 'prod'])
      .describe(
        'Environment context to use for this session. ' +
          'Sets the context before launching so you can start in prod mode directly: ' +
          'mm launch --context prod --state onboarding',
      )
      .optional(),
    stateMode: z
      .enum(['default', 'onboarding', 'custom'])
      .default('default')
      .describe(
        'Wallet state mode: ' +
          'default = pre-onboarded wallet with 25 ETH, ' +
          'onboarding = fresh wallet requiring setup, ' +
          'custom = use provided fixture',
      ),
    fixturePreset: z
      .string()
      .min(1)
      .describe(
        'Name of preset fixture (e.g., withMultipleAccounts, withERC20Tokens). ' +
          'Only used when stateMode=custom.',
      )
      .optional(),
    fixture: z
      .record(z.string(), z.unknown())
      .describe('Direct fixture object for stateMode=custom')
      .optional(),
    ports: z
      .object({
        anvil: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe('Port for Anvil local chain (default: 8545)')
          .optional(),
        fixtureServer: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe('Port for fixture server (default: 12345)')
          .optional(),
      })
      .optional(),
    slowMo: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(0)
      .describe(
        'Slow down Playwright actions by N milliseconds (for debugging)',
      ),
    extensionPath: z
      .string()
      .describe('Custom path to built extension directory')
      .optional(),
    tags: z
      .array(z.string())
      .describe('Free-form tags for ad-hoc filtering')
      .optional(),
    seedContracts: z
      .array(z.enum(smartContractNames))
      .describe('Smart contracts to deploy on launch (before extension loads)')
      .optional(),
    force: z
      .boolean()
      .default(false)
      .describe(
        'Force replace an existing active session (runs cleanup first)',
      ),
    platform: z
      .enum(['browser', 'ios', 'android'])
      .default('browser')
      .describe(
        'Target platform: browser (default), ios, or android. ' +
          'Mobile platforms require @metamask/device-mcp.',
      ),
    deviceId: z
      .string()
      .min(1)
      .describe(
        'Explicit device ID for mobile platforms (iOS UDID or Android serial). ' +
          'When omitted, auto-detects if exactly one device is connected.',
      )
      .optional(),
    appBundlePath: z
      .string()
      .min(1)
      .describe(
        'Mobile only: path to the app artifact to install before launching ' +
          '(iOS `.app` bundle or Android `.apk`). When omitted, the consumer ' +
          'decides how to resolve the app (typically reusing the installed one).',
      )
      .optional(),
    metroPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe(
        'Mobile only: Metro bundler / inspector proxy port for watch-mode ' +
          'attach and Hermes CDP (development builds only).',
      )
      .optional(),
    reinstall: z
      .boolean()
      .default(false)
      .describe(
        'Mobile only: uninstall and reinstall the app before launching. ' +
          'DESTRUCTIVE — discards the existing app container.',
      ),
    resetAppData: z
      .boolean()
      .default(false)
      .describe(
        'Mobile only: clear app data/container before launching. ' +
          'DESTRUCTIVE — discards existing wallet state.',
      ),
    allowFoxCodeMismatch: z
      .boolean()
      .default(false)
      .describe(
        'Mobile only: bypass the consumer app-identity (fox_code) compatibility ' +
          'guard. DANGEROUS — may render existing wallet/keychain data unreadable.',
      ),
    selfOnboarding: z
      .boolean()
      .optional()
      .describe(
        'Complete onboarding in-process. The secret recovery phrase is read from stdin, not from a flag.',
      ),
    srp: z
      .string()
      .optional()
      .describe(
        'Secret recovery phrase carried on the launch body for self-onboarding. Never log this value.',
      ),
    password: z
      .string()
      .min(8, 'self-onboarding password must be at least 8 characters')
      .optional()
      .describe(
        'Vault password for self-onboarding, read from stdin after the phrase. Never log this value.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.selfOnboarding !== true) {
      if (value.password !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'password is only accepted with self-onboarding',
          path: ['password'],
        });
      }
      return;
    }
    const words = (value.srp ?? '')
      .trim()
      .split(/\s+/u)
      .filter((word) => word.length > 0);
    if (words.length !== 12 && words.length !== 24) {
      ctx.addIssue({
        code: 'custom',
        message:
          'self-onboarding requires a 12 or 24 word secret recovery phrase',
        path: ['srp'],
      });
    }
  });

export const cleanupInputSchema = z.object({
  sessionId: z
    .string()
    .describe('Session ID to clean up (optional, defaults to current)')
    .optional(),
});

export const getStateInputSchema = z.object({});

export const navigateInputSchema = z
  .object({
    screen: z
      .enum(['home', 'settings', 'notification', 'url'])
      .describe(
        'Target screen: home, settings, notification (popup), or url (custom)',
      ),
    url: z
      .string()
      .min(1)
      .describe('URL to navigate to (required when screen="url")')
      .optional(),
  })
  .refine(
    (data) => {
      if (data.screen === 'url' && !data.url) {
        return false;
      }
      return true;
    },
    {
      message: 'url is required when screen is "url"',
      path: ['url'],
    },
  );

export const waitForNotificationInputSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(15000)
    .describe('Timeout in milliseconds to wait for notification popup'),
});

export const listTestIdsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(150)
    .describe('Maximum number of testIds to return'),
});

export const accessibilitySnapshotInputSchema = z.object({
  rootSelector: z
    .string()
    .min(1)
    .describe('CSS selector to scope the snapshot (optional)')
    .optional(),
});

export const describeScreenInputSchema = z.object({
  includeScreenshot: z
    .boolean()
    .default(false)
    .describe('Capture and include a screenshot (opt-in for privacy)'),
  screenshotName: z
    .string()
    .min(1)
    .describe('Name for the screenshot file (without extension)')
    .optional(),
  includeScreenshotBase64: z
    .boolean()
    .default(false)
    .describe('Include base64-encoded screenshot in response'),
});

export const screenshotInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Screenshot filename (without extension)')
    .optional(),
  fullPage: z
    .boolean()
    .default(true)
    .describe('Capture full page or just viewport'),
  selector: z
    .string()
    .min(1)
    .describe('CSS selector to capture specific element')
    .optional(),
  includeBase64: z
    .boolean()
    .default(false)
    .describe('Include base64-encoded image in response'),
});

export const withinTargetSchema = z
  .object({
    a11yRef: a11yRefPattern.optional(),
    testId: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
  })
  .refine(
    (data) => {
      const provided = [data.a11yRef, data.testId, data.selector].filter(
        Boolean,
      );
      return provided.length === 1;
    },
    {
      message:
        'Exactly one of a11yRef, testId, or selector must be provided in within',
    },
  )
  .describe(
    'Scope the target search within a parent element. ' +
      'Accepts the same targeting options (a11yRef, testId, or selector).',
  );

export const clickInputSchema = targetSelectionSchema.and(
  z.object({
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .default(15000)
      .describe('Timeout to wait for element to become visible'),
    within: withinTargetSchema.optional(),
    dismissKeyboard: z
      .boolean()
      .optional()
      .describe(
        'Mobile: when the software keyboard covers the target ' +
          '(MM_TARGET_OBSCURED), dismiss it and tap once more',
      ),
  }),
);

export const typeInputSchema = targetSelectionSchema.and(
  z.object({
    text: z.string().describe('Text to type into the element'),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .default(15000)
      .describe('Timeout to wait for element to become visible'),
    within: withinTargetSchema.optional(),
  }),
);

export const waitForInputSchema = targetSelectionSchema.and(
  z.object({
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(120000)
      .default(15000)
      .describe('Timeout to wait for element'),
    within: withinTargetSchema.optional(),
  }),
);

export const getTextInputSchema = targetSelectionSchema.and(
  z.object({
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .default(15000)
      .describe('Timeout to wait for element to become visible'),
    within: withinTargetSchema.optional(),
  }),
);

export const seedContractInputSchema = z.object({
  contractName: z.enum(smartContractNames),
  hardfork: z.enum(hardforks).optional(),
  deployerOptions: z
    .object({
      fromAddress: z.string().optional(),
      fromPrivateKey: z.string().optional(),
    })
    .optional(),
});

export const seedContractsInputSchema = z.object({
  contracts: z.array(z.enum(smartContractNames)).min(1).max(9),
  hardfork: z.enum(hardforks).optional(),
});

export const getContractAddressInputSchema = z.object({
  contractName: z.enum(smartContractNames),
});

export const listDeployedContractsInputSchema = z.object({});

const tabRoles = ['extension', 'notification', 'dapp', 'other'] as const;
const closableTabRoles = ['notification', 'dapp', 'other'] as const;

export const switchToTabInputSchema = z
  .object({
    role: z
      .enum(tabRoles)
      .describe('Tab role to switch to (extension, notification, dapp, other)')
      .optional(),
    url: z
      .string()
      .min(1)
      .describe('URL prefix to match for tab switching')
      .optional(),
  })
  .refine((data) => data.role ?? data.url, {
    message: 'Either role or url must be provided',
  });

export const closeTabInputSchema = z
  .object({
    role: z
      .enum(closableTabRoles)
      .describe(
        'Tab role to close (notification, dapp, other). Cannot close extension.',
      )
      .optional(),
    url: z
      .string()
      .min(1)
      .describe('URL prefix to match for tab closing')
      .optional(),
  })
  .refine((data) => data.role ?? data.url, {
    message: 'Either role or url must be provided',
  });

export const runStepsInputSchema = z.object({
  steps: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(50)
    .describe('Array of tool calls to execute in order'),
  stopOnError: z
    .boolean()
    .default(false)
    .describe('Stop execution on first error (default: false - continue)'),
  batchTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .describe(
      'Overall timeout for the batch in milliseconds. ' +
        'When exceeded, remaining steps are marked as skipped and partial results are returned. ' +
        'The deadline is checked between steps. Capped at 30 000, the default request limit of ' +
        'the queue and the CLI; to get partial results, leave room for the step in progress ' +
        'and the observation (e.g. 20 000).',
    )
    .optional(),
  // Removed in favour of `observe`. Rejected (not ignored) so old callers
  // learn about it instead of silently getting an observation.
  includeObservations: z
    .never({ error: 'includeObservations was removed; use observe' })
    .optional(),
});

export const setContextInputSchema = z.object({
  context: z.enum(['e2e', 'prod']).describe('Target context to switch to'),
  options: z
    .record(z.string(), z.unknown())
    .describe('Optional context-specific options forwarded to session manager')
    .optional(),
});

export const getContextInputSchema = z
  .object({})
  .describe('No parameters required');

export const clipboardInputSchema = z
  .object({
    action: z
      .enum(['write', 'read'])
      .describe(
        'Action to perform: write text to clipboard or read from clipboard',
      ),
    text: z
      .string()
      .describe("Text to write to clipboard (required when action is 'write')")
      .optional(),
  })
  .refine(
    (data) => {
      if (data.action === 'write' && !data.text) {
        return false;
      }
      return true;
    },
    {
      message: "text is required when action is 'write'",
      path: ['text'],
    },
  );

const mockNetworkAddInputSchema = z
  .object({
    action: z.literal('add'),
    rule: networkMockRouteRuleSchema.optional(),
    routes: z.array(networkMockRouteRuleSchema).min(1).optional(),
  })
  .refine((data) => Boolean(data.rule) !== Boolean(data.routes), {
    message: 'Exactly one of rule or routes must be provided for add',
  });

export const mockNetworkInputSchema = z.union([
  mockNetworkAddInputSchema,
  z.object({ action: z.literal('clear') }),
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('requests'),
    limit: z.number().int().min(1).max(500).optional(),
  }),
]);

export const cdpInputSchema = z.object({
  method: z
    .string()
    .min(1)
    .describe(
      'CDP method name. Browser: full Chrome surface (e.g., "Runtime.evaluate", ' +
        '"DOM.getDocument", "Network.enable"). Mobile (Hermes): JS-engine subset ' +
        'only (e.g., "Runtime.evaluate", "Debugger.enable") — no DOM/Page/Network.',
    ),
  params: z
    .record(z.string(), z.unknown())
    .describe('CDP method parameters (method-specific)')
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .default(30_000)
    .describe(
      'Per-command timeout in milliseconds. ' +
        'Capped at 30 000 to stay within the server request-queue ceiling.',
    ),
  metroPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe(
      'Mobile only: override the Metro inspector proxy port. Ignored on browser.',
    )
    .optional(),
  appId: z
    .string()
    .min(1)
    .describe(
      'Mobile only: override the expected app bundle identifier. Ignored on browser.',
    )
    .optional(),
  target: z
    .enum(['hermes', 'android-webview'])
    .default('hermes')
    .describe(
      'Mobile only: CDP target. "hermes" (default) drives the React Native ' +
        'JS runtime via Metro; "android-webview" drives a debuggable in-app ' +
        'Android WebView via adb (DOM/Page/Network available). Ignored on browser.',
    ),
  urlFilter: z
    .string()
    .min(1)
    .describe(
      'android-webview only: select the WebView page whose URL contains this ' +
        'substring when multiple pages are open.',
    )
    .optional(),
});

export const hermesTargetsInputSchema = z.object({
  metroPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('Override the Metro inspector proxy port for this call')
    .optional(),
  appId: z
    .string()
    .min(1)
    .describe('Override the expected app bundle identifier for this call')
    .optional(),
  all: z
    .boolean()
    .default(false)
    .describe('Bypass the appId filter and list ALL candidates (diagnostics)'),
});

export const getWindowSizeInputSchema = z.object({});

export const scrollToElementInputSchema = targetSelectionSchema.and(
  z.object({
    direction: z
      .enum(['auto', 'up', 'down'])
      .describe(
        'Content direction to search: "down" reveals content below (finger ' +
          'swipes up), "up" reveals content above. Default "auto": from the ' +
          "element's position, searching below first when it is not in the " +
          'UI tree yet.',
      )
      .optional(),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe('Maximum number of swipes before giving up (default 10)')
      .optional(),
  }),
);

export const deviceSwipeInputSchema = z.object({
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .describe('Finger swipe direction (swipe up scrolls content down)'),
  startX: z
    .number()
    .int()
    .min(0)
    .describe('Start X coordinate for the swipe gesture, in logical points')
    .optional(),
  startY: z
    .number()
    .int()
    .min(0)
    .describe('Start Y coordinate for the swipe gesture, in logical points')
    .optional(),
  distance: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .describe('Swipe distance in logical points')
    .optional(),
});

export const longPressInputSchema = targetSelectionSchema.and(
  z.object({
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(60000)
      .describe('Press duration in milliseconds')
      .optional(),
  }),
);

export const tapCoordinatesInputSchema = z.object({
  x: z.number().min(0).describe('X coordinate to tap'),
  y: z.number().min(0).describe('Y coordinate to tap'),
});

export const dismissKeyboardInputSchema = z.object({});

export const dismissAlertInputSchema = z.object({
  accept: z
    .boolean()
    .describe('Accept (true) or dismiss (false) the native alert'),
});

export const getAlertTextInputSchema = z.object({});

export const openAppInputSchema = z.object({
  bundleId: z
    .string()
    .min(1)
    .describe('Bundle identifier of the app to launch'),
});

export const closeAppInputSchema = z.object({
  bundleId: z
    .string()
    .min(1)
    .describe('Bundle identifier of the app to terminate'),
});

export const pressButtonInputSchema = z.object({
  button: z
    .enum(['home', 'back', 'enter', 'lock'])
    .describe('Device button to press'),
});

export const deviceContextInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
  }),
  z.object({
    action: z.literal('switch'),
    name: z
      .string()
      .min(1)
      .describe('Name of the device automation context to switch to'),
  }),
]);

export const deviceClipboardInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
  }),
  z.object({
    action: z.literal('write'),
    text: z.string().describe('Text to write to the device clipboard'),
  }),
]);

export const screenRecordingInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    outputPath: z
      .string()
      .min(1)
      .describe('File path to save the recording to')
      .optional(),
  }),
  z.object({
    action: z.literal('stop'),
  }),
]);

export const deviceLogsInputSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .describe('How many seconds of logs to retrieve')
    .optional(),
  filter: z
    .string()
    .min(1)
    .describe('Substring filter applied to log entries')
    .optional(),
});

export const generateLocatorsInputSchema = z.object({});

export type SetContextInputZ = z.infer<typeof setContextInputSchema>;
export type GetContextInputZ = z.infer<typeof getContextInputSchema>;
export type ClipboardInputZ = z.infer<typeof clipboardInputSchema>;
export type CdpInputZ = z.infer<typeof cdpInputSchema>;
export type HermesTargetsInputZ = z.infer<typeof hermesTargetsInputSchema>;
export type MockNetworkInputZ = z.infer<typeof mockNetworkInputSchema>;
export type ScrollToElementInputZ = z.infer<typeof scrollToElementInputSchema>;
export type DeviceSwipeInputZ = z.infer<typeof deviceSwipeInputSchema>;
export type LongPressInputZ = z.infer<typeof longPressInputSchema>;
export type TapCoordinatesInputZ = z.infer<typeof tapCoordinatesInputSchema>;
export type DismissKeyboardInputZ = z.infer<typeof dismissKeyboardInputSchema>;
export type DismissAlertInputZ = z.infer<typeof dismissAlertInputSchema>;
export type GetAlertTextInputZ = z.infer<typeof getAlertTextInputSchema>;
export type OpenAppInputZ = z.infer<typeof openAppInputSchema>;
export type CloseAppInputZ = z.infer<typeof closeAppInputSchema>;
export type PressButtonInputZ = z.infer<typeof pressButtonInputSchema>;
export type DeviceContextInputZ = z.infer<typeof deviceContextInputSchema>;
export type DeviceClipboardInputZ = z.infer<typeof deviceClipboardInputSchema>;
export type ScreenRecordingInputZ = z.infer<typeof screenRecordingInputSchema>;
export type DeviceLogsInputZ = z.infer<typeof deviceLogsInputSchema>;
export type GenerateLocatorsInputZ = z.infer<
  typeof generateLocatorsInputSchema
>;

export const toolSchemas = {
  build: withObserve(buildInputSchema),
  launch: withObserve(launchInputSchema),
  cleanup: withObserve(cleanupInputSchema),
  get_state: withObserve(getStateInputSchema),
  navigate: withObserve(navigateInputSchema),
  wait_for_notification: withObserve(waitForNotificationInputSchema),
  switch_to_tab: withObserve(switchToTabInputSchema),
  close_tab: withObserve(closeTabInputSchema),
  list_testids: withObserve(listTestIdsInputSchema),
  accessibility_snapshot: withObserve(accessibilitySnapshotInputSchema),
  describe_screen: withObserve(describeScreenInputSchema),
  screenshot: withObserve(screenshotInputSchema),
  click: withObserve(clickInputSchema),
  type: withObserve(typeInputSchema),
  wait_for: withObserve(waitForInputSchema),
  get_text: withObserve(getTextInputSchema),
  seed_contract: withObserve(seedContractInputSchema),
  seed_contracts: withObserve(seedContractsInputSchema),
  get_contract_address: withObserve(getContractAddressInputSchema),
  list_contracts: withObserve(listDeployedContractsInputSchema),
  run_steps: withObserve(runStepsInputSchema),
  set_context: withObserve(setContextInputSchema),
  get_context: withObserve(getContextInputSchema),
  clipboard: withObserve(clipboardInputSchema),
  cdp: withObserve(cdpInputSchema),
  hermes_targets: withObserve(hermesTargetsInputSchema),
  get_window_size: withObserve(getWindowSizeInputSchema),
  mock_network: withObserve(mockNetworkInputSchema),
  scroll_to_element: withObserve(scrollToElementInputSchema),
  device_swipe: withObserve(deviceSwipeInputSchema),
  long_press: withObserve(longPressInputSchema),
  tap_coordinates: withObserve(tapCoordinatesInputSchema),
  dismiss_keyboard: withObserve(dismissKeyboardInputSchema),
  dismiss_alert: withObserve(dismissAlertInputSchema),
  get_alert_text: withObserve(getAlertTextInputSchema),
  open_app: withObserve(openAppInputSchema),
  close_app: withObserve(closeAppInputSchema),
  press_button: withObserve(pressButtonInputSchema),
  device_context: withObserve(deviceContextInputSchema),
  device_clipboard: withObserve(deviceClipboardInputSchema),
  screen_recording: withObserve(screenRecordingInputSchema),
  device_logs: withObserve(deviceLogsInputSchema),
  generate_locators: withObserve(generateLocatorsInputSchema),
} as const;

export type ToolName = keyof typeof toolSchemas;

export type BuildInputZ = z.infer<typeof buildInputSchema>;
export type LaunchInputZ = z.infer<typeof launchInputSchema>;
export type CleanupInputZ = z.infer<typeof cleanupInputSchema>;
export type GetStateInputZ = z.infer<typeof getStateInputSchema>;
export type NavigateInputZ = z.infer<typeof navigateInputSchema>;
export type WaitForNotificationInputZ = z.infer<
  typeof waitForNotificationInputSchema
>;
export type ListTestIdsInputZ = z.infer<typeof listTestIdsInputSchema>;
export type AccessibilitySnapshotInputZ = z.infer<
  typeof accessibilitySnapshotInputSchema
>;
export type DescribeScreenInputZ = z.infer<typeof describeScreenInputSchema>;
export type ScreenshotInputZ = z.infer<typeof screenshotInputSchema>;
export type ClickInputZ = z.infer<typeof clickInputSchema>;
export type TypeInputZ = z.infer<typeof typeInputSchema>;
export type WaitForInputZ = z.infer<typeof waitForInputSchema>;
export type GetTextInputZ = z.infer<typeof getTextInputSchema>;
export type RunStepsInputZ = z.infer<typeof runStepsInputSchema>;
export type SwitchToTabInputZ = z.infer<typeof switchToTabInputSchema>;
export type CloseTabInputZ = z.infer<typeof closeTabInputSchema>;
export type NetworkMockRouteRuleZ = z.infer<typeof networkMockRouteRuleSchema>;
export type NetworkMockConfigZ = z.infer<typeof networkMockConfigSchema>;
