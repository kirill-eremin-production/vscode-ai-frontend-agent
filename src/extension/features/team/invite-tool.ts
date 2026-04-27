import * as crypto from 'node:crypto';
import {
  appendChatMessage,
  pullIntoRoom,
  readMeta,
  readSessionMeta,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { broadcastPendingRequests } from '@ext/features/run-management/pending-requests';
import { HIERARCHY, areAdjacent, type Role } from '@ext/team/hierarchy';
import { buildRoleStateSnapshot } from '@ext/team/run-snapshot';
import { roleStateFor } from '@ext/entities/run/role-state';
import { createMeetingRequest } from '@ext/entities/run/meeting-request';
import type { ToolDefinition } from '@ext/shared/agent-loop';
import type { ChatMessage, Participant } from '@ext/entities/run/types';

/**
 * Тул `team.invite` (#0037 + интеграция с meeting-request из #0051).
 *
 * Простой случай добавления участника: `architect ↔ product` или
 * `programmer ↔ architect`. Через уровень — нельзя, для этого
 * `team.escalate` (#0038): возвращаем подсказку, чтобы модель сразу
 * нашла правильный путь.
 *
 * #0051: перед `pullIntoRoom` проверяем `roleStateFor(targetRole)` —
 * если адресат сейчас не `idle`, не «телепортируем» его в свою комнату,
 * а создаём `MeetingRequest` (#0049). Тул возвращает `{kind: 'queued',
 * meetingRequestId}`, agent-loop ловит этот discriminator и ставит
 * инициатора на паузу. Резолвер (#0050) поднимет встречу, когда
 * адресат освободится, и разбудит инициатора через `notifyMeetingWakeup`.
 *
 * Если адресат `idle` — поведение прежнее:
 *  1) `pullIntoRoom(currentSessionId, targetRole)` (#0036) — добавляет
 *     участника и пишет системное событие `participant_joined`
 *     (идемпотентно: повторный invite той же роли — no-op для участников,
 *     событие в этом случае не дублируется).
 *  2) `appendChatMessage` — кладёт `message` от имени `caller`. Текст
 *     — то, что модель хочет сказать только что приглашённому. Это
 *     корректно идёт в чат даже на втором invite той же роли: повторный
 *     invite — это просто новый месседж в комнату.
 *
 * `caller` фиксируется при сборке тула в реестре роли (см. `runArchitect`,
 * `runProduct`, `runProgrammer`): передавать его аргументом модели было
 * бы дырой — модель могла бы выдать себя за другую роль.
 */

/** Сообщение об ошибке при попытке пригласить через уровень. */
export const INVITE_THROUGH_LEVEL_ERROR =
  'Нельзя пригласить через уровень. Используй team.escalate(targetRole, message)';

/** Аргументы тула, как их видит модель. */
export interface TeamInviteArgs {
  targetRole: Role;
  message: string;
}

/**
 * Результат тула — discriminated union по `kind`:
 *  - `invited` — обычный путь, адресат был `idle`, его подтянули в
 *    комнату и записали сообщение. Модель видит снэпшот участников и
 *    может продолжать работу.
 *  - `queued` — адресат был занят, создан meeting-request. Модель
 *    видит идентификатор заявки и роль адресата, agent-loop сам
 *    остановит цикл (см. `loop.ts`, ветка `paused`).
 */
export type TeamInviteResult =
  | {
      kind: 'invited';
      sessionId: string;
      participants: Participant[];
    }
  | {
      kind: 'queued';
      meetingRequestId: string;
      requesteeRole: Role;
    };

/**
 * Построить тул `team.invite` для конкретной роли-инициатора.
 *
 * Тул хардкодит `caller` в замыкании: модель не может «поменять» его
 * аргументом. Поэтому каждый реестр роли (продакта, архитектора,
 * программиста) собирает свой экземпляр тула.
 */
export function buildTeamInviteTool(caller: Role): ToolDefinition<TeamInviteArgs> {
  return {
    name: 'team.invite',
    description:
      'Пригласить соседнего по иерархии агента в текущую сессию и оставить ему сообщение. ' +
      'Соседи: product↔architect, architect↔programmer. Через уровень нельзя — ' +
      'используй team.escalate. Если адресат сейчас занят, тул создаст meeting-request ' +
      'и поставит тебя на паузу до его освобождения. Аргументы: targetRole — роль ' +
      'приглашаемого, message — текст сообщения от тебя, который увидит приглашённый ' +
      'и остальные участники (или дойдёт первым сообщением в новую комнату при пробуждении).',
    schema: {
      type: 'object',
      properties: {
        targetRole: {
          type: 'string',
          enum: [...HIERARCHY],
          description: 'Роль приглашаемого агента: product | architect | programmer.',
        },
        message: {
          type: 'string',
          minLength: 1,
          description: 'Сообщение приглашаемому. Попадает в чат сессии от твоего имени.',
        },
      },
      required: ['targetRole', 'message'],
      additionalProperties: false,
    },
    handler: async ({ targetRole, message }, { runId }) =>
      inviteHandler(runId, caller, targetRole, message),
  };
}

/**
 * Тело handler'а вынесено отдельно, чтобы тесты могли звать его напрямую,
 * не дёргая весь tool-loop. Шаги:
 *  1) валидация — нельзя через уровень / самого себя (та же ветка
 *     ошибки, см. `INVITE_THROUGH_LEVEL_ERROR`);
 *  2) snapshot ролевых состояний рана; если targetRole не `idle` —
 *     создаём meeting-request, возвращаем queued;
 *  3) иначе — обычный invite: pullIntoRoom + appendChatMessage.
 */
async function inviteHandler(
  runId: string,
  caller: Role,
  targetRole: Role,
  message: string
): Promise<TeamInviteResult> {
  // areAdjacent вернёт false и для `caller === targetRole` (нельзя
  // пригласить самого себя), и для пары через уровень — оба случая
  // отсекаем одинаково: подсказываем модели правильный путь через
  // `team.escalate`. Текст ошибки буквальный: модель будет читать его
  // как `tool_result.error` и должна узнать в нём конкретное действие.
  if (!areAdjacent(caller, targetRole)) {
    throw new Error(INVITE_THROUGH_LEVEL_ERROR);
  }

  const meta = await readMeta(runId);
  if (!meta) {
    // runId, которого нет на диске — всегда баг вызывающего кода
    // (agent-loop передал id рана, который успели удалить). Бросаем
    // по тому же принципу, что и `getActiveSessionIdOrThrow`.
    throw new Error(`Ран ${runId} не найден`);
  }
  const sessionId = meta.activeSessionId;

  // #0051: snapshot строим один раз. Если targetRole сейчас `busy` или
  // `awaiting_input` — переходим на queued-ветку. `idle` — обычный invite.
  const snapshot = await buildRoleStateSnapshot(runId);
  const targetState = roleStateFor(targetRole, snapshot);
  if (targetState.kind !== 'idle') {
    const request = await createMeetingRequest(runId, {
      requesterRole: caller,
      requesteeRole: targetRole,
      contextSessionId: sessionId,
      message,
    });
    // #0052: pending-список изменился — толкаем live-обновление в UI,
    // чтобы paused-кубик инициатора и inbox в MeetingsPanel загорелись
    // мгновенно, без отдельного `runs.get`. Не await'им: broadcast —
    // best-effort, его сбой не должен валить tool-handler.
    void broadcastPendingRequests(runId);
    return {
      kind: 'queued',
      meetingRequestId: request.id,
      requesteeRole: targetRole,
    };
  }

  // pullIntoRoom идемпотентен: undefined ⇒ targetRole уже в участниках.
  // В этом случае событие `participant_joined` не пишется и broadcast
  // `runs.updated` тоже не нужен (состав не изменился). Сообщение всё
  // равно записываем — повторный invite корректно интерпретируем как
  // «новый месседж в ту же комнату», см. AC #0037.
  const updated = await pullIntoRoom(runId, sessionId, targetRole);
  if (updated) {
    broadcast({ type: 'runs.updated', meta: updated });
  }

  const chatMessage: ChatMessage = {
    id: crypto.randomBytes(6).toString('hex'),
    from: `agent:${caller}`,
    at: new Date().toISOString(),
    text: message,
  };
  await appendChatMessage(runId, chatMessage, sessionId);
  broadcast({ type: 'runs.message.appended', runId, sessionId, message: chatMessage });

  // Возвращаем актуальный состав participants — модели полезно увидеть,
  // кто теперь в комнате (включая её саму и user'а, если он есть). Читаем
  // session-meta заново вместо использования updated?.sessions, потому что
  // на повторном invite updated === undefined, а контракт результата
  // должен быть стабильным независимо от ветки.
  const finalSession = await readSessionMeta(runId, sessionId);
  return {
    kind: 'invited',
    sessionId,
    participants: finalSession?.participants ?? [],
  };
}
