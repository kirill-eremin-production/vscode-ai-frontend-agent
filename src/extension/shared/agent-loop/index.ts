/**
 * Публичный API agent-loop модуля. Внешний код импортирует только отсюда —
 * внутренние файлы (validator, kb-тулы) трогать не нужно.
 */

export { runAgentLoop, type AgentLoopParams, type AgentLoopResult } from './loop';
export type { ToolDefinition, ToolRegistry } from './types';
export { kbTools, kbReadTool, kbWriteTool, kbListTool, kbGrepTool } from './tools/kb';
