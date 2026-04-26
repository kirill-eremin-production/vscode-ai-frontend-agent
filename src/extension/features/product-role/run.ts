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
  updateRunStatus,
  writeBrief,
  writeLoopConfig,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { registerRoleResumer } from '@ext/entities/run/resume-registry';
import { PRODUCT_MODEL, PRODUCT_ROLE } from '@ext/entities/run/roles/product';
import { buildProductSystemPrompt } from '@ext/entities/run/roles/product.prompt';
import { buildRoleScopedKbTools } from './role-kb-tools';

/**
 * Сервисный слой роли «продакт».
 *
 * Что делает:
 *  - запускает `runAgentLoop` поверх продактовых тулов и system prompt'а;
 *  - сохраняет `loop.json` ДО старта цикла (иначе перезапуск VS Code
 *    в момент первого запроса оставит ран без шансов на resume);
 *  - финализирует ран: пишет финальный текст модели в `brief.md`,
 *    дублирует превью в `chat.jsonl`, переводит статус `awaiting_human`.
 *  - регистрирует resumer (см. `registerProductResumer`), который
 *    делает то же самое для рана, чей in-memory loop умер вместе с
 *    extension host'ом.
 *
 * Чего НЕ делает:
 *  - не управляет ключом OpenRouter — это забота вызывающего
 *    (`createRun` уже проверил ключ, прежде чем создать ран).
 *  - не блокирует UI: вызывается fire-and-forget из `service.createRun`,
 *    прогресс приходит в webview через `broadcast`.
 */

/** Продактовая регистрационная пара кода: токены сборки реестра тулов. */
function buildProductRegistry(): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of buildRoleScopedKbTools(PRODUCT_ROLE)) {
    registry.set(tool.name, tool);
  }
  registry.set(askUserTool.name, askUserTool as ToolDefinition);
  return registry;
}

/** Имена тулов для записи в `loop.json` (используется при resume). */
function productToolNames(): string[] {
  // Имена не зависят от обёртки — они одинаковые что у общих kb-тулов,
  // что у role-scoped версий. resumer пересоберёт реестр через
  // `buildProductRegistry`, не сверяясь с этим списком (он там для
  // диагностики/совместимости с общим форматом loop.json).
  return ['kb.read', 'kb.write', 'kb.list', 'kb.grep', askUserTool.name];
}

/**
 * Сообщение в чат от имени продакта. Уникальный id — для стабильного
 * React-ключа в UI; broadcast — чтобы открытая карточка рана сразу
 * увидела сообщение, без `runs.get` round-trip'а.
 */
async function appendProductChatMessage(runId: string, text: string): Promise<void> {
  const message = {
    id: crypto.randomBytes(6).toString('hex'),
    from: `agent:${PRODUCT_ROLE}`,
    at: new Date().toISOString(),
    text,
  };
  await appendChatMessage(runId, message);
  broadcast({ type: 'runs.message.appended', runId, message });
}

/** Системное сообщение в чат — для диагностики фейлов и т.п. */
async function appendSystemChatMessage(runId: string, text: string): Promise<void> {
  const message = {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'agent:system',
    at: new Date().toISOString(),
    text,
  };
  await appendChatMessage(runId, message);
  broadcast({ type: 'runs.message.appended', runId, message });
}

/**
 * Завершение цикла: либо успех (модель отдала текст брифа), либо фейл.
 * Вынесено в отдельную функцию, потому что делается и при первичном
 * запуске, и в resumer — код был бы полностью идентичный.
 *
 * Превью брифа в чате: первые 600 символов, чтобы карточка рана не
 * раздулась длинной markdown-простыней. Полная версия лежит в `brief.md`
 * (UI рендерит её отдельной секцией).
 */
