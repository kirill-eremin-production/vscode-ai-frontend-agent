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
  readMeta,
  readPlan,
  updateRunStatus,
  writeLoopConfig,
  writeSummary,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { registerRoleResumer } from '@ext/entities/run/resume-registry';
import {
  PROGRAMMER_MAX_ITERATIONS,
  PROGRAMMER_MODEL,
  PROGRAMMER_ROLE,
} from '@ext/entities/run/roles/programmer';
import { buildProgrammerSystemPrompt } from '@ext/entities/run/roles/programmer.prompt';
import { buildRoleScopedKbTools } from '@ext/features/product-role/role-kb-tools';
import { buildTeamEscalateTool, buildTeamInviteTool } from '@ext/features/team';
import { buildWorkspaceFsTools, getWorkspaceRootOrThrow } from './workspace-fs-tools';

/**
 * Сервисный слой роли программиста (issue #0027).
 *
 * Зеркало [architect-role/run.ts](../architect-role/run.ts) с двумя
 * отличиями:
 *  - реестр тулов: role-scoped kb + `fs.*` (workspace) + `ask_user` +
 *    `writeSummary` (специальный финализирующий тул);
 *  - финализация рана происходит **изнутри тула** `writeSummary`:
 *    модель кладёт текст summary в его аргументы, тул сохраняет файл
 *    через `storage.writeSummary` и переводит ран в `awaiting_human`.
 *    Это сознательный выбор: финальный assistant-ответ программиста
 *    «текстом» был бы лишним шумом — пользователю важен `summary.md`,
 *    а не «вот, я закончил» в чате.
 *
 * Старт — автоматически после успеха архитектора:
 * `runArchitect.finalizeArchitectRun` дёргает `runProgrammer`, передавая
 * runId + apiKey. Первое user-сообщение — содержимое `plan.md`.
 */

/** Контейнер для состояния «программист уже зафиналил ран через writeSummary». */
interface ProgrammerRunState {
  finalized: boolean;
}

/**
 * Построить специальный тул `writeSummary`. Он не «инструмент» в
 * смысле получения данных — это финализатор роли:
 *  1) пишет `summary.md` через `storage.writeSummary`;
 *  2) дублирует превью в чат от имени программиста;
 *  3) переводит ран в `awaiting_human`;
 *  4) ставит `state.finalized = true`, чтобы внешний код не пытался
 *     повторно интерпретировать выход цикла как фейл.
 *
 * Возвращает модели короткое подтверждение — модель после этого, как
 * правило, тут же завершит работу пустым assistant.content. Если же
 * она почему-то продолжит вызывать тулы — это неважно: ран уже
 * `awaiting_human`, дальнейшие шаги просто пишутся в tools.jsonl,
 * пока loop не упрётся в лимит итераций (защитный потолок).
 */
function buildWriteSummaryTool(state: ProgrammerRunState): ToolDefinition<{ content: string }> {
  return {
    name: 'writeSummary',
    description:
      'Финализировать ран программиста: записать summary.md и завершить роль. ' +
      'Аргумент content — полный markdown summary (по структуре из system prompt). ' +
      'Вызывать только когда все подзадачи плана либо выполнены, либо явно перечислены ' +
      'как невыполненные. После этого вызова не нужно слать дополнительный assistant-ответ.',
    schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          description: 'Полный текст summary.md',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: async ({ content }, ctx) => {
      const meta = await readMeta(ctx.runId);
      const { run, summaryPath } = await writeSummary(
        ctx.runId,
        meta?.title ?? 'untitled',
        content
      );
      const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
      await appendProgrammerChatMessage(ctx.runId, preview);
      const updated = await updateRunStatus(ctx.runId, 'awaiting_human');
      if (updated) broadcast({ type: 'runs.updated', meta: updated });
      else if (run) broadcast({ type: 'runs.updated', meta: run });
      state.finalized = true;
      return { ok: true, summaryPath };
    },
  };
}

