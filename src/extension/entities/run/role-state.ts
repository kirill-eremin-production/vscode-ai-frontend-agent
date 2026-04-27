/**
 * Модель состояния роли в ране (#0048).
 *
 * Состояние роли — derived-функция от текущего рантайма (активные сессии
 * + pending meeting-requests). Хранить отдельный persisted-флаг плохо:
 *
 *  - Любая запись «роль занята» = ещё одно место, которое надо
 *    синхронно обновлять при каждом сообщении/смене статуса. Любая
 *    дрожь между источниками = баг типа «роль занята, но в чате её
 *    последнее сообщение».
 *  - Источник правды и так есть: список сессий рана и журнал
 *    meeting-requests. Достаточно собрать их в чистую функцию.
 *
 * Поэтому здесь только pure-функция `roleStateFor` + селектор
 * `selectRoleStates`. Реальные данные подаст #0049 (storage
 * MeetingRequest) и #0050 (resolver), на этой итерации функция работает
 * с переданным извне массивом (на старте — всегда пустым).
 *
 * Связь с UI #0044 (cube-state):
 *  - `busy` ≈ canvas-кубик `working`,
 *  - `awaiting_input` ≈ кубик `paused` (#0052, ещё не существует).
 *  Кубики живут в webview, а эта модель — в extension'е, потому что
 *  её потребляет meeting-resolver и tools (#0050/#0051), которые
 *  работают на стороне Node.
 */

import type { Participant, RunStatus } from './types';
import { HIERARCHY, type Role } from '../../team/hierarchy';

/**
 * Минимальная форма meeting-request, нужная этой модели.
 *
 * Полный тип появится в #0049 со storage'ом. Здесь объявлен как
 * structural-интерфейс с обязательными полями, по которым принимается
 * решение: id (для возврата в `awaiting_input`), `requesterRole`
 * (кто ждёт ответа), `status` (учитываем только `pending`), и
 * `createdAt` (стабильный порядок при множественных pending-запросах).
 *
 * Сделано локальным интерфейсом, а не импортом из будущего модуля,
 * чтобы #0048 не блокировал #0049 и наоборот: совместимость по shape
 * проверит TS на этапе интеграции.
 */
export interface RoleStateMeetingRequest {
  id: string;
  requesterRole: Role;
  status: 'pending' | 'resolved' | 'failed';
  createdAt: string;
}

/**
 * Срез сессии, достаточный для вычисления состояния роли.
 *
 * Берём не весь {@link SessionMeta}, а структурный pick: тест собирает
 * синтетические инпуты вручную, а будущий вызывающий код (например,
 * resolver в #0050) сам решит, как уложить реальную сессию в эту форму.
 *
 *  - `id` — нужен, чтобы вернуть `busy(sessionId)`.
 *  - `status` — фильтрует «уже не активные» сессии (`done`/`failed`/
 *    `compacted`): по ним «занятость» не имеет смысла.
 *  - `participants` — без них нельзя проверить «роль участник этой сессии».
 *  - `lastMessageFrom` — автор последнего сообщения сессии (`'user'` |
 *    `'agent:<role>'` | `undefined` для пустого чата). Если его нет
 *    или он равен `agent:${role}` — значит «к роли ничего не обращено»,
 *    она не busy в этой сессии.
 */
export interface RoleStateSession {
  id: string;
  status: RunStatus;
  participants: ReadonlyArray<Participant>;
  lastMessageFrom?: string;
}

/**
 * Снэпшот рана для вычисления состояний всех ролей.
 *
 * Это явный input-shape, а не `RunMeta`: модель не должна тянуть
 * лишние поля, и тест собирает данные руками. Реальный код собирает
 * `sessions[]` из session-meta + последних строк `chat.jsonl` для
 * каждой активной сессии (#0050) и подкладывает pending-запросы из
 * хранилища (#0049).
 */
export interface RoleStateRunSnapshot {
  sessions: ReadonlyArray<RoleStateSession>;
  meetingRequests: ReadonlyArray<RoleStateMeetingRequest>;
}

