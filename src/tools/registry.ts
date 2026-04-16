import { runStepsTool } from './batch.js';
import { buildTool } from './build.js';
import { cleanupTool } from './cleanup.js';
import { clipboardTool } from './clipboard.js';
import { getContextTool, setContextTool } from './context.js';
import {
  accessibilitySnapshotTool,
  describeScreenTool,
  listTestIdsTool,
} from './discovery-tools.js';
import { clickTool, typeTool, waitForTool } from './interaction.js';
import {
  knowledgeLastTool,
  knowledgeSearchTool,
  knowledgeSessionsTool,
  knowledgeSummarizeTool,
} from './knowledge.js';
import { launchTool } from './launch.js';
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
]);

export type ToolCategory = 'mutating' | 'readonly' | 'discovery' | 'batch';

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // MUTATING (13)
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
  // READONLY (9)
  knowledge_last: 'readonly',
  knowledge_search: 'readonly',
  knowledge_summarize: 'readonly',
  knowledge_sessions: 'readonly',
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