/** Реестр тулов программиста: kb (role-scoped) + fs (workspace) + ask_user + writeSummary. */
function buildProgrammerRegistry(workspaceRoot: string, state: ProgrammerRunState): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of buildRoleScopedKbTools(PROGRAMMER_ROLE)) {
    registry.set(tool.name, tool);
  }
  for (const tool of buildWorkspaceFsTools(workspaceRoot)) {
    registry.set(tool.name, tool);
  }
  registry.set(askUserTool.name, askUserTool as ToolDefinition);
  // team.invite (#0037): программист может позвать соседа по иерархии
  // (architect). Через уровень — сам тул вернёт ошибку с подсказкой
  // про team.escalate (#0038).
  const inviteTool = buildTeamInviteTool(PROGRAMMER_ROLE);
  registry.set(inviteTool.name, inviteTool as ToolDefinition);
  // team.escalate (#0038): программисту через уровень — продакт.
  // Тул сам докинет архитектора как промежуточную роль, чтобы
  // цепочка коммуникации не рвалась.
  const escalateTool = buildTeamEscalateTool(PROGRAMMER_ROLE);
  registry.set(escalateTool.name, escalateTool as ToolDefinition);
  const writeSummaryTool = buildWriteSummaryTool(state);
  registry.set(writeSummaryTool.name, writeSummaryTool as ToolDefinition);
  return registry;
}

/** Имена тулов для `loop.json` (диагностика, совместимость с общим форматом). */
function programmerToolNames(): string[] {
  return [
    'kb.read',
    'kb.write',
    'kb.list',
    'kb.grep',
    'fs.read',
    'fs.write',
    'fs.list',
    'fs.grep',
    askUserTool.name,
    'team.invite',
    'team.escalate',
    'writeSummary',
  ];
}