/**
 * Состояние роли. Discriminated union, чтобы потребители (UI, resolver)
 * могли по `kind` без догадок выбрать ветку и не путать «id чего-то» —
 * `sessionId` против `meetingRequestId` отличаются осознанно.
 */
export type RoleState =
  | { kind: 'idle' }
  | { kind: 'busy'; sessionId: string }
  | { kind: 'awaiting_input'; meetingRequestId: string };

/**
 * Сессии в этих статусах больше не «занимают» роль: на `done`/`failed`/
 * `compacted` ничего нового от участника не ждут. Остальные статусы
 * (`draft`, `running`, `awaiting_user_input`, `awaiting_human`) могут
 * подразумевать «к роли могут обратиться», поэтому пропускаем дальше
 * на проверку last-message.
 */
const FINAL_SESSION_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'failed',
  'compacted',
]);

/**
 * Чистая функция определения состояния одной роли.
 *
 * Алгоритм (по AC #0048):
 *  1. Если в ране есть pending {@link RoleStateMeetingRequest} с
 *     `requesterRole === role` — роль ждёт ответа на свой запрос →
 *     `awaiting_input(meetingRequestId)`. При нескольких pending'ах
 *     берём самый старый (по `createdAt`): UX «роль ждёт» — про
 *     первую заблокировавшую её встречу, последующие висят за ней.
 *  2. Иначе ищем активную сессию (статус не финальный), в которой
 *     роль — участник, и последнее сообщение **не** от неё. Это и
 *     значит «к ней обратились, ждут ответ» → `busy(sessionId)`.
 *     При нескольких таких сессиях возвращаем первую в порядке
 *     массива: на старте multi-session мира (#0050) сессий у роли
 *     обычно ≤1, тонкая приоритизация — будущее.
 *  3. Иначе → `idle`.
 *
 * Почему не «активной = `activeSessionId`»: с #0034/#0050 у роли
 * параллельно может быть сессия в bridge'е и сессия в комнате; флаг
 * «активная» у рана один, а занятость роли — про любую из них.
 */
export function roleStateFor(role: Role, runState: RoleStateRunSnapshot): RoleState {
  const pendingForRole = runState.meetingRequests
    .filter((request) => request.status === 'pending' && request.requesterRole === role)
    // Сортировка стабильна: при одинаковом `createdAt` сохраняем порядок
    // массива (исходно — порядок появления в storage).
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (pendingForRole.length > 0) {
    return { kind: 'awaiting_input', meetingRequestId: pendingForRole[0].id };
  }

  const ownMarker = `agent:${role}`;
  for (const session of runState.sessions) {
    if (FINAL_SESSION_STATUSES.has(session.status)) continue;
    const isParticipant = session.participants.some(
      (participant) => participant.kind === 'agent' && participant.role === role
    );
    if (!isParticipant) continue;
    const lastFrom = session.lastMessageFrom;
    // Пустой чат и «последнее от меня» оба означают «ко мне ничего не
    // обращено» — обе ветки → не busy в этой сессии.
    if (lastFrom === undefined || lastFrom === ownMarker) continue;
    return { kind: 'busy', sessionId: session.id };
  }

  return { kind: 'idle' };
}

/**
 * Селектор по всем ролям иерархии. Возвращает {@link Record} вместо
 * массива: потребители (resolver, UI) обычно лезут точечно по роли —
 * `states['programmer']` читается короче, чем `find` по массиву.
 *
 * Ключи — ровно роли из {@link HIERARCHY}; `'user'` сюда не входит
 * осознанно (#0031: «Пользователь — особый участник, его busy/idle
 * не моделируем»).
 */
export function selectRoleStates(runState: RoleStateRunSnapshot): Record<Role, RoleState> {
  // Стартовое значение собираем явным циклом, чтобы тип Record<Role,
  // RoleState> был полным без приведений — если в HIERARCHY добавят
  // новую роль, цикл автоматически положит для неё ключ.
  const result = {} as Record<Role, RoleState>;
  for (const role of HIERARCHY) {
    result[role] = roleStateFor(role, runState);
  }
  return result;
}
