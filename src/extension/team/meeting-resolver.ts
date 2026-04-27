/**
 * Координатор встреч (#0050).
 *
 * Когда занятая роль освободилась, system-уровень должен посмотреть на
 * pending meeting-requests к ней и поднять самый старый в новую сессию-
 * комнату. Параллельно ловим простейшие deadlock'и: если две роли
 * одновременно зовут друг друга на встречу (A→B и B→A pending), обе
 * заявки помечаем `failed` — никто не сможет первым ответить, ждать
 * друг друга бессмысленно.
 *
 * Жизненный цикл:
 *  1) `resolvePending(runId)` дёргается на двух триггерах:
 *     - при активации расширения (`index.ts/activate`) — чтобы поднять
 *       заявки, оставшиеся pending после рестарта VS Code;
 *     - при изменении статуса любой сессии (`storage.setSessionStatus`,
 *       lazy-импорт) — это и есть сигнал «возможно, кто-то освободился».
 *  2) **Не** вызывается на каждом сообщении: на сообщении состояние
 *     роли может меняться (busy/idle), но это синхронизируется на
 *     следующем status-event'е. Иначе одна reply-message превратится
 *     в каскад резолва, который сложно отлаживать.
 *
 * Контракт результата ({@link ResolveResult}):
 *  - `resolved`  — заявка переведена в `resolved`, создана новая сессия-
 *                  комната, в неё уже записано `message` инициатора.
 *  - `failed`    — заявка переведена в `failed` (на этой итерации только
 *                  по deadlock'у; будущие правила #0051 могут добавить
 *                  свои причины).
 *  - `still_pending` — заявка осталась pending: либо адресат сейчас
 *                  занят, либо это «не самая старая» заявка к этому
 *                  адресату (она ждёт за более ранней).
 *
 * Race-conditions: на этой итерации специально не закладываемся (#0050,
 * Implementation notes). Все операции последовательные внутри одного
 * вызова resolvePending; параллельных писателей не предполагается, пока
 * agent-loop'ы по разным ранам не начнут работать одновременно.
 */

import * as crypto from 'node:crypto';
import {
  appendChatMessage,
  createSession,
  pullIntoRoom,
  setActiveSession,
} from '../entities/run/storage';
import { broadcast } from '../features/run-management/broadcast';
import { broadcastPendingRequests } from '../features/run-management/pending-requests';
import {
  getPendingRequests,
  updateMeetingRequestStatus,
  type MeetingRequest,
} from '../entities/run/meeting-request';
import { roleStateFor, type RoleStateRunSnapshot } from '../entities/run/role-state';
import { rolesBetween, type Role } from './hierarchy';
import { buildRoleStateSnapshot } from './run-snapshot';
import { notifyMeetingWakeup } from './meeting-wakeup';

/**
 * Что произошло с конкретной заявкой за один проход resolver'а.
 *
 * Discriminated union, чтобы тестам и логам было легко различать
 * ветки и не ловить «строковые опечатки» статуса.
 */
export type ResolveResult =
  | { kind: 'resolved'; requestId: string; sessionId: string }
  | { kind: 'failed'; requestId: string; reason: string }
  | { kind: 'still_pending'; requestId: string; reason: string };

/**
 * Прогон координатора по всему рану.
 *
 * Шаги:
 *  1) Берём pending-заявки. Если их нет — выходим (быстрый путь, не
 *     читаем сессии впустую).
 *  2) Detect deadlocks. Идём по парам (A→B, B→A) среди pending'ов и
 *     помечаем обе `failed` с одинаковой причиной. Это надо сделать
 *     ДО snapshot'а ролей: иначе какая-нибудь из «зажатых» ролей всё
 *     ещё показывала бы `awaiting_input` и блокировала резолв чужих
 *     заявок к ней.
 *  3) Для каждой роли-адресата берём САМУЮ СТАРУЮ из оставшихся pending
 *     (`createdAt`). UX-инвариант (`#0048` US-47): «роль ждёт первый,
 *     заблокировавший её»; новые встают за ним.
 *  4) Если адресат `idle` — резолвим: создаём agent-agent комнату с
 *     участниками `[requesterRole, requesteeRole]`, prev указывает на
 *     контекст-сессию инициатора, и пишем `message` инициатора первым
 *     сообщением. Затем переводим заявку в `resolved` с
 *     `resolvedSessionId`.
 *  5) Один проход — один резолв на роль-адресата. После резолва эта
 *     роль становится busy в новой сессии (мы только что обратились
 *     к ней), поэтому ставить ей вторую встречу в этом же проходе
 *     нельзя. Дальнейшие заявки ждут до следующего триггера, когда
 *     эта новая сессия завершится.
 */
