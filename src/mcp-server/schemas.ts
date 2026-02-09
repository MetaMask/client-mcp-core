import { z } from 'zod';

import { SMART_CONTRACT_NAMES, HARDFORKS } from './types/seeding.js';

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

export const knowledgeScopeSchema = z.union([
  z.literal('current').describe('Only search the active session'),
  z.literal('all').describe('Search all sessions in the knowledge store'),
  z
    .object({
      sessionId: z.string().min(4).describe('Specific session ID to query'),
    })
    .describe('Query a specific prior session by ID'),
]);

const smartContractNames = SMART_CONTRACT_NAMES;
const hardforks = HARDFORKS;

export const knowledgeFiltersSchema = z
  .object({
    flowTag: z
      .string()
      .min(1)
      .describe('Filter by flow tag (e.g., send, swap, connect, sign)')
      .optional(),
    tag: z.string().min(1).describe('Filter by free-form tag').optional(),
    screen: z
      .string()
      .min(1)
      .describe('Filter by screen name (e.g., home, unlock, settings)')
      .optional(),
    sinceHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .describe('Only include sessions/steps from the last N hours')
      .optional(),
  })
  .optional();

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
    goal: z
      .string()
      .describe(
        'Goal or task description for this session (for knowledge store)',
      )
      .optional(),
    flowTags: z
      .array(z.string())
      .describe(
        'Flow tags for categorization (e.g., ["send"], ["swap", "confirmation"]). ' +
          'Used for cross-session knowledge retrieval.',
      )
      .optional(),
    tags: z
      .array(z.string())
      .describe('Free-form tags for ad-hoc filtering')
      .optional(),
    seedContracts: z
      .array(z.enum(smartContractNames))
      .describe('Smart contracts to deploy on launch (before extension loads)')
      .optional(),
    platform: z
      .enum(['browser', 'ios'])
      .default('browser')
      .describe('Platform to launch on'),
    simulatorDeviceId: z
      .string()
      .optional()
      .describe('iOS simulator device UDID'),
    appBundlePath: z
      .string()
      .optional()
      .describe('Path to MetaMask Mobile .app bundle'),
  })
  .refine(
    (data) => data.platform !== 'ios' || Boolean(data.simulatorDeviceId),
    {
      message: 'simulatorDeviceId is required when platform is "ios"',
      path: ['simulatorDeviceId'],
    },
  )
  .refine((data) => data.platform !== 'ios' || Boolean(data.appBundlePath), {
    message: 'appBundlePath is required when platform is "ios"',
    path: ['appBundlePath'],
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
  name: z.string().min(1).describe('Screenshot filename (without extension)'),
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

export const clickInputSchema = targetSelectionSchema.and(
  z.object({
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .default(15000)
      .describe('Timeout to wait for element to become visible'),
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
  }),
);

export const knowledgeLastInputSchema = z.object({
  n: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe('Number of recent steps to retrieve'),
  scope: knowledgeScopeSchema
    .default('current')
    .describe(
      'Scope for retrieval: current session, all sessions, or specific session',
    ),
  filters: knowledgeFiltersSchema,
});

export const knowledgeSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Search query - matches tool names, screen names, testIds, and a11y names',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of results'),
  scope: knowledgeScopeSchema
    .default('all')
    .describe(
      'Search scope (defaults to all sessions for cross-session learning)',
    ),
  filters: knowledgeFiltersSchema,
});

export const knowledgeSummarizeInputSchema = z.object({
  sessionId: z
    .string()
    .describe('Deprecated: use scope. Session ID to summarize.')
    .optional(),
  scope: z
    .union([
      z.literal('current'),
      z.object({
        sessionId: z.string().min(4),
      }),
    ])
    .default('current')
    .describe('Session to summarize (cannot use "all")'),
});

export const knowledgeSessionsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of sessions to list'),
  filters: knowledgeFiltersSchema,
});

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
  includeObservations: z
    .enum(['none', 'failures', 'all'])
    .default('all')
    .describe(
      'When to include observations in results: ' +
        'none = never (fastest), failures = only for failed steps, all = always',
    ),
});

export const setContextInputSchema = z.object({
  context: z.enum(['e2e', 'prod']).describe('Target context to switch to'),
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

export type SetContextInputZ = z.infer<typeof setContextInputSchema>;
export type GetContextInputZ = z.infer<typeof getContextInputSchema>;
export type ClipboardInputZ = z.infer<typeof clipboardInputSchema>;

export const toolSchemas = {
  build: buildInputSchema,
  launch: launchInputSchema,
  cleanup: cleanupInputSchema,
  get_state: getStateInputSchema,
  navigate: navigateInputSchema,
  wait_for_notification: waitForNotificationInputSchema,
  switch_to_tab: switchToTabInputSchema,
  close_tab: closeTabInputSchema,
  list_testids: listTestIdsInputSchema,
  accessibility_snapshot: accessibilitySnapshotInputSchema,
  describe_screen: describeScreenInputSchema,
  screenshot: screenshotInputSchema,
  click: clickInputSchema,
  type: typeInputSchema,
  wait_for: waitForInputSchema,
  knowledge_last: knowledgeLastInputSchema,
  knowledge_search: knowledgeSearchInputSchema,
  knowledge_summarize: knowledgeSummarizeInputSchema,
  knowledge_sessions: knowledgeSessionsInputSchema,
  seed_contract: seedContractInputSchema,
  seed_contracts: seedContractsInputSchema,
  get_contract_address: getContractAddressInputSchema,
  list_contracts: listDeployedContractsInputSchema,
  run_steps: runStepsInputSchema,
  set_context: setContextInputSchema,
  get_context: getContextInputSchema,
  clipboard: clipboardInputSchema,
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
export type KnowledgeLastInputZ = z.infer<typeof knowledgeLastInputSchema>;
export type KnowledgeSearchInputZ = z.infer<typeof knowledgeSearchInputSchema>;
export type KnowledgeSummarizeInputZ = z.infer<
  typeof knowledgeSummarizeInputSchema
>;
export type KnowledgeSessionsInputZ = z.infer<
  typeof knowledgeSessionsInputSchema
>;
export type KnowledgeScopeZ = z.infer<typeof knowledgeScopeSchema>;
export type KnowledgeFiltersZ = z.infer<typeof knowledgeFiltersSchema>;
export type RunStepsInputZ = z.infer<typeof runStepsInputSchema>;
export type SwitchToTabInputZ = z.infer<typeof switchToTabInputSchema>;
export type CloseTabInputZ = z.infer<typeof closeTabInputSchema>;
