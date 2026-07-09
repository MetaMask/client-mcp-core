import { runStepsTool } from './batch.js';
import { buildTool } from './build.js';
import { cdpTool } from './cdp.js';
import { cleanupTool } from './cleanup.js';
import { clipboardTool } from './clipboard.js';
import { getContextTool, setContextTool } from './context.js';
import {
  accessibilitySnapshotTool,
  describeScreenTool,
  listTestIdsTool,
} from './discovery-tools.js';
import { hermesTargetsTool } from './hermes.js';
import {
  clickTool,
  getTextTool,
  typeTool,
  waitForTool,
} from './interaction.js';
import {
  knowledgeLastTool,
  knowledgeSearchTool,
  knowledgeSessionsTool,
  knowledgeSummarizeTool,
} from './knowledge.js';
import { launchTool } from './launch.js';
import { mockNetworkTool } from './mock-network.js';
import {
  closeTabTool,
  navigateTool,
  switchToTabTool,
  waitForNotificationTool,
} from './navigation.js';
import { screenshotTool } from './screenshot.js';
import {
  getContractAddressTool,
  listContractsTool,
  seedContractTool,
  seedContractsTool,
} from './seeding.js';
import { getStateTool } from './state.js';
import { ErrorCodes } from './types/errors.js';
import type { PlatformType } from '../platform/types.js';
import type { ToolFunction } from '../types/http.js';

// holds tools with heterogeneous parameter types. TypeScript's contravariant
// function parameters prevent assigning ToolFunction<SpecificInput, ...> to
// ToolFunction<unknown, ...>, so `any` is the standard pattern for type-erased
// function maps. Input safety is enforced at the Zod validation boundary.
export const toolRegistry = new Map<string, ToolFunction<any, any>>([
  ['build', buildTool],
  ['launch', launchTool],
  ['cleanup', cleanupTool],
  ['get_state', getStateTool],
  ['navigate', navigateTool],
  ['wait_for_notification', waitForNotificationTool],
  ['switch_to_tab', switchToTabTool],
  ['close_tab', closeTabTool],
  ['list_testids', listTestIdsTool],
  ['accessibility_snapshot', accessibilitySnapshotTool],
  ['describe_screen', describeScreenTool],
  ['screenshot', screenshotTool],
  ['click', clickTool],
  ['type', typeTool],
  ['wait_for', waitForTool],
  ['get_text', getTextTool],
  ['knowledge_last', knowledgeLastTool],
  ['knowledge_search', knowledgeSearchTool],
  ['knowledge_summarize', knowledgeSummarizeTool],
  ['knowledge_sessions', knowledgeSessionsTool],
  ['seed_contract', seedContractTool],
  ['seed_contracts', seedContractsTool],
  ['get_contract_address', getContractAddressTool],
  ['list_contracts', listContractsTool],
  ['run_steps', runStepsTool],
  ['set_context', setContextTool],
  ['get_context', getContextTool],
  ['clipboard', clipboardTool],
  ['cdp', cdpTool],
  ['hermes_targets', hermesTargetsTool],
  ['mock_network', mockNetworkTool],
]);

export type ToolCategory = 'mutating' | 'readonly' | 'discovery' | 'batch';

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // MUTATING (15)
  click: 'mutating',
  type: 'mutating',
  navigate: 'mutating',
  launch: 'mutating',
  cleanup: 'mutating',
  switch_to_tab: 'mutating',
  close_tab: 'mutating',
  clipboard: 'mutating',
  build: 'mutating',
  wait_for: 'mutating',
  wait_for_notification: 'mutating',
  seed_contract: 'mutating',
  seed_contracts: 'mutating',
  cdp: 'mutating',
  mock_network: 'mutating',
  // READONLY (11)
  hermes_targets: 'readonly',
  knowledge_last: 'readonly',
  knowledge_search: 'readonly',
  knowledge_summarize: 'readonly',
  knowledge_sessions: 'readonly',
  get_text: 'readonly',
  get_state: 'readonly',
  get_context: 'readonly',
  // set_context is blocked while a session is active (MM_CONTEXT_SWITCH_BLOCKED),
  // so Playwright observations would never be collected. Classified as readonly
  // since it never runs in a state where page observations are meaningful.
  set_context: 'readonly',
  list_contracts: 'readonly',
  get_contract_address: 'readonly',
  // DISCOVERY (4)
  describe_screen: 'discovery',
  list_testids: 'discovery',
  accessibility_snapshot: 'discovery',
  screenshot: 'discovery',
  // BATCH (1)
  run_steps: 'batch',
};

/**
 * Returns the category for a registered tool name.
 * Unknown tools default to 'mutating' — the safe default that ensures
 * new tools get observations until explicitly categorized.
 *
 * @param toolName - The registered tool name to look up.
 * @returns The tool's category, or 'mutating' for unknown tools.
 */
export function getToolCategory(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] ?? 'mutating';
}

const BROWSER_ONLY_TOOLS = new Set([
  'navigate',
  'switch_to_tab',
  'close_tab',
  'wait_for_notification',
  'clipboard',
  'mock_network',
  'build',
]);

/**
 * Checks if a tool is only available on the browser platform.
 *
 * @param toolName - The registered tool name to check.
 * @returns True if the tool is browser-only, false if cross-platform.
 */
export function isBrowserOnlyTool(toolName: string): boolean {
  return BROWSER_ONLY_TOOLS.has(toolName);
}

const MOBILE_ONLY_TOOLS = new Set(['hermes_targets']);

/**
 * Checks if a tool is only available on mobile (iOS/Android) platforms.
 *
 * @param toolName - The registered tool name to check.
 * @returns True if the tool is mobile-only, false otherwise.
 */
export function isMobileOnlyTool(toolName: string): boolean {
  return MOBILE_ONLY_TOOLS.has(toolName);
}

export type PlatformGateError = {
  code: typeof ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM;
  message: string;
};

/**
 * Single source of truth for browser-only / mobile-only platform gating,
 * shared by the HTTP route handler and the run_steps batch executor so the two
 * paths cannot drift on error code or message. An undefined platform (no active
 * platform driver) is treated as "not mobile", so mobile-only tools are gated.
 *
 * @param toolName - The registered tool name being invoked.
 * @param platform - The active platform driver's platform, or undefined when no
 * platform driver is available.
 * @returns A gating error when the tool may not run on the platform, otherwise
 * undefined.
 */
export function checkPlatformGate(
  toolName: string,
  platform: PlatformType | undefined,
): PlatformGateError | undefined {
  if (isBrowserOnlyTool(toolName) && platform && platform !== 'browser') {
    return {
      code: ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
      message: `Tool "${toolName}" is not supported on ${platform} platform`,
    };
  }
  if (isMobileOnlyTool(toolName) && (!platform || platform === 'browser')) {
    return {
      code: ErrorCodes.MM_TOOL_NOT_SUPPORTED_ON_PLATFORM,
      message: `Tool "${toolName}" is only supported on mobile (iOS/Android) platforms`,
    };
  }
  return undefined;
}