export async function resolvePending(runId: string): Promise<ResolveResult[]> {
  const initialPending = await getPendingRequests(runId);
  if (initialPending.length === 0) return [];

  const results: ResolveResult[] = [];
  const handled = new Set<string>();

  // Сортируем стабильно по createdAt: и для предсказуемости пар при
  // deadlock-detection (возьмём самую старую как «A»), и для шага 3.
  const sortedByCreated = [...initialPending].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );

  // Шаг 2: deadlocks. O(N^2) допустимо: realистично N ≤ 3 (по числу
  // ролей в иерархии #0033).
  for (const requestA of sortedByCreated) {
    if (handled.has(requestA.id)) continue;
    const reverse = sortedByCreated.find(
      (other) =>
        other.id !== requestA.id &&
        !handled.has(other.id) &&
        other.requesterRole === requestA.requesteeRole &&
        other.requesteeRole === requestA.requesterRole
    );
    if (!reverse) continue;
    const reason = `deadlock between ${requestA.requesterRole} and ${requestA.requesteeRole}`;
    await updateMeetingRequestStatus(runId, requestA.id, 'failed', { failureReason: reason });
    await updateMeetingRequestStatus(runId, reverse.id, 'failed', { failureReason: reason });
    handled.add(requestA.id);
    handled.add(reverse.id);
    // Лог в output: причина видна в Developer Tools / `Output: Extension Host`.
    // Прод-канал диагностики дёшев и не требует дополнительного UI.
    console.warn(`[meeting-resolver] ${reason} — both requests failed`);
    results.push({ kind: 'failed', requestId: requestA.id, reason });
    results.push({ kind: 'failed', requestId: reverse.id, reason });
  }

  const remaining = sortedByCreated.filter((request) => !handled.has(request.id));
  if (handled.size > 0) {
    void broadcastPendingRequests(runId);
  }
  if (remaining.length === 0) return results;

  // Шаг 3-4: per-requestee приоритизация и резолв.
  const oldestByRequestee = pickOldestPerRequestee(remaining);
  // Снэпшот строим один раз: дальше внутри прохода мы сами знаем, кого
  // только что заняли (`busyAfterResolve`) — повторный read не нужен.
  const snapshot = await buildRoleStateSnapshot(runId);
  const busyAfterResolve = new Set<string>();

  for (const [requesteeRole, request] of oldestByRequestee) {
    const requesteeState = roleStateFor(requesteeRole as Role, snapshot);
    if (busyAfterResolve.has(requesteeRole) || requesteeState.kind !== 'idle') {
      results.push({
        kind: 'still_pending',
        requestId: request.id,
        reason: `requestee ${requesteeRole} is ${requesteeState.kind}`,
      });
      continue;
    }
    const sessionId = await createMeetingSession(runId, request);
    // #0051: `createSession` атомарно делает новую комнату активной
    // (см. `setActiveSession` внутри неё). Для нас это побочка: цикл
    // инициатора при wake-up будет искать `loop.json` через активную
    // сессию рана. Восстанавливаем активной ту, в которой инициатор
    // паузнулся (`contextSessionId`) — так resumer корректно подхватит
    // его конфиг и продолжит писать события туда же. Сама комната
    // остаётся в `sessions[]` и доступна UI как отдельный канал.
    const restored = await setActiveSession(runId, request.contextSessionId);
    if (restored) {
      broadcast({ type: 'runs.updated', meta: restored });
    }
    // #0051: упрощённая интеграция с `team.escalate`. Если заявка
    // эскалационная (между requester и requestee есть промежуточные
    // роли), а они сейчас idle — подтягиваем их в новую комнату через
    // `pullIntoRoom`, чтобы цепочка коммуникации не рвалась. Если
    // промежуточная сама занята — оставляем «как есть»: не создаём
    // ещё одну заявку, чтобы не разводить каскады; будет следующая
    // итерация триггера. Для не-эскалационных пар (`team.invite`)
    // `rolesBetween` возвращает пустой массив — no-op.
    await pullIntermediateIdleRoles(runId, sessionId, request, snapshot);
    await updateMeetingRequestStatus(runId, request.id, 'resolved', {
      resolvedSessionId: sessionId,
    });
    void broadcastPendingRequests(runId);
    busyAfterResolve.add(requesteeRole);
    results.push({ kind: 'resolved', requestId: request.id, sessionId });

    // #0051: разбудить инициатора. Резолвер не имеет прямого доступа
    // к ExtensionContext (для секретов) и пакету ролевых resumer'ов;
    // wake-up идёт через слабую связь — handler регистрируется в
    // `activate()`. В тестах handler — стаб; в проде дёргает resumer
    // с `meeting_resolved`-intent'ом. Не await'им — пробуждение
    // запускает цикл fire-and-forget.
    void notifyMeetingWakeup({
      runId,
      meetingRequestId: request.id,
      requesterRole: request.requesterRole,
      requesteeRole: request.requesteeRole as Role,
      resolvedSessionId: sessionId,
    });
  }

  // Заявки, которые не «самая старая для своего адресата», — ждут за
  // более ранней. Возвращаем им still_pending явно, чтобы тест мог
  // проверить «хвост».
  for (const request of remaining) {
    const oldest = oldestByRequestee.get(request.requesteeRole);
    if (oldest && oldest.id !== request.id) {
      results.push({
        kind: 'still_pending',
        requestId: request.id,
        reason: `older request ${oldest.id} not yet resolved`,
      });
    }
  }

  return results;
}

