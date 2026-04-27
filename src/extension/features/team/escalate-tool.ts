import * as crypto from 'node:crypto';
import {
  appendChatMessage,
  pullIntoRoom,
  readMeta,
  readSessionMeta,
} from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { HIERARCHY, areAdjacent, rolesBetween, type Role } from '@ext/team/hierarchy';
import { buildRoleStateSnapshot } from '@ext/team/run-snapshot';
import { roleStateFor } from '@ext/entities/run/role-state';
import { createMeetingRequest } from '@ext/entities/run/meeting-request';
import type { ToolDefinition } from '@ext/shared/agent-loop';
import type { ChatMessage, Participant } from '@ext/entities/run/types';

/**
 * Тул `team.escalate` (#0038 + интеграция с meeting-request из #0051).
 *
 * В отличие от `team.invite` (#0037), который работает только между
 * соседями (`product ↔ architect`, `architect ↔ programmer`), escalate
 * нужен ровно для случая «через уровень»: программист зовёт продакта
 * (или наоборот). По правилу команды между ними обязательно должен
 * быть архитектор — escalate сам докидывает все промежуточные уровни
 * в сессию, чтобы цепочка коммуникации не рвалась.
 *
 * #0051: перед `pullIntoRoom` строим snapshot ролей рана и проверяем
 * каждую роль в цепочке (кроме caller'а). Если хотя бы одна не `idle`
 * — не «телепортируем» никого, а создаём ОДИН `MeetingRequest` к
 * `targetRole` с тем же сообщением. Промежуточные роли подтянет резолвер
 * (#0050) при резолве комнаты — он прогоняет `rolesBetween(requester,
 * requestee)` и pullIntoRoom их, если они `idle` к моменту резолва.
 *
 * Если все роли в цепочке `idle` — поведение прежнее:
 *
 * Цепочка собирается ОДИН раз до первого `pullIntoRoom`:
 * `[caller, ...rolesBetween(caller, target), target]`. Это важно для
 * читаемости: потенциальные ошибки на полпути не зависят от того,
 * сколько раз мы пересчитывали цепочку.
 *
 * Сообщение пишется один раз, ПОСЛЕ всех `pullIntoRoom`. Логика —
 * чтобы все приглашённые увидели один и тот же контекст с момента
 * входа в комнату: иначе первый дотащенный посредник увидел бы
 * сообщение раньше конечного адресата, а тот бы прочитал его уже
 * как «старое» сообщение.
 *
 * Если `caller === target` или роли соседние — escalate не нужен:
 * возвращаем ошибку с подсказкой о правильном пути (`team.invite` или
 * прямой ответ).
 */

/** Сообщение об ошибке при попытке эскалировать без необходимости. */
export const ESCALATE_NOT_NEEDED_ERROR =
  'escalate не нужен, используй team.invite или прямой ответ';

/** Аргументы тула, как их видит модель. */
export interface TeamEscalateArgs {
  targetRole: Role;
  message: string;
}

/**
 * Результат тула — discriminated union по `kind` (зеркало
 * `TeamInviteResult`):
 *  - `invited` — все роли в цепочке были `idle`, цепочка собрана,
 *    сообщение записано. `chain` отдаёт полный путь.
 *  - `queued` — кто-то в цепочке был занят, создан meeting-request к
 *    `targetRole`. Промежуточных подтянет резолвер.
 */
export type TeamEscalateResult =
  | {
      kind: 'invited';
      sessionId: string;
      participants: Participant[];
      /**
       * Полная цепочка `[caller, ...between, target]`, по которой шёл
       * escalate. Включает caller'а как первый элемент, чтобы модель
       * могла однозначно понять, кого «довели до комнаты» этим вызовом
       * (caller-то уже был внутри, но семантически он часть цепочки
       * эскалации).
       */
      chain: Role[];
    }
  | {
      kind: 'queued';
      meetingRequestId: string;
      requesteeRole: Role;
    };

/**
 * Построить тул `team.escalate` для конкретной роли-инициатора.
 *
 * Как и в `team.invite`, `caller` хардкодится в замыкании: модель не
 * может «представиться» другой ролью через аргументы. Каждый реестр
 * роли (продакта, архитектора, программиста) собирает свой экземпляр
 * тула.
 */
export function buildTeamEscalateTool(caller: Role): ToolDefinition<TeamEscalateArgs> {
  return {
    name: 'team.escalate',
    description:
      'Эскалировать через уровни иерархии: пригласить целевую роль вместе со всеми ' +
      'промежуточными уровнями (например, programmer→product тащит ещё и architect). ' +
      'Используй, когда между тобой и целевой ролью есть посредник. Для соседей — team.invite. ' +
      'Если хотя бы один из участников цепочки занят, тул создаст meeting-request ' +
      'и поставит тебя на паузу до резолва. Аргументы: targetRole — конечный адресат, ' +
      'message — текст сообщения от тебя, который увидят все приглашённые с момента входа в комнату.',
    schema: {
      type: 'object',
      properties: {
        targetRole: {
          type: 'string',
          enum: [...HIERARCHY],
          description: 'Конечная роль-адресат: product | architect | programmer.',
        },
        message: {
          type: 'string',
          minLength: 1,
          description:
            'Сообщение, которое увидят все приглашённые. Пишется один раз после того, ' +
            'как все участники цепочки добавлены в комнату.',
        },
      },
      required: ['targetRole', 'message'],
      additionalProperties: false,
    },
    handler: async ({ targetRole, message }, { runId }) =>
      escalateHandler(runId, caller, targetRole, message),
  };
}

