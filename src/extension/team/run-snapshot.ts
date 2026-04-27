/**
 * Сборщик `RoleStateRunSnapshot` (#0048) по реальным данным рана.
 *
 * Используется тремя сторонами:
 *  - `team.invite` (#0037 / #0051) — проверка занятости таргета перед
 *    pullIntoRoom.
 *  - `team.escalate` (#0038 / #0051) — проверка занятости каждой роли
 *    в цепочке эскалации.
 *  - `meeting-resolver` (#0050) — выбор «идти в idle-роль или ждать».
 *
 * Раньше snapshot собирался только в meeting-resolver приватной
 * функцией. С #0051 та же логика нужна тулам: вынесли в общий модуль,
 * чтобы поведение «как считается busy» было одно и то же. Иначе тулы
 * могли бы видеть «idle», а резолвер сразу после — «busy», и наоборот.
 */

import { readChat, readMeta } from '../entities/run/storage';
import { getPendingRequests } from '../entities/run/meeting-request';
import type { RoleStateRunSnapshot, RoleStateSession } from '../entities/run/role-state';

/**
 * Собрать input для `roleStateFor` по диску рана.
 *
 * Для каждой сессии из `RunMeta.sessions` берём последнее сообщение из
 * `chat.jsonl` (его `from` — единственное, что нужно `roleStateFor`
 * помимо participants/status). Если рана нет (удалили посередине) —
 * возвращаем пустой snapshot, чтобы вызывающий код решил, что делать.
 *
 * `meetingRequests` подкладываем pending-список: только pending влияет
 * на состояние роли (resolved/failed уже не блокируют).
 */
export async function buildRoleStateSnapshot(runId: string): Promise<RoleStateRunSnapshot> {
  const meta = await readMeta(runId);
  const sessions: RoleStateSession[] = [];
  if (meta) {
    for (const summary of meta.sessions) {
      const chat = await readChat(runId, summary.id);
      const lastMessageFrom = chat.length > 0 ? chat[chat.length - 1].from : undefined;
      sessions.push({
        id: summary.id,
        status: summary.status,
        participants: summary.participants,
        lastMessageFrom,
      });
    }
  }
  const meetingRequests = await getPendingRequests(runId);
  return { sessions, meetingRequests };
}
