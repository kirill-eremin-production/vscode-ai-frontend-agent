import type { ChatMessage, Participant, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Чистые функции для журнала встреч (#0046).
 *
 * Логика панели «Встречи» собрана здесь, чтобы покрыть unit-тестами без
 * mount'а React-дерева: vitest подбирает только `*.test.ts`. Компоненты
 * `MeetingsPanel`/`MeetingCard` просто проксируют это в JSX.
 */

/**
 * Отсортировать сессии «свежие сверху» по `createdAt` desc (#0046 AC).
 * Возвращает копию — мутировать `meta.sessions` нельзя, на этот массив
 * подписан и selectActiveSessionForRole, и SessionTree, и canvas.
 *
 * Tie-breaker — `id`, чтобы порядок был детерминированным даже у двух
 * сессий с одинаковым createdAt (теоретически возможно при быстрой
 * последовательности pullIntoRoom + подсессия в одну миллисекунду).
 */
export function sortMeetingsByCreatedDesc(
  sessions: ReadonlyArray<SessionSummary>
): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (left.createdAt > right.createdAt) return -1;
    if (left.createdAt < right.createdAt) return 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Форматирует ISO-метку начала встречи под подписи в карточке (#0046 AC:
 * «время старта (`HH:MM` или относительное «5m ago»)»).
 *
 * Контракт:
 *  - < 1 минуты — `«just now»`;
 *  - < 60 минут — `«Nm ago»`;
 *  - < 24 часа — `«HH:MM»` (локаль ru-RU, чтобы порядок «часы:минуты»);
 *  - старше — `«DD.MM»` (без года; журналу за пределами одного дня
 *    важна дата, а не таймер).
 *
 * Невалидную метку отдаём как есть — лучше показать сырой timestamp,
 * чем «Invalid Date». Зеркалит подход {@link formatJoinTime} в
 * `chat/lib/roles.ts`.
 */
export function formatStartedAt(at: string, now: number): string {
  const date = new Date(at);
  const ts = date.getTime();
  if (Number.isNaN(ts)) return at;
  const deltaMs = now - ts;
  if (deltaMs < 0) {
    // Будущая метка — редкий случай (рассинхрон часов); fallback на HH:MM,
    // чтобы пользователь увидел корректное время, а не «-Nm ago».
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  const oneMinute = 60_000;
  const oneHour = 60 * oneMinute;
  const oneDay = 24 * oneHour;
  if (deltaMs < oneMinute) return 'just now';
  if (deltaMs < oneHour) {
    const minutes = Math.floor(deltaMs / oneMinute);
    return `${minutes}m ago`;
  }
  if (deltaMs < oneDay) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/**
 * Превью одной строки для карточки встречи (#0046 AC: «превью первого/
 * последнего сообщения, одна строка, truncate»).
 *
 * Берём **последнее** непустое сообщение — оно даёт более актуальное
 * представление о состоянии встречи (хвост диалога, а не приветствие).
 * Если все сообщения пусты — возвращаем `undefined`, карточка покажет
 * fallback-подпись по `kind`/`inputFrom`.
 *
 * Однострочность: переносы и табы заменяем пробелами и схлопываем
 * подряд идущие пробелы; truncate — по числу UTF-16-кодпоинтов с
 * многоточием. Делаем через `Array.from`, чтобы не разорвать суррогатную
 * пару (эмодзи) посередине.
 */
export function getMessagePreview(
  messages: ReadonlyArray<Pick<ChatMessage, 'text'>>,
  maxLength = 80
): string | undefined {
  if (maxLength <= 0) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = (messages[index]?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const codepoints = Array.from(text);
    if (codepoints.length <= maxLength) return text;
    return `${codepoints.slice(0, maxLength - 1).join('')}…`;
  }
  return undefined;
}

/**
 * Локализованная подпись «← user» / «← product» / etc. (#0046 AC).
 *
 * Источник правды для названий ролей — `KNOWN_ROLES` из
 * `features/chat/lib/roles.ts`. Дублируем здесь минимальный словарь:
 * boundaries-плагин запрещает кросс-импорт между фичами, а выносить
 * в `shared/` ради двух строк преждевременно (см. AGENT.md «не плодим
 * абстракции на одно использование»). Если завтра словарь
 * расширится — синхронизируем оба места одной правкой.
 */
const INPUT_FROM_LABELS: Record<string, string> = {
  user: 'Вы',
  product: 'Продакт',
  architect: 'Архитектор',
  programmer: 'Программист',
  system: 'Система',
};

/**
 * Подпись `inputFrom`'а для карточки. Префикс `← ` фиксирован —
 * визуально это «вход из …», что отличает поле от шапки участников.
 * Неизвестную роль капитализируем, чтобы не показывать пустоту.
 */
export function formatInputFromLabel(inputFrom: string | undefined): string | undefined {
  if (!inputFrom) return undefined;
  const known = INPUT_FROM_LABELS[inputFrom];
  if (known) return `← ${known}`;
  const capitalized =
    inputFrom.length > 0 ? inputFrom.charAt(0).toUpperCase() + inputFrom.slice(1) : inputFrom;
  return `← ${capitalized}`;
}

/**
 * Первое непустое сообщение ленты — текст без переносов и табов.
 *
 * Используется в tooltip'е prev/next-ссылок (#0047): «время + первое
 * сообщение» помогает узнать сессию, не открывая её. В отличие от
 * {@link getMessagePreview}, идём с начала ленты — пользователь
 * ассоциирует сессию с её «вступительной» репликой, а не с текущим
 * хвостом. Truncate для tooltip делает {@link summarizeSessionForLink},
 * здесь только нормализуем whitespace.
 */
export function getFirstMessageText(
  messages: ReadonlyArray<Pick<ChatMessage, 'text'>>
): string | undefined {
  for (const message of messages) {
    const text = (message.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Сводка о сессии для prev/next-ссылки в карточке встречи (#0047 AC):
 *  - `icons` — уникальные роли участников в порядке появления; рисуются
 *    в ссылке без подписей (компактно, без переноса строки);
 *  - `tooltip` — `«HH:MM · первое сообщение»` либо просто `«HH:MM»`,
 *    если первого сообщения для этой сессии у нас нет (chat-лента
 *    хранится в store только для просматриваемой сессии — для
 *    остальных сессий передаётся `undefined`, и в tooltip остаётся
 *    одно время; ограничение прозрачно описано в Outcome #0046).
 *
 * Tooltip-длина ограничена ~80 кодпоинтами через `Array.from` —
 * длинная первая реплика не должна растягивать всплывашку на весь
 * экран. Невалидную дату отдаём строкой «как пришла», как и в
 * {@link formatStartedAt}: лучше показать сырой timestamp, чем
 * «Invalid Date».
 */
export interface SessionLinkSummary {
  icons: Role[];
  tooltip: string;
}

export function summarizeSessionForLink(
  session: SessionSummary,
  firstMessage?: string
): SessionLinkSummary {
  const seen = new Set<Role>();
  const icons: Role[] = [];
  for (const participant of session.participants ?? []) {
    const role = participantToRole(participant);
    if (seen.has(role)) continue;
    seen.add(role);
    icons.push(role);
  }
  const date = new Date(session.createdAt);
  const timeLabel = Number.isNaN(date.getTime())
    ? session.createdAt
    : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const trimmed = (firstMessage ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return { icons, tooltip: timeLabel };
  const TOOLTIP_PREVIEW_MAX = 80;
  const codepoints = Array.from(trimmed);
  const preview =
    codepoints.length <= TOOLTIP_PREVIEW_MAX
      ? trimmed
      : `${codepoints.slice(0, TOOLTIP_PREVIEW_MAX - 1).join('')}…`;
  return { icons, tooltip: `${timeLabel} · ${preview}` };
}

/**
 * Маппит участника сессии в `Role` для атома `Avatar` (#0016).
 * Зеркалит `participantToRoleInfo` из `features/chat/lib/roles.ts`,
 * но без заголовков — нам нужен только цвет/иконка.
 *
 * Неизвестная роль агента → `system`: безопасный fallback, аватар
 * рендерится с серым фоном и иконкой Cog, ничего не падает.
 */
export function participantToRole(participant: Participant): Role {
  if (participant.kind === 'user') return 'user';
  switch (participant.role) {
    case 'product':
    case 'architect':
    case 'programmer':
    case 'user':
    case 'system':
      return participant.role;
    default:
      return 'system';
  }
}