async function finalizeRun(runId: string, outcome: AgentLoopResult): Promise<void> {
  if (outcome.kind === 'completed') {
    const brief = outcome.finalContent.trim();
    if (brief.length === 0) {
      // Модель закончила без текста — это формально «success» от loop'а,
      // но семантически — фейл роли. Без brief нечего ни сохранять, ни
      // показывать архитектору. Помечаем ран failed и пишем диагностику.
      await appendSystemChatMessage(
        runId,
        "Продакт закончил без текста брифа — finish_reason=stop без assistant.content. Скорее всего, модель не справилась с правилами prompt'а; запусти ран заново или проверь логи в tools.jsonl."
      );
      const failed = await updateRunStatus(runId, 'failed');
      if (failed) broadcast({ type: 'runs.updated', meta: failed });
      return;
    }

    await writeBrief(runId, brief);
    const preview = brief.length > 600 ? `${brief.slice(0, 600)}…` : brief;
    await appendProductChatMessage(runId, preview);
    const updated = await updateRunStatus(runId, 'awaiting_human');
    if (updated) broadcast({ type: 'runs.updated', meta: updated });
    return;
  }

  // kind === 'failed' — diagnostics уже лежат в tools.jsonl от loop'а;
  // в чат добавляем человекочитаемое сообщение, чтобы пользователь
  // видел причину, не открывая лог.
  await appendSystemChatMessage(runId, `Продакт упал: ${outcome.reason}`);
  const failed = await updateRunStatus(runId, 'failed');
  if (failed) broadcast({ type: 'runs.updated', meta: failed });
}

/**
 * Запустить продакта на новом ране. Fire-and-forget: возвращает
 * Promise, но вызывающий код (createRun) его не await'ит — UI должен
 * получить созданный ран сразу, прогресс роли — асинхронно через
 * broadcast.
 *
 * Любые исключения внутри лоопа уже ловятся `runAgentLoop` и
 * превращаются в `kind: 'failed'`. Здесь дополнительный try/catch
 * только на случай совсем экзотического сбоя (сломанный fs, и т.п.) —
 * иначе ран остался бы навсегда в `running` без шанса на resume.
 */
export async function runProduct(params: {
  runId: string;
  apiKey: string;
  prompt: string;
}): Promise<void> {
  const systemPrompt = buildProductSystemPrompt();

  // loop.json — ДО первого запроса к модели. Если перезапуск VS Code
  // случится прямо во время первого `chat()`, resume не сможет
  // восстановить роль без этого файла.
  await writeLoopConfig(params.runId, {
    model: PRODUCT_MODEL,
    systemPrompt,
    toolNames: productToolNames(),
    userMessage: params.prompt,
    role: PRODUCT_ROLE,
  });

  const updated = await updateRunStatus(params.runId, 'running');
  if (updated) broadcast({ type: 'runs.updated', meta: updated });

  let outcome: AgentLoopResult;
  try {
    outcome = await runAgentLoop({
      runId: params.runId,
      apiKey: params.apiKey,
      model: PRODUCT_MODEL,
      systemPrompt,
      userMessage: params.prompt,
      tools: buildProductRegistry(),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', reason, iterations: 0 };
  }

  await finalizeRun(params.runId, outcome);
}

/**
 * Зарегистрировать resumer продакта. Вызывается один раз в `activate`
 * и срабатывает по двум сценариям (см. ResumeIntent):
 *
 *  - `answer` — пользователь ответил на pending `ask_user`, а
 *    in-memory цикл уже умер (перезапуск VS Code на
 *    `awaiting_user_input` либо новый extension host вообще).
 *  - `continue` — пользователь дослал новое сообщение в
 *    `awaiting_human`/`failed` (US-10), и продакт должен продолжить
 *    работу: переоткрыть цикл с накопленной историей + новым user-message,
 *    обычно перезаписать `brief.md`.
 *
 * Логика идентична `runProduct`, кроме старта: история восстанавливается
 * из `tools.jsonl` + `loop.json` + хвоста по intent через
 * `reconstructHistory`. Запись `loop.json` не повторяется (он уже на
 * диске с прошлой сессии).
 */
export function registerProductResumer(): void {
  registerRoleResumer(PRODUCT_ROLE, async ({ runId, apiKey, config, events, intent }) => {
    // Маркер в tools.jsonl — для людей, разбирающих лог. Видна точка,
    // в которой произошёл resume и по какой причине.
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
        tools: buildProductRegistry(),
        temperature: config.temperature,
        initialHistory,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', reason, iterations: 0 };
    }

    await finalizeRun(runId, outcome);
  });
}

/**
 * Используется только для тестов — даёт детерминированный доступ к
 * собранному реестру без необходимости запускать настоящий цикл.
 * Прод-код реестр строит сам внутри `runProduct`/resumer.
 */
export function __test__buildProductRegistry(): ToolRegistry {
  return buildProductRegistry();
}
