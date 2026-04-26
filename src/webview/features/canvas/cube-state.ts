import type { ChatMessage, RunMeta } from '@shared/runs/types';
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
 * добавится позже в #0052 — четвёртый кубик там же.
 *
 * Детальная подпись (имя тула, "Архитектор думает…") по-прежнему
 * рендерится отдельно через {@link RunActivity} — это caption под
 * кубиком, не его состояние.
 */
export type CubeState = 'idle' | 'working' | 'awaiting_user';

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
  const { meta, chat } = runState;
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
