import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { getOpenRouterKey, promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import {
  runAgentLoop,
  kbTools,
  askUserTool,
  reconstructHistory,
  logResume,
  type ToolDefinition,
  type ToolRegistry,
} from '@ext/shared/agent-loop';
import {
  appendChatMessage,
  initRunDir,
  updateRunStatus,
  writeLoopConfig,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { registerRoleResumer } from '@ext/entities/run/resume-registry';
import type { RunMeta } from '@ext/entities/run/types';

/**
 * Тестовая команда + resumer для ручной проверки tool runtime.
 *
 * Назначение — закрыть TC-11..16: запустить полный цикл с реальной
 * моделью и реальными тулами (включая `ask_user`), убедиться, что
 * `tools.jsonl` пишется, sandbox и валидация работают, durability
 * ask_user через перезапуск VS Code тоже работает.
 *
 * Когда появятся реальные роли (продакт, архитектор) — команду
 * можно либо удалить, либо оставить как «диагностический ран».
 */

/** Идентификатор роли в loop.json — нужен для resume-registry. */
const SMOKE_ROLE = 'smoke';

/**
 * Модель для smoke. Ту же gemini-flash-lite, что и для title — она
 * быстрая, дешёвая, и сейчас задача — проверить инфраструктуру, а не
 * качество ответов. Если в проде окажется, что эта модель плохо
 * вызывает тулы — поменяем на claude-haiku.
 */
const SMOKE_MODEL = 'google/gemini-3.1-flash-lite-preview';

/**
 * System prompt: жёстко направляет модель в kb.write/ask_user, чтобы
 * smoke-тесты были детерминированными. Без направления модель часто
 * «обсуждает» задачу и не вызывает ни одного тула.
 */
const SMOKE_SYSTEM_PROMPT = [
  'You are a smoke-test agent for an AI Frontend Agent extension.',
  'Available tools (sandboxed to .agents/knowledge/):',
  '- kb.read / kb.write / kb.list / kb.grep — for files inside knowledge base.',
  '- ask_user — to ask the user a clarifying question and wait for the answer.',
  'STRICT RULES:',
  '- NEVER invent missing details. If the user did not specify file content, list items, names, etc. — you MUST call ask_user FIRST and wait for a real answer.',
  '- Placeholder text like "Это файл для smoke-теста" is NOT acceptable as a substitute for asking.',
  '- For "create file" requests, save under "smoke/<name>.md" via kb.write — but only AFTER you have all needed details.',
  '- ALWAYS call at least one tool before any final text reply.',
  '- After tools succeed, give a short final reply describing what you did.',
].join('\n');

/** Полный набор тулов smoke-роли — ровно его пишем в loop.json. */
function buildSmokeRegistry(): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of kbTools) registry.set(tool.name, tool);
  registry.set(askUserTool.name, askUserTool as ToolDefinition);
  return registry;
}

/** Имена тулов smoke-роли — для записи в loop.json и resume. */
function smokeToolNames(): string[] {
  return [...kbTools.map((t) => t.name), askUserTool.name];
}

/**
 * Создать минимальный ран под smoke (без полноценного service.createRun,
 * чтобы не тащить title-генерацию и т.п. — эта команда временная).
 */
async function createSmokeRun(prompt: string): Promise<RunMeta> {
  const now = new Date().toISOString();
  const id =
    `smoke-${now.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15)}-` +
    crypto.randomBytes(3).toString('hex');
  const baseMeta = {
    id,
    title: `[smoke] ${prompt.slice(0, 40)}`,
    prompt,
    status: 'running' as const,
    createdAt: now,
    updatedAt: now,
  };
  // initRunDir создаёт user↔agent:smoke сессию и возвращает RunMeta
  // с проставленным `activeSessionId`. После этого все append-операции
  // без явного sessionId автоматически идут в эту сессию.
  const meta = await initRunDir(baseMeta, {
    kind: 'user-agent',
    participants: [{ kind: 'user' }, { kind: 'agent', role: SMOKE_ROLE }],
    status: 'running',
  });
  await appendChatMessage(meta.id, {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'user',
    at: now,
    text: prompt,
  });
  return meta;
}

/**
 * Финализатор: пишет финальный ответ модели (или причину фейла) в
 * `chat.jsonl`, обновляет статус. Используется и в первичном запуске,
 * и в resume — чтобы не дублировать код.
 */
