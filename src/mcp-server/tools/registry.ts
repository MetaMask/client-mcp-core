import { buildToolHandlersRecord } from './definitions.js';

export {
  getToolHandler,
  hasToolHandler,
  buildToolHandlersRecord,
} from './definitions.js';
export type { ToolHandler } from './batch.js';

export const toolHandlers = buildToolHandlersRecord();