/**
 * Тело handler'а вынесено отдельно, чтобы тесты могли звать его
 * напрямую, не дёргая весь tool-loop. Шаги:
 *  1) защита от ненужного escalate (`caller === target` либо соседи);
 *  2) построить цепочку (один раз, до проверки snapshot'а);
 *  3) #0051 — проверить занятость каждой роли цепочки кроме caller'а;
 *     если хотя бы одна занята → создать единственный meeting-request
 *     к targetRole, вернуть queued;
 *  4) иначе — поочерёдно `pullIntoRoom` для каждой роли цепочки кроме
 *     caller'а, записать `message` от имени caller'а в сессию;
 *  5) вернуть актуальный snapshot участников + цепочку.
 */
async function escalateHandler(
  runId: string,
  caller: Role,
  targetRole: Role,
  message: string
): Promise<TeamEscalateResult> {
  // Защита от ненужного escalate. Условия объединены в одно бросание,
  // потому что текст подсказки одинаков: модель должна понять, что в
  // её случае escalate — не тот инструмент.
  //
  // areAdjacent уже возвращает false для `caller === target` (см.
  // hierarchy.ts), поэтому проверяем его отдельно: для одинаковых
  // ролей areAdjacent тоже false, что в `team.invite` корректно
  // означает «нельзя пригласить себя», а здесь означало бы, наоборот,
  // «escalate уместен» — что неверно. Поэтому явная проверка `===`.
  if (caller === targetRole || areAdjacent(caller, targetRole)) {
    throw new Error(ESCALATE_NOT_NEEDED_ERROR);
  }

  const meta = await readMeta(runId);
  if (!meta) {
    // Аналогично `team.invite`: runId, которого нет на диске — баг
    // вызывающего кода (agent-loop передал id рана, который успели
    // удалить). Бросаем явной ошибкой, не маскируем.
    throw new Error(`Ран ${runId} не найден`);
  }
  const sessionId = meta.activeSessionId;

  // Цепочка считается ОДИН раз — до первого pullIntoRoom. Если
  // посредине что-то изменится (хотя на этом уровне нечему: HIERARCHY
  // — readonly константа), результат не «съедет» из-за пересчёта.
  // caller включён в цепочку первым элементом для согласованности
  // возвращаемого `chain` (см. описание TeamEscalateResult).
  const chain: Role[] = [caller, ...rolesBetween(caller, targetRole), targetRole];

  // #0051: проверяем все роли цепочки кроме caller'а. Если ХОТЯ БЫ
  // одна не idle — escalate уходит в очередь meeting-request'ов.
  // Адресат заявки — конечный target, посредников подтянет резолвер
  // (см. meeting-resolver.ts, шаг pullIntermediates).
  const snapshot = await buildRoleStateSnapshot(runId);
  const someoneBusy = chain.some((role) => {
    if (role === caller) return false;
    return roleStateFor(role, snapshot).kind !== 'idle';
  });
  if (someoneBusy) {
    const request = await createMeetingRequest(runId, {
      requesterRole: caller,
      requesteeRole: targetRole,
      contextSessionId: sessionId,
      message,
    });
    return {
      kind: 'queued',
      meetingRequestId: request.id,
      requesteeRole: targetRole,
    };
  }

  // Тащим в комнату всех, кроме caller'а — он уже там по построению
  // (escalate вызывается из его tool-loop'а, в его активной сессии).
  // pullIntoRoom идемпотентен: если посредник уже добавлен прошлым
  // escalate/invite — no-op без события и без broadcast'а.
  for (const role of chain) {
    if (role === caller) continue;
    const updated = await pullIntoRoom(runId, sessionId, role);
    if (updated) {
      broadcast({ type: 'runs.updated', meta: updated });
    }
  }

  // Сообщение пишется ровно один раз, после всех pullIntoRoom — чтобы
  // у всех приглашённых был одинаковый стартовый контекст: они видят
  // первое сообщение от caller'а уже внутри полной комнаты, а не
  // «частично собранной».
  const chatMessage: ChatMessage = {
    id: crypto.randomBytes(6).toString('hex'),
    from: `agent:${caller}`,
    at: new Date().toISOString(),
    text: message,
  };
  await appendChatMessage(runId, chatMessage, sessionId);
  broadcast({ type: 'runs.message.appended', runId, sessionId, message: chatMessage });

  // Финальный snapshot читаем из session-meta, а не накапливаем по
  // ходу цикла: на повторных escalate (или при пересечении с invite)
  // часть pullIntoRoom возвращает undefined, и собрать participants
  // «из ответов» невозможно. Контракт результата должен быть
  // стабильным независимо от ветки.
  const finalSession = await readSessionMeta(runId, sessionId);
  return {
    kind: 'invited',
    sessionId,
    participants: finalSession?.participants ?? [],
    chain,
  };
}