async function finalizeRun(
  runId: string,
  outcome:
    | { kind: 'completed'; finalContent: string; iterations: number }
    | { kind: 'failed'; reason: string; iterations: number }
    | { kind: 'paused'; reason: string; meetingRequestId: string; iterations: number }
): Promise<void> {
  // #0051: smoke-роль не использует team.invite/team.escalate, поэтому
  // ветка `paused` сюда прийти не должна — но TS-дискриминатор требует
  // явной обработки. Если когда-нибудь окажемся здесь — это диагностика
  // регрессии: smoke-реестр не должен включать пишущие в meeting-request тулы.
  if (outcome.kind === 'paused') return;
  if (outcome.kind === 'completed') {
    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      from: 'agent:smoke',
      at: new Date().toISOString(),
      text: outcome.finalContent,
    };
    const sessionId = await appendChatMessage(runId, message);
    broadcast({ type: 'runs.message.appended', runId, sessionId, message });
    const updated = await updateRunStatus(runId, 'awaiting_human');
    if (updated) broadcast({ type: 'runs.updated', meta: updated });
    void vscode.window.showInformationMessage(
      `Smoke OK (${outcome.iterations} итераций). См. .agents/runs/${runId}/`
    );
  } else {
    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      from: 'agent:system',
      at: new Date().toISOString(),
      text: `Smoke failed: ${outcome.reason}`,
    };
    const sessionId = await appendChatMessage(runId, message);
    broadcast({ type: 'runs.message.appended', runId, sessionId, message });
    const updated = await updateRunStatus(runId, 'failed');
    if (updated) broadcast({ type: 'runs.updated', meta: updated });
    void vscode.window.showErrorMessage(`Smoke failed: ${outcome.reason}`);
  }
}

/**
 * Зарегистрировать resumer для smoke-роли. Вызывается из `activate`,
 * один раз за сессию VS Code. Сам resumer вызывается, когда приходит
 * `runs.user.message` для рана: либо ответ на pending `ask_user`, либо
 * новое сообщение в `awaiting_human`/`failed` (continue, US-10).
 */
export function registerToolLoopSmokeResumer(): void {
  registerRoleResumer(SMOKE_ROLE, async ({ runId, apiKey, config, events, intent }) => {
    // Маркер в tools.jsonl — чтобы при разборе лога было видно
    // точку и причину resume.
    const marker =
      intent.kind === 'answer'
        ? `Resume after VS Code restart, answering tool_call ${intent.pendingToolCallId}`
        : 'Resume by user follow-up message in chat';
    await logResume(runId, marker);

    const initialHistory = reconstructHistory(config, events, intent);

    const registry = buildSmokeRegistry();
    // Вернём статус в running до первого запроса — UI увидит, что
    // ран снова работает (был awaiting_user_input/awaiting_human/failed
    // до этого момента).
    const resumed = await updateRunStatus(runId, 'running');
    if (resumed) broadcast({ type: 'runs.updated', meta: resumed });

    const result = await runAgentLoop({
      runId,
      apiKey,
      model: config.model,
      systemPrompt: config.systemPrompt,
      userMessage: config.userMessage,
      tools: registry,
      temperature: config.temperature,
      initialHistory,
    });

    await finalizeRun(runId, result);
  });
}

/**
 * Зарегистрировать саму команду в extension host. Вызывается из `activate`.
 */
export function registerToolLoopSmokeCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('aiFrontendAgent.runToolLoopSmoke', async () => {
    const prompt = await vscode.window.showInputBox({
      prompt:
        'Smoke prompt (например: "Создай smoke/note.md" или "...без указания текста" — тогда агент задаст вопрос)',
      placeHolder: 'Создай smoke/note.md с текстом hello',
    });
    if (!prompt) return;

    let apiKey = await getOpenRouterKey(context);
    if (!apiKey) {
      const ok = await promptForOpenRouterKey(context);
      if (!ok) return;
      apiKey = await getOpenRouterKey(context);
      if (!apiKey) return;
    }

    let meta: RunMeta;
    try {
      meta = await createSmokeRun(prompt);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      void vscode.window.showErrorMessage(`Не удалось создать smoke-ран: ${reason}`);
      return;
    }

    // Записываем loop.json ДО старта цикла — иначе перезапуск VS Code
    // ровно на первом запросе оставит ран без возможности resume.
    await writeLoopConfig(meta.id, {
      model: SMOKE_MODEL,
      systemPrompt: SMOKE_SYSTEM_PROMPT,
      toolNames: smokeToolNames(),
      userMessage: prompt,
      role: SMOKE_ROLE,
    });

    broadcast({ type: 'runs.updated', meta });
    void vscode.window.showInformationMessage(`Smoke-ран ${meta.id} запущен. См. .agents/runs/`);

    const registry = buildSmokeRegistry();
    const result = await runAgentLoop({
      runId: meta.id,
      apiKey,
      model: SMOKE_MODEL,
      systemPrompt: SMOKE_SYSTEM_PROMPT,
      userMessage: prompt,
      tools: registry,
    });

    await finalizeRun(meta.id, result);
  });
}