/** Сообщение в чат от имени программиста. */
async function appendProgrammerChatMessage(runId: string, text: string): Promise<void> {
  const message = {
    id: crypto.randomBytes(6).toString('hex'),
    from: `agent:${PROGRAMMER_ROLE}`,
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
 * Завершение цикла программиста.
 *
 * Главный успех — `state.finalized = true`: тул `writeSummary` уже
 * сделал всё, что нужно (записал файл, обновил статус, broadcast'нул).
 * В этом случае мы только убеждаемся, что в чате не осталось тревожных
 * follow-up'ов от модели.
 *
 * Все остальные исходы (loop вернул `completed` без вызова writeSummary,
 * loop вернул `failed`) — фейл роли. Программисту нечего «отдать
 * пользователю текстом»: целевой артефакт — summary.md, и без него
 * пользователь не получает понятной картинки изменений.
 */
async function finalizeProgrammerRun(
  runId: string,
  outcome: AgentLoopResult,
  state: ProgrammerRunState
): Promise<void> {
  if (state.finalized) return;

  if (outcome.kind === 'completed') {
    await appendSystemChatMessage(
      runId,
      'Программист закончил без вызова `writeSummary` — финальный артефакт summary.md не создан. ' +
        'Скорее всего, модель сорвалась с правил prompt’а: проверь tools.jsonl или перезапусти роль.'
    );
    const failed = await updateRunStatus(runId, 'failed');
    if (failed) broadcast({ type: 'runs.updated', meta: failed });
    return;
  }

  await appendSystemChatMessage(runId, `Программист упал: ${outcome.reason}`);
  const failed = await updateRunStatus(runId, 'failed');
  if (failed) broadcast({ type: 'runs.updated', meta: failed });
}

/**
 * Достать `plan.md` для подачи программисту первым user-сообщением.
 * При пустом плане — маркерное сообщение, чтобы цикл всё-таки стартовал
 * и мог через `ask_user` запросить ручной ввод (мотив тот же, что в
 * `loadBriefAsUserMessage` у архитектора).
 */
async function loadPlanAsUserMessage(runId: string): Promise<string> {
  const plan = await readPlan(runId);
  if (plan && plan.trim().length > 0) return plan;
  return [
    '[Системное предупреждение: plan.md рана пустой или отсутствует.',
    'Это значит, что архитектор не успел финализироваться или артефакт',
    'удалили вручную. Сообщи об этом пользователю через `ask_user` и',
    'попроси либо перезапустить архитектора, либо передать план вручную.',
    'Не выдумывай содержание плана.]',
  ].join(' ');
}

/**
 * Запустить программиста на ране. Вызывается из success-ветки
 * `runArchitect.finalizeArchitectRun` — fire-and-forget. Прогресс
 * уходит в webview через broadcast.
 *
 * Любые исключения внутри `runAgentLoop` ловятся им же и превращаются
 * в `kind: 'failed'`. Внешний try/catch — на случай экзотики (нет
 * workspace, fs сломан), иначе ран навсегда остался бы в `running`.
 */
export async function runProgrammer(params: { runId: string; apiKey: string }): Promise<void> {
  const systemPrompt = buildProgrammerSystemPrompt();
  const userMessage = await loadPlanAsUserMessage(params.runId);
  const workspaceRoot = getWorkspaceRootOrThrow();
  const state: ProgrammerRunState = { finalized: false };

  await writeLoopConfig(params.runId, {
    model: PROGRAMMER_MODEL,
    systemPrompt,
    toolNames: programmerToolNames(),
    userMessage,
    role: PROGRAMMER_ROLE,
  });

  const updated = await updateRunStatus(params.runId, 'running');
  if (updated) broadcast({ type: 'runs.updated', meta: updated });

  let outcome: AgentLoopResult;
  try {
    outcome = await runAgentLoop({
      runId: params.runId,
      apiKey: params.apiKey,
      model: PROGRAMMER_MODEL,
      systemPrompt,
      userMessage,
      tools: buildProgrammerRegistry(workspaceRoot, state),
      maxIterations: PROGRAMMER_MAX_ITERATIONS,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcome = { kind: 'failed', reason, iterations: 0 };
  }

  await finalizeProgrammerRun(params.runId, outcome, state);
}

/**
 * Resumer программиста. Регистрируется один раз в `activate` —
 * поднимает ран по `answer` (ответ на pending ask_user) и `continue`
 * (новое сообщение пользователя в `awaiting_human`/`failed`).
 *
 * Логика идентична `runProgrammer` — кроме того, что история
 * восстанавливается из `tools.jsonl` через `reconstructHistory`, а
 * `loop.json` уже на диске, повторно его не пишем.
 */
export function registerProgrammerResumer(): void {
  registerRoleResumer(PROGRAMMER_ROLE, async ({ runId, apiKey, config, events, intent }) => {
    const marker =
      intent.kind === 'answer'
        ? `Resume after VS Code restart, answering tool_call ${intent.pendingToolCallId}`
        : 'Resume by user follow-up message in chat';
    await logResume(runId, marker);

    const initialHistory = reconstructHistory(config, events, intent);
    const workspaceRoot = getWorkspaceRootOrThrow();
    const state: ProgrammerRunState = { finalized: false };

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
        tools: buildProgrammerRegistry(workspaceRoot, state),
        temperature: config.temperature,
        initialHistory,
        maxIterations: PROGRAMMER_MAX_ITERATIONS,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', reason, iterations: 0 };
    }

    await finalizeProgrammerRun(runId, outcome, state);
  });
}

/**
 * Только для тестов — детерминированный доступ к собранному реестру
 * без запуска настоящего цикла. Зеркало `__test__buildArchitectRegistry`.
 */
export function __test__buildProgrammerRegistry(workspaceRoot: string): ToolRegistry {
  const state: ProgrammerRunState = { finalized: false };
  return buildProgrammerRegistry(workspaceRoot, state);
}
