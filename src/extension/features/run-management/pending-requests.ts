/**
 * Хелпер «pending meeting-requests → IPC-сводка → broadcast» (#0052).
 *
 * Один map-функцией здесь живёт два контракта:
 *  1) Перевод полного {@link MeetingRequest} в облегчённый
 *     {@link MeetingRequestSummary} для UI: webview не должен видеть
 *     поля `resolvedAt`/`resolvedSessionId`/`failureReason` — он
 *     работает только с pending'ами, для них эти поля всегда undefined.
 *  2) Удобная обёртка `broadcastPendingRequests(runId)`: читает
 *     pending-список с диска и рассылает `runs.pendingRequests.updated`
 *     во все активные webview. Используется во всех точках, где
 *     состав pending'ов мог измениться: создание заявки в
 *     `team.invite`/`team.escalate` (#0051) и резолв в координаторе
 *     (#0050).
 *
 * Вынесено отдельно по двум причинам:
 *  - tools/resolver не должны знать формат IPC-сообщения (где какие
 *    поля), это ответственность модуля `run-management`;
 *  - всю «голую» работу с диском и broadcast'ом проще тестировать в
 *    одном месте, а не повторять три раза.
 */

import { getPendingRequests, type MeetingRequest } from '@ext/entities/run/meeting-request';
import { broadcast } from './broadcast';
import type { MeetingRequestSummary } from './messages';

/**
 * Сконвертировать список pending-запросов в IPC-формат. Чистая функция,
 * вынесена для тестируемости и для использования в синхронных местах
 * (где список уже на руках, повторно дёргать диск не надо).
 */
export function toMeetingRequestSummaries(
  requests: ReadonlyArray<MeetingRequest>
): MeetingRequestSummary[] {
  return requests.map((request) => ({
    id: request.id,
    requesterRole: request.requesterRole,
    requesteeRole: request.requesteeRole,
    contextSessionId: request.contextSessionId,
    message: request.message,
    createdAt: request.createdAt,
  }));
}

/**
 * Прочитать актуальный pending-список рана и разослать
 * `runs.pendingRequests.updated` во все webview. Не бросает: ошибки
 * чтения логируем в console.error и идём дальше — broadcast встроен в
 * горячие пути (создание заявки, резолв, deadlock-fail), один сбой
 * чтения не должен блокировать сами эти переходы. Без broadcast UI
 * один tick останется со старым списком, следующий триггер всё равно
 * его обновит.
 */
export async function broadcastPendingRequests(runId: string): Promise<void> {
  try {
    const pending = await getPendingRequests(runId);
    broadcast({
      type: 'runs.pendingRequests.updated',
      runId,
      pendingRequests: toMeetingRequestSummaries(pending),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pending-requests] broadcast for ${runId} failed: ${message}`);
  }
}