/**
 * Безопасная обёртка над {@link resolvePending} для триггер-сайтов
 * (активация, изменение статуса сессии). Не бросает: ошибка резолвера
 * не должна валить ни активацию расширения, ни запись статуса в storage.
 *
 * Лог в output по той же причине, что и в deadlock-ветке: пользователь/
 * разработчик увидят причину сбоя в Developer Tools без отдельного
 * notification UI.
 */
export async function triggerResolvePending(runId: string): Promise<ResolveResult[]> {
  try {
    return await resolvePending(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meeting-resolver] resolvePending(${runId}) failed: ${message}`);
    return [];
  }
}

/**
 * Сгруппировать pending-заявки по адресату и оставить по одной — самой
 * старой. Вход уже отсортирован по `createdAt` (см. вызывающий код),
 * поэтому достаточно `if (!has) set`.
 */
function pickOldestPerRequestee(requests: MeetingRequest[]): Map<string, MeetingRequest> {
  const result = new Map<string, MeetingRequest>();
  for (const request of requests) {
    if (!result.has(request.requesteeRole)) {
      result.set(request.requesteeRole, request);
    }
  }
  return result;
}

/**
 * Создать новую сессию-комнату под резолв заявки и положить в неё
 * первое сообщение от инициатора.
 *
 * Почему новая сессия, а не reuse `contextSessionId`: иначе теряется
 * граница «эта переписка началась в ответ на тот запрос». `prev` новой
 * сессии указывает на контекст инициатора, и UI журнала встреч (#0046)
 * сможет показать ниточку «откуда пришло».
 *
 * `from` сообщения — `agent:${requesterRole}`: формат строки канонический
 * (см. `ChatMessage.from` в `types.ts` и `roleStateFor`).
 */
async function createMeetingSession(runId: string, request: MeetingRequest): Promise<string> {
  const { session } = await createSession(runId, {
    kind: 'agent-agent',
    participants: [
      { kind: 'agent', role: request.requesterRole },
      { kind: 'agent', role: request.requesteeRole },
    ],
    prev: [request.contextSessionId],
    status: 'running',
  });
  await appendChatMessage(
    runId,
    {
      id: crypto.randomBytes(6).toString('hex'),
      from: `agent:${request.requesterRole}`,
      at: new Date().toISOString(),
      text: request.message,
    },
    session.id
  );
  return session.id;
}

/**
 * #0051: подтянуть в новую сессию-комнату промежуточные роли цепочки
 * `rolesBetween(requester, requestee)`, если они сейчас `idle`.
 *
 * Алгоритм упрощённый (по AC #0051): не создаём отдельные meeting-
 * request'ы для занятых посредников — их подхватит следующая итерация
 * триггера. На текущем уровне иерархии (#0033) посредник один максимум
 * (architect между product и programmer), поэтому каскады нам не грозят.
 *
 * `pullIntoRoom` идемпотентен: если посредник уже среди participants
 * новой сессии — no-op; broadcast обновлённой меты не делаем.
 */
async function pullIntermediateIdleRoles(
  runId: string,
  sessionId: string,
  request: MeetingRequest,
  snapshot: RoleStateRunSnapshot
): Promise<void> {
  const between = rolesBetween(request.requesterRole, request.requesteeRole);
  for (const role of between) {
    const state = roleStateFor(role, snapshot);
    if (state.kind !== 'idle') continue;
    const updated = await pullIntoRoom(runId, sessionId, role);
    if (updated) {
      broadcast({ type: 'runs.updated', meta: updated });
    }
  }
}
