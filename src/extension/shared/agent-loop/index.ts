/**
 * Публичный API agent-loop модуля. Внешний код импортирует только отсюда —
 * внутренние файлы (validator, kb-тулы) трогать не нужно.
 */

export { runAgentLoop, type AgentLoopParams, type AgentLoopResult } from './loop';
export type { ToolDefinition, ToolRegistry, ToolHandlerContext } from './types';
export { kbTools, kbReadTool, kbWriteTool, kbListTool, kbGrepTool } from './tools/kb';
export { askUserTool } from './tools/ask-user';
export {
  registerPendingAsk,
  resolvePendingAsk,
  rejectPendingAsk,
  hasPendingAsk,
} from './pending-asks';
export { reconstructHistory, loadResumeContext, logResume, type ResumeIntent } from './resume';
