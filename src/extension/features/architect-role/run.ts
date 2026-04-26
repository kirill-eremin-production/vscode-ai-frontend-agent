import * as crypto from 'node:crypto';
import {
  runAgentLoop,
  askUserTool,
  reconstructHistory,
  logResume,
  type AgentLoopResult,
  type ToolDefinition,
  type ToolRegistry,
} from '@ext/shared/agent-loop';
import {
  appendChatMessage,
  readBrief,
  readMeta,
  updateRunStatus,
  writeLoopConfig,
  writePlan,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { registerRoleResumer } from '@ext/entities/run/resume-registry';
import { ARCHITECT_MODEL, ARCHITECT_ROLE } from '@ext/entities/run/roles/architect';
import { buildArchitectSystemPrompt } from '@ext/entities/run/roles/architect.prompt';
import { buildRoleScopedKbTools } from '@ext/features/product-role/role-kb-tools';
import { runProgrammer } from '@ext/features/programmer-role';

/**
 * Сервисный слой роли архитектора (issue #0004).
 *
 * Архитектор стартует **автоматически** после успеха продакта:
 * `runProduct.finalizeRun` вызывает `runArchitect`, передавая runId и
 * apiKey. На вход модель получает свежезаписанный `brief.md` как
 * первое user-сообщение (см. `loadBriefForRole`) — никаких других
 * входов на этой итерации нет.
 *
 * По устройству — зеркало [product-role/run.ts](../product-role/run.ts):
 *  - `runAgentLoop` поверх архитекторских тулов и system prompt'а;
 *  - `loop.json` пишется ДО старта цикла, чтобы перезапуск VS Code
 *    в момент первого запроса не потерял ран;
 *  - `finalizeRun`: пишет `plan.md` в kb, дублирует превью в чат,
 *    переводит ран в `awaiting_human`;
 *  - resumer регистрируется в `activate` и поднимает ран после
 *    перезапуска или нового сообщения от пользователя (US-10).
 *
 * Что **не делает**:
 *  - не управляет ключом — `runProduct` уже проверил его на старте рана;
 *  - не парсит брифовые секции — модель справляется по системному
 *    prompt'у; парсер появится, только если конкретно понадобится.
 */

/** Реестр тулов архитектора: role-scoped kb + ask_user. */
function buildArchitectRegistry(): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of buildRoleScopedKbTools(ARCHITECT_ROLE)) {
    registry.set(tool.name, tool);
  }
  registry.set(askUserTool.name, askUserTool as ToolDefinition);
  return registry;
}

/** Имена тулов для `loop.json` — для совместимости с общим форматом. */
function architectToolNames(): string[] {
  return ['kb.read', 'kb.write', 'kb.list', 'kb.grep', askUserTool.name];
}

/** Сообщение в чат от имени архитектора. */
async function appendArchitectChatMessage(runId: string, text: string): Promise<void> {
  const message = {
    id: crypto.randomBytes(6).toString('hex'),
    from: `agent:${ARCHITECT_ROLE}`,
    at: new Date().toISOString(),
    text,
  };
  const sessionId = await appendChatMessage(runId, message);
  broadcast({ type: 'runs.message.appended', runId, sessionId, message });
}

/** Системное сообщение в чат — для диагностики фейлов. */
async function appendSystemChatMessage(runId: string, text: string): Promise<void> {
  const message = {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'agent:system',
    at: new Date().toISOString(),
    text,
  };
  const sessionId = await appendChatMessage(runId, message);
  broadcast({ type: 'runs.message.appended', runId, sessionId, message });
}

/**
 * Завершение цикла архитектора. Зеркало `finalizeRun` продакта, но
 * пишет `plan.md` через `writePlan` и не имеет finalize-marker'а
 * (для архитектора пока не нужен — issue не требует, US-13 относилась
 * к продактовой кнопке «достаточно вопросов»).
 *
 * Превью плана в чате — первые 600 символов: карточка рана не
 * раздувается длинным markdown'ом, полный текст лежит в `plan.md` и
 * рендерится отдельной секцией UI рядом с брифом.
 */
async function finalizeArchitectRun(
  runId: string,
  apiKey: string,
  outcome: AgentLoopResult
): Promise<void> {
  if (outcome.kind === 'completed') {
    const plan = outcome.finalContent.trim();
    if (plan.length === 0) {
      // Пустой ответ при finish_reason=stop — модель сорвалась с
      // правил prompt'а. Помечаем failed, дальше нечего сохранять.
      await appendSystemChatMessage(
        runId,
        "Архитектор закончил без текста плана — finish_reason=stop без assistant.content. Скорее всего, модель не справилась с правилами prompt'а; запусти продолжение или проверь tools.jsonl."
      );
      const failed = await updateRunStatus(runId, 'failed');
      if (failed) broadcast({ type: 'runs.updated', meta: failed });
      return;
    }

    const meta = await readMeta(runId);
    await writePlan(runId, meta?.title ?? 'untitled', plan);
    const preview = plan.length > 600 ? `${plan.slice(0, 600)}…` : plan;
    await appendArchitectChatMessage(runId, preview);
    const updated = await updateRunStatus(runId, 'awaiting_human');
    if (updated) broadcast({ type: 'runs.updated', meta: updated });

    // Issue #0027: автоматический handoff к программисту. Опт-аут через
    // env-переменную нужен e2e-фикстуре — архитекторские TC (TC-31..)
    // не должны спотыкаться об программистский запрос к OpenRouter, для
    // которого в их сценарии нет ответа. Прод этой переменной не задаёт
    // — handoff всегда включён.
    if (process.env.AI_FRONTEND_AGENT_AUTOSTART_PROGRAMMER === '0') return;

    void runProgrammer({ runId, apiKey }).catch((err) => {
      console.error('[runProgrammer] непойманная ошибка:', err);
    });
    return;
  }

  await appendSystemChatMessage(runId, `Архитектор упал: ${outcome.reason}`);
  const failed = await updateRunStatus(runId, 'failed');
  if (failed) broadcast({ type: 'runs.updated', meta: failed });
}

