/**
 * Реестр «пробуждений» инициатора meeting-request'а (#0051).
 *
 * Когда `meeting-resolver` (#0050) переводит заявку в `resolved`, нам
 * нужно «разбудить» agent-loop роли-инициатора — она была поставлена
 * на паузу тулом `team.invite`/`team.escalate`. Делать это прямо из
 * резолвера нельзя:
 *
 *  - резолвер живёт в `team/`, а возобновление цикла требует
 *    `vscode.ExtensionContext` (для секретов) и пакет ролевых
 *    resumer'ов — это другой слой архитектуры;
 *  - резолвер должен оставаться чисто-функциональным и тестируемым
 *    без VS Code API.
 *
 * Поэтому контракт — слабая связь через единичный handler-callback,
 * который регистрируется в `activate()`. Если handler не зарегистрирован
 * (например, в unit-тестах резолвера) — резолвер просто не будит
 * никого, заявку всё равно переводит в `resolved`. Тесты тула проверяют
 * пробуждение, переопределяя handler своим стабом.
 *
 * Реестр единичный: один extension host = одна стратегия пробуждения.
 * Множественные подписчики не нужны — wake-up делает один правильный
 * resumer для роли-инициатора.
 */

import type { Role } from './hierarchy';

/** Параметры одного пробуждения, передаваемые handler'у. */
export interface MeetingWakeupParams {
  runId: string;
  /** id заявки, которую только что резолвили. */
  meetingRequestId: string;
  /** Роль, которая ждёт ответа (она и должна проснуться). */
  requesterRole: Role;
  /** Роль адресата встречи — её имя пойдёт в системное сообщение. */
  requesteeRole: Role;
  /** id новой сессии-комнаты, созданной резолвером. */
  resolvedSessionId: string;
}

/**
 * Сигнатура handler'а пробуждения. Возвращаемый Promise может быть
 * fire-and-forget — резолвер не ждёт его завершения, чтобы не
 * блокировать остальной проход.
 */
export type MeetingWakeupHandler = (params: MeetingWakeupParams) => Promise<void> | void;

let handler: MeetingWakeupHandler | undefined;

/**
 * Зарегистрировать handler пробуждения. Вызывается ровно один раз в
 * `activate`. Повторная регистрация перезаписывает предыдущий handler —
 * это нужно тестам (стаб поверх продового), а в проде второй вызов
 * означал бы дабл-активацию, что само по себе симптом бага.
 */
export function setMeetingWakeupHandler(next: MeetingWakeupHandler | undefined): void {
  handler = next;
}

/**
 * Вызвать handler пробуждения, если он зарегистрирован. Используется
 * резолвером после успешного резолва. Ошибки handler'а проглатываем
 * в console.error: пробуждение — best-effort, неудача в нём не должна
 * валить остальной цикл резолвера (другие заявки в том же проходе
 * всё равно нужно довести до конца).
 */
export async function notifyMeetingWakeup(params: MeetingWakeupParams): Promise<void> {
  if (!handler) return;
  try {
    await handler(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[meeting-wakeup] handler failed for request ${params.meetingRequestId}: ${message}`
    );
  }
}
