import type { ChatMessage, MeetingRequestSummary, RunMeta } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Упрощённое состояние кубика роли на canvas (#0044).
 *
 * До #0044 канвас рендерил детальный `RunActivityKind`
 * (`thinking`/`tool`/`awaiting_user`/`awaiting_human`/`failed`/`done`/
 * `idle`), и эти подкатегории смешивались в один и тот же UI-сигнал
 * «эта роль занята». Здесь сводим к минимально необходимому набору из
 * AC #0044: пользователь должен с одного взгляда понять, кто из ролей
 * сейчас работает, кто ждёт его ответа, а кто простаивает. `paused`
 * добавлен в #0052: роль поставила meeting-request и сама ждёт ответа,
 * её agent-loop приостановлен.
 *
 * Детальная подпись (имя тула, "Архитектор думает…") по-прежнему
 * рендерится отдельно через {@link RunActivity} — это caption под
 * кубиком, не его состояние.
 */
export type CubeState = 'idle' | 'working' | 'awaiting_user' | 'paused';

/**
 * Минимальный срез состояния рана, достаточный для определения
 * cube-state. Намеренно `Pick`/массивы, не весь `RunMeta` целиком: тест
 * собирает синтетические инпуты вручную, и компилятор гарантирует, что
 * мы используем только эти поля.
 *
 *  - `meta` — статус рана + список сессий + id активной (для проверки,
 *    участвует ли роль в активной сессии).
 *  - `chat` — сообщения активной сессии. Берём только последний элемент:
 *    «работающую» роль определяем по тому, что последнее сообщение пришло
 *    не от неё (то есть к ней обратились и ждём ответа); awaiting_user —
 *    наоборот, последнее от неё.
 */
export interface CubeRunState {
  meta: Pick<RunMeta, 'sessions' | 'activeSessionId' | 'status'>;
  chat: ReadonlyArray<Pick<ChatMessage, 'from'>>;
  /**
   * Pending meeting-requests рана (#0052). Роль в `paused`, если у неё
   * есть pending как у `requesterRole`: она вызвала встречу и ждёт,
   * пока резолвер поднимет адресата. Если поле не передано —
   * paused-ветка просто никогда не сработает (back-compat для тестов и
   * сторибуков, не знающих про pending).
   */
  pendingRequests?: ReadonlyArray<MeetingRequestSummary>;
}

/**
 * Чистая функция `cubeStateFor(role, runState)` (контракт #0044).
 *
 * Алгоритм (по AC):
 *  1. Активной сессии нет (или она не найдена в `sessions`) → `idle`:
 *     рану нечего показать, кубик нейтрален.
 *  2. Роль не участник активной сессии → `idle`: визуально это и значит
 *     «роль сейчас не вовлечена», независимо от истории чата.
 *  3. Последнее сообщение чата активной сессии **не** от этой роли →
 *     `working`. Семантика «к этой роли обратились, ждём её ответ» —
 *     именно её мы рисуем спиннером и пульсацией.
 *  4. Последнее сообщение от этой роли, роль = `product`, ран в
 *     `awaiting_user_input`, активная сессия — user-agent → `awaiting_user`.
 *     На этой итерации это единственный случай «роль ждёт юзера»:
 *     bridge-сессии (agent-agent) пользователя не задействуют, а
 *     остальные роли с ним напрямую не общаются.
 *  5. Иначе → `idle`. Сюда попадают: пустой чат, последнее сообщение
 *     от роли вне awaiting_user_input (роль уже сдала артефакт и
 *     передала handoff — она простаивает с точки зрения active-сессии).
 */
export function cubeStateFor(role: Role, runState: CubeRunState): CubeState {
  const { meta, chat, pendingRequests } = runState;

  // #0052: paused имеет приоритет над всеми остальными ветками. Роль
  // могла поставить заявку из активной сессии (тогда она и participant)
  // или из bridge'а, который уже не активен. В любом случае её цикл
  // приостановлен, и кубик должен показать клок-иконку независимо от
  // того, что лежит в чате активной сессии.
  if (pausedRequesteeFor(role, pendingRequests) !== undefined) {
    return 'paused';
  }

  const sessions = meta.sessions ?? [];
  const active = sessions.find((session) => session.id === meta.activeSessionId);
  if (!active) return 'idle';

  const isParticipant = (active.participants ?? []).some(
    (participant) => participant.kind === 'agent' && participant.role === role
  );
  if (!isParticipant) return 'idle';

  const lastMessage = chat.length > 0 ? chat[chat.length - 1] : undefined;
  const lastFrom = lastMessage?.from;
  const ownMarker = `agent:${role}`;

  // Случай 4: единственный сценарий awaiting_user — продакт ждёт ответа
  // пользователя в корневой user-agent сессии. Проверяем явно kind и
  // status, чтобы handoff в bridge не «заразил» старую сессию ожиданием.
  if (
    role === 'product' &&
    lastFrom === ownMarker &&
    active.kind === 'user-agent' &&
    meta.status === 'awaiting_user_input'
  ) {
    return 'awaiting_user';
  }

  // Случай 3: к роли обратились (последнее сообщение не от неё) и она
  // должна ответить. `lastFrom === undefined` сюда не попадает — пустой
  // чат не считается «обращением».
  if (lastFrom !== undefined && lastFrom !== ownMarker) {
    return 'working';
  }

  return 'idle';
}

/**
 * Кого ждёт роль `role` по своим pending-заявкам (#0052). Возвращает
 * имя роли-адресата, если у `role` есть pending заявка как у requester'а;
 * иначе undefined.
 *
 * Если у роли несколько pending'ов одновременно (она поставила несколько
 * встреч до того, как первый резолвится — теоретически возможно при
 * каскадных triggers), берём самую свежую: caption «ждёт ответа от X»
 * — это про последнюю интенцию пользователя/роли, а не про самую
 * старую заявку. Сортировку извне не требуем.
 */
export function pausedRequesteeFor(
  role: Role,
  pendingRequests: ReadonlyArray<MeetingRequestSummary> | undefined
): string | undefined {
  if (!pendingRequests || pendingRequests.length === 0) return undefined;
  let latest: MeetingRequestSummary | undefined;
  for (const request of pendingRequests) {
    if (request.requesterRole !== role) continue;
    if (!latest || request.createdAt > latest.createdAt) {
      latest = request;
    }
  }
  return latest?.requesteeRole;
}
