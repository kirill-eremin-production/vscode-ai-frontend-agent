import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import {
  appendChatMessage,
  updateRunStatus,
  type LoopConfig,
  type ToolEvent,
} from '@ext/entities/run/storage';
import { loadResumeContext } from '@ext/shared/agent-loop';
import { broadcast } from '@ext/features/run-management/broadcast';
import { getOpenRouterKey } from '@ext/shared/secrets/openrouter-key';

/**
 * Реестр resumer'ов ролей. Каждая роль (smoke, продакт, архитектор)
 * регистрирует функцию, которая умеет возобновить её цикл по `LoopConfig`
 * + истории `ToolEvent[]` + ответу пользователя на pending `ask_user`.
 *
 * Зачем не зашить смоук-resumer прямо в wire.ts: будущие роли тоже
 * будут возобновляться, и единая точка регистрации избавит от
 * if-else по `config.role`. Реестр модульный, как и pending-asks.
 */

/**
 * Сигнатура resumer'а. Принимает всё, что storage умеет восстановить,
 * + apiKey + runId. Должна сама собрать tool registry и вызвать
 * `runAgentLoop` с `initialHistory` от `reconstructHistory`.
 *
 * Никаких возвратов — resumer работает в фоне, прогресс уходит в
 * webview через broadcast.
 */
export type RoleResumer = (params: {
  runId: string;
  apiKey: string;
  config: LoopConfig;
  events: ToolEvent[];
  /** id pending tool_call ask_user, на который пришёл ответ. */
  pendingToolCallId: string;
  /** Ответ пользователя — текст из IPC `runs.userAnswer`. */
  userAnswer: string;
}) => Promise<void>;

const resumers = new Map<string, RoleResumer>();

/**
 * Зарегистрировать resumer роли. Вызывается ровно один раз в
 * `activate` каждой ролью, которая использует agent-loop.
 */
export function registerRoleResumer(role: string, resumer: RoleResumer): void {
  resumers.set(role, resumer);
}

/**
 * Найти и запустить resumer для рана. Возвращает true, если resumer
 * стартовал (фактический результат прилетит асинхронно через broadcast),
 * false — если возобновление невозможно (не нашли config / events / role).
 *
 * При false помечаем ран `failed` и пишем сообщение в `chat.jsonl` —
 * иначе он навсегда останется в `awaiting_user_input` без шансов
 * на ответ.
 */
export async function resumeRun(params: {
  context: vscode.ExtensionContext;
  runId: string;
  pendingToolCallId: string;
  userAnswer: string;
}): Promise<boolean> {
  const ctx = await loadResumeContext(params.runId);
  if (!ctx) {
    await markUnresumable(params.runId, 'нет loop.json или tools.jsonl');
    return false;
  }

  const resumer = resumers.get(ctx.config.role);
  if (!resumer) {
    await markUnresumable(params.runId, `нет resumer'а для роли "${ctx.config.role}"`);
    return false;
  }

  const apiKey = await getOpenRouterKey(params.context);
  if (!apiKey) {
    await markUnresumable(
      params.runId,
      'нет ключа OpenRouter (задай через "AI Frontend Agent: Set OpenRouter API Key")'
    );
    return false;
  }

  // Запускаем resumer в фоне. Не await'им — пользовательский IPC
  // не должен висеть, пока крутится цикл. Прогресс прилетает через
  // broadcast (status updates, askUser, новые сообщения).
  void resumer({
    runId: params.runId,
    apiKey,
    config: ctx.config,
    events: ctx.events,
    pendingToolCallId: params.pendingToolCallId,
    userAnswer: params.userAnswer,
  }).catch(async (err) => {
    const reason = err instanceof Error ? err.message : String(err);
    await markUnresumable(params.runId, `resumer бросил исключение: ${reason}`);
  });

  return true;
}

/**
 * Перевести ран в `failed` с диагностикой. Используется, когда мы
 * физически не можем возобновить цикл (нет конфига, нет ключа и т.п.).
 */
async function markUnresumable(runId: string, reason: string): Promise<void> {
  const message = `Не удалось возобновить ран: ${reason}`;
  const updated = await updateRunStatus(runId, 'failed');
  if (updated) {
    broadcast({ type: 'runs.updated', meta: updated });
  }
  const chatMessage = {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'agent:system',
    at: new Date().toISOString(),
    text: message,
  };
  await appendChatMessage(runId, chatMessage);
  broadcast({ type: 'runs.message.appended', runId, message: chatMessage });
}
