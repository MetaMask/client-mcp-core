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
