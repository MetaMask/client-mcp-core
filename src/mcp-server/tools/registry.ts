export {
  getToolHandler,
  hasToolHandler,
  buildToolHandlersRecord,
  type ToolHandler,
} from "./definitions.js";

import { buildToolHandlersRecord } from "./definitions.js";

export const toolHandlers = buildToolHandlersRecord();
