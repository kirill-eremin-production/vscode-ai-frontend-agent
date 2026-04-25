import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { getOpenRouterKey, promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import { runAgentLoop, kbTools, type ToolRegistry } from '@ext/shared/agent-loop';
import { appendChatMessage, initRunDir } from '@ext/entities/run/storage';
import type { RunMeta } from '@ext/entities/run/types';

/**
 * Тестовая команда для ручной проверки tool runtime (Фаза A задачи #0001).
 *
 * Эта команда — намеренно временная: пока нет реальных ролей (продакт,
 * архитектор), нужен способ дёрнуть `runAgentLoop` руками с реальной
 * моделью и реальными kb-тулами и убедиться, что цикл живой,
 * `tools.jsonl` пишется, sandbox работает.
 *
 * Когда роли появятся, команду можно либо удалить, либо оставить как
 * «диагностический ран» — решим в Фазе B/C.
 */

/**
 * Модель для smoke-теста. Берём ту же дешёвую, что и для title —
 * нам не нужно ничего умного, только проверить что цикл крутится.
 * Если она плохо вызывает тулы — заменим на claude-haiku или gpt-4o-mini.
 */
const SMOKE_MODEL = 'google/gemini-3.1-flash-lite-preview';

/**
 * System prompt: жёстко направляет модель в kb.write, чтобы smoke-тест
 * был детерминированным. Без этого модель может «обсудить» задачу и
 * не вызвать ни одного тула.
 */
const SMOKE_SYSTEM_PROMPT = [
  'You are a smoke-test agent for an AI Frontend Agent extension.',
  'You have access to kb.* tools (read/write/list/grep) sandboxed to .agents/knowledge/.',
  'Rules:',
  '- ALWAYS call at least one kb tool before giving a final text reply.',
  '- For "create file" requests, use kb.write directly.',
  '- After all tool calls succeed, give a short final reply describing what you did.',
  '- Use paths like "smoke/<filename>.md" inside kb.',
].join('\n');

/**
 * Создать минимальный ран под smoke (без полноценного service.createRun,
 * чтобы не тащить title-генерацию и т.п. — эта команда временная).
 */
async function createSmokeRun(prompt: string): Promise<RunMeta> {
  const now = new Date().toISOString();
  const id =
    `smoke-${now.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15)}-` +
    crypto.randomBytes(3).toString('hex');
  const meta: RunMeta = {
    id,
    title: `[smoke] ${prompt.slice(0, 40)}`,
    prompt,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  await initRunDir(meta);
  await appendChatMessage(meta.id, {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'user',
    at: now,
    text: prompt,
  });
  return meta;
}

/**
 * Зарегистрировать команду в extension host. Вызывается из `activate`.
 */
export function registerToolLoopSmokeCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('aiFrontendAgent.runToolLoopSmoke', async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Smoke prompt (например: "Создай smoke/note.md с текстом hello")',
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

    const registry: ToolRegistry = new Map();
    for (const tool of kbTools) registry.set(tool.name, tool);

    void vscode.window.showInformationMessage(`Smoke-ран ${meta.id} запущен. См. .agents/runs/`);

    const result = await runAgentLoop({
      runId: meta.id,
      apiKey,
      model: SMOKE_MODEL,
      systemPrompt: SMOKE_SYSTEM_PROMPT,
      userMessage: prompt,
      tools: registry,
    });

    // Результат финального assistant-ответа дублируем в chat.jsonl —
    // это ровно та логика, которую потом продакт/архитектор будут делать
    // штатно. Здесь же — для проверки, что всё доезжает в ленту.
    if (result.kind === 'completed') {
      await appendChatMessage(meta.id, {
        id: crypto.randomBytes(6).toString('hex'),
        from: 'agent:smoke',
        at: new Date().toISOString(),
        text: result.finalContent,
      });
      void vscode.window.showInformationMessage(
        `Smoke OK (${result.iterations} итераций). См. .agents/runs/${meta.id}/`
      );
    } else {
      await appendChatMessage(meta.id, {
        id: crypto.randomBytes(6).toString('hex'),
        from: 'agent:system',
        at: new Date().toISOString(),
        text: `Smoke failed: ${result.reason}`,
      });
      void vscode.window.showErrorMessage(`Smoke failed: ${result.reason}`);
    }
  });
}