/**
 * Достать содержимое `brief.md` для подачи архитектору как первое
 * user-сообщение. Если брифа нет — это всегда баг вызывающего кода
 * (`runArchitect` дёргается из success-ветки `runProduct`, где бриф
 * только что записан). Возвращаем строку-маркер, чтобы цикл всё
 * равно стартовал и помог продиагностировать; падать не хочется,
 * иначе ран навсегда останется в `awaiting_human` без шанса на
 * resume.
 */
async function loadBriefAsUserMessage(runId: string): Promise<string> {
  const brief = await readBrief(runId);
  if (brief && brief.trim().length > 0) return brief;
  return [
    '[Системное предупреждение: brief.md рана пустой или отсутствует.',
    'Это означает, что продактовая роль не успела финализироваться,',
    'или артефакт удалили вручную. Сообщи об этом пользователю через',
    '`ask_user` и запроси либо перезапуск продактовой роли, либо',
    'ручной ввод требований. Не выдумывай содержание брифа.]',
  ].join(' ');
}

/**
 * Запустить архитектора на ране. Вызывается из success-пути
 * `runProduct.finalizeRun` — fire-and-forget, прогресс уходит в
 * webview через broadcast, как и у продакта.
 *
 * Любые исключения внутри `runAgentLoop` ловятся им же и
 * превращаются в `kind: 'failed'`. Внешний try/catch — на случай
 * экзотики (сломанный fs, нет workspace), иначе ран навсегда
 * остался бы в `running`.
 */
export async function runArchitect(params: { runId: string; apiKey: string }): Promise<void> {
  const systemPrompt = buildArchitectSystemPrompt();
  const userMessage = await loadBriefAsUserMessage(params.runId);

  // loop.json — ДО первого запроса к модели (см. мотив у продакта).
  await writeLoopConfig(params.runId, {
    model: ARCHITECT_MODEL,
    systemPrompt,
    toolNames: architectToolNames(),
    userMessage,
    role: ARCHITECT_ROLE,
  });

  const updated = await updateRunStatus(params.runId, 'running');
  if (updated) broadcast({ type: 'runs.updated', meta: updated });

  let outcome: AgentLoopResult;
  try {
    outcome = await runAgentLoop({
      runId: params.runId,
      apiKey: params.apiKey,
      model: ARCHITECT_MODEL,
      systemPrompt,
      userMessage,
      tools: buildArchitectRegistry(),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', reason, iterations: 0 };
  }

  await finalizeArchitectRun(params.runId, params.apiKey, outcome);
}

/**
 * Resumer архитектора. Регистрируется один раз в `activate` и
 * поднимает ран по двум сценариям (см. ResumeIntent у продакта):
 *
 *  - `answer` — пользователь ответил на pending `ask_user`
 *    архитектора, а in-memory цикл умер;
 *  - `continue` — пользователь дослал сообщение в `awaiting_human`/
 *    `failed` (US-10), архитектор должен продолжить — обычно
 *    переписать `plan.md` с учётом нового ввода.
 *
 * Логика идентична `runArchitect`, кроме старта: история
 * восстанавливается из `tools.jsonl` + `loop.json` + хвоста по
 * intent через `reconstructHistory`. Запись `loop.json` не
 * повторяется (он уже на диске).
 */
export function registerArchitectResumer(): void {
  registerRoleResumer(ARCHITECT_ROLE, async ({ runId, apiKey, config, events, intent }) => {
    const marker =
      intent.kind === 'answer'
        ? `Resume after VS Code restart, answering tool_call ${intent.pendingToolCallId}`
        : 'Resume by user follow-up message in chat';
    await logResume(runId, marker);

    const initialHistory = reconstructHistory(config, events, intent);

    const resumed = await updateRunStatus(runId, 'running');
    if (resumed) broadcast({ type: 'runs.updated', meta: resumed });

    let outcome: AgentLoopResult;
    try {
      outcome = await runAgentLoop({
        runId,
        apiKey,
        model: config.model,
        systemPrompt: config.systemPrompt,
        userMessage: config.userMessage,
        tools: buildArchitectRegistry(),
        temperature: config.temperature,
        initialHistory,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', reason, iterations: 0 };
    }

    await finalizeArchitectRun(runId, apiKey, outcome);
  });
}

/**
 * Только для тестов — детерминированный доступ к собранному реестру
 * без запуска настоящего цикла. Зеркало одноимённой функции продакта.
 */
export function __test__buildArchitectRegistry(): ToolRegistry {
  return buildArchitectRegistry();
}
