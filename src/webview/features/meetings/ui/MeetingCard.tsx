import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Avatar, roleIcons, type Role } from '@shared/ui';
import type { Participant, RunStatus, SessionSummary } from '@shared/runs/types';
import {
  formatInputFromLabel,
  formatStartedAt,
  participantToRole,
  summarizeSessionForLink,
} from '../lib/format';

/**
 * Карточка одной встречи (#0046 / #0047). Показывает участников аватарами,
 * пометку источника входа `← inputFrom`, время старта, статус,
 * однострочное превью и две строки навигации:
 *  - `← откуда: <link>+` — по одному элементу на каждый id из `prev`;
 *  - `→ что родилось: <link>+` — по одному на каждый id из `next`.
 *
 * Карточка сама по себе кликабельна (drill-in в чат соответствующей
 * сессии). Чтобы внутри корректно жили вложенные prev/next-кнопки, корневой
 * элемент — `<div role="button">`, а не `<button>`: HTML запрещает
 * вложенные интерактивные элементы внутрь `<button>`. Клавиатура
 * (Enter/Space) обрабатывается явно — accessibility сохраняется.
 *
 * Все обработчики (onSelect, onNavigateLink) приходят сверху из
 * {@link MeetingsPanel}, чтобы карточка не зависела от store. Это
 * упрощает рендер в Storybook и unit-тестирование.
 */
export interface MeetingCardProps {
  session: SessionSummary;
  /**
   * Подсвечена ли эта встреча как «сейчас просматривается».
   * Соответствует viewedSessionId из store: либо явный выбор сессии,
   * либо `meta.activeSessionId` в follow-mode.
   */
  isActive: boolean;
  /**
   * Является ли встреча live (статус "running"/"awaiting_*"). Управляет
   * отрисовкой зелёной точки и подписью статуса. Передаётся отдельно от
   * `session.status`, потому что локальный статус сессии и live-флаг
   * рана не всегда совпадают (сессия может быть `done`, но в ране
   * другая активная сессия — карточка не «зелёная»).
   */
  isLive: boolean;
  /**
   * Текущее время в миллисекундах для расчёта `Nm ago`. Передаётся
   * сверху единым timestamp'ом, чтобы все карточки на одной перерисовке
   * считали относительное время от одной точки. Иначе у двух карточек,
   * созданных в одну минуту, метки могли бы разойтись на «4m ago» и
   * «5m ago».
   */
  now: number;
  /** Превью последнего сообщения, если уже доступно (см. MeetingsPanel). */
  preview?: string;
  /** Номер карточки для дефолтного title'а («Встреча N»). */
  index: number;
  /**
   * Индекс «sessionId → сессия» по всем сессиям рана. Нужен для
   * prev/next-ссылок (#0047): чтобы по id найти участников и время
   * соседней встречи и нарисовать их без знания о store. Если id нет
   * в индексе — сессия orphan, ссылка disabled.
   */
  sessionsById: ReadonlyMap<string, SessionSummary>;
  /**
   * Просматриваемая сейчас сессия и её первое сообщение (если уже есть
   * в чате). Используется только для tooltip prev/next-ссылок: для
   * остальных сессий per-session preview недоступно (Outcome #0046),
   * tooltip ограничится одним временем.
   */
  viewedSessionId?: string;
  viewedSessionFirstMessage?: string;
  /**
   * Подсвечена ли карточка визуальным flash'ем после клика по prev/next
   * соседа (#0047 AC: «скроллит к соответствующей карточке + подсвечивает
   * её на ~1.5s»). Включается родителем через таймер.
   */
  isFlashing: boolean;
  /**
   * Ref-callback на корневой элемент карточки. Родитель регистрирует
   * его в Map<sessionId, HTMLElement>, чтобы потом вызвать
   * `scrollIntoView` при навигации по prev/next. Используем
   * ref-callback (а не useRef + forwardRef), потому что родителю нужен
   * единый Map — forwardRef был бы избыточным.
   */
  onCardElement?: (element: HTMLDivElement | null) => void;
  onSelect: (sessionId: string) => void;
  /**
   * Переход по prev/next-ссылке. Сценарий другой, чем у `onSelect`:
   * клик по prev/next НЕ открывает чат-таб, а только скроллит к
   * соседней карточке внутри той же панели и подсвечивает её. Поэтому
   * это отдельный коллбек: родитель решает, что значит «навигация
   * внутри журнала».
   */
  onNavigateLink: (sessionId: string) => void;
}

/**
 * Подпись статуса для карточки. Контракт #0046: `active` (зелёная
 * точка) / `finished` (нейтрально) / `paused` (заглушка под #0052).
 *
 * `paused`-сессий пока нет — `RunStatus` не содержит такого значения.
 * Возвращаем `finished` для всех неактивных, а место под paused
 * закрепляем явной веткой по `awaiting_human` (после сдачи артефакта),
 * чтобы при добавлении статуса в #0052 правка локализовалась здесь.
 */
function statusKindFor(status: RunStatus, isLive: boolean): 'active' | 'finished' | 'paused' {
  if (isLive) return 'active';
  // На текущей итерации paused не существует как статус сессии: AC явно
  // помечает его как заглушку под #0052. Возвращаем finished, метку
  // оставляем в классах ниже для будущей доработки.
  if (status === 'awaiting_human') return 'finished';
  return 'finished';
}

const STATUS_LABELS: Record<'active' | 'finished' | 'paused', string> = {
  active: 'активна',
  finished: 'завершена',
  paused: 'на паузе',
};

export function MeetingCard(props: MeetingCardProps) {
  // Деструктурируем все поля сразу: ESLint-плагин react-hooks/refs
  // помечает любое поле props после `ref={props.X}` как «доступ к рефу
  // во время рендера». С локальными переменными правило молчит, а
  // читаемость JSX даже выше.
  const {
    session,
    isActive,
    isLive,
    now,
    preview,
    index,
    sessionsById,
    viewedSessionId,
    viewedSessionFirstMessage,
    isFlashing,
    onCardElement,
    onSelect,
    onNavigateLink,
  } = props;
  const startedLabel = formatStartedAt(session.createdAt, now);
  const inputFromLabel = formatInputFromLabel(session.inputFrom);
  const statusKind = statusKindFor(session.status, isLive);
  const statusText = STATUS_LABELS[statusKind];
  const titleLabel = `Встреча ${index + 1}`;
  const participants = session.participants ?? [];
  const prevIds = session.prev ?? [];
  const nextIds = session.next ?? [];

  // Обработчик клика по prev/next в дочернем элементе должен погасить
  // всплытие, иначе onClick всей карточки тоже сработает и пользователь
  // окажется в чат-табе вместо «остался на той же панели, скроллнул к
  // соседу» (нарушение AC #0047).
  const handleSelect = (event: MouseEvent | KeyboardEvent) => {
    if (event.defaultPrevented) return;
    onSelect(session.id);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleSelect(event);
  };

  return (
    <div
      ref={onCardElement}
      role="button"
      tabIndex={0}
      data-meeting-card
      data-session-id={session.id}
      data-meeting-status={statusKind}
      data-meeting-flash={isFlashing ? 'on' : undefined}
      aria-pressed={isActive}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      // Flash рисуется через outline (а не border) — чтобы не сдвигать
      // содержимое карточки при появлении/уходе подсветки. transition
      // выставляем на сам outline-color, иначе появление подсветки
      // выглядит резко.
      style={
        {
          outlineOffset: '-1px',
          outline: isFlashing
            ? '2px solid var(--vscode-focusBorder, #0078d4)'
            : '2px solid transparent',
          transition: 'outline-color 200ms ease-out',
        } satisfies CSSProperties
      }
      className={
        'w-full flex flex-col gap-1 px-2 py-1.5 text-left text-[12px] rounded-sm border ' +
        'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vscode-focusBorder)] ' +
        (isActive
          ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)] border-border'
          : 'bg-transparent text-foreground border-transparent hover:bg-[var(--vscode-list-hoverBackground)]')
      }
      title={`${titleLabel} · ${statusText}${inputFromLabel ? ` · ${inputFromLabel}` : ''}`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <ParticipantsRow participants={participants} />
        <span className="text-[11px] text-muted shrink-0" aria-label={`Начато ${startedLabel}`}>
          {startedLabel}
        </span>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot kind={statusKind} />
        <span className="text-[11px] text-muted shrink-0">{statusText}</span>
        {inputFromLabel && (
          <span
            className="text-[11px] italic text-muted truncate"
            data-meeting-input-from={session.inputFrom}
            title={inputFromLabel}
          >
            {inputFromLabel}
          </span>
        )}
      </div>
      {preview ? (
        <span
          className="text-[11px] text-muted truncate block"
          data-meeting-preview
          title={preview}
        >
          {preview}
        </span>
      ) : (
        <span className="text-[11px] text-muted truncate block opacity-70">{titleLabel}</span>
      )}
      {prevIds.length > 0 && (
        <SessionLinkRow
          kind="prev"
          ids={prevIds}
          sessionsById={sessionsById}
          viewedSessionId={viewedSessionId}
          viewedSessionFirstMessage={viewedSessionFirstMessage}
          onNavigate={onNavigateLink}
        />
      )}
      {nextIds.length > 0 && (
        <SessionLinkRow
          kind="next"
          ids={nextIds}
          sessionsById={sessionsById}
          viewedSessionId={viewedSessionId}
          viewedSessionFirstMessage={viewedSessionFirstMessage}
          onNavigate={onNavigateLink}
        />
      )}
    </div>
  );
}

/**
 * Горизонтальный ряд аватаров. Дубли по роли подавляем — legacy-сессии
 * до миграции #0034 могли содержать повторы. Идентификатор зеркалит
 * `ParticipantsHeader` в фиче chat: 'user' / 'agent:<role>'.
 *
 * Аватары sm-размера (12px-иконка): карточка узкая, важно не съесть
 * вертикаль ради картинок. Tooltip — название роли по-русски, чтобы
 * подсказку можно было прочитать без шапки чата.
 */
function ParticipantsRow(props: { participants: ReadonlyArray<Participant> }) {
  const seen = new Set<string>();
  const items: Array<{ key: string; role: Role; title: string }> = [];
  for (const participant of props.participants) {
    const key = participant.kind === 'user' ? 'user' : `agent:${participant.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      role: participantToRole(participant),
      title: participant.kind === 'user' ? 'Вы' : participant.role,
    });
  }
  if (items.length === 0) return null;
  return (
    <span className="flex items-center gap-1 min-w-0" role="list" aria-label="Участники встречи">
      {items.map((item) => (
        <span key={item.key} role="listitem" data-meeting-participant={item.role}>
          <Avatar role={item.role} size="sm" title={item.title} />
        </span>
      ))}
    </span>
  );
}

/**
 * Строка prev/next-ссылок (#0047 AC). Подпись фиксирована («← откуда:» /
 * «→ что родилось:»), сами ссылки — по одной на каждый id. Если ссылка
 * указывает на orphan-сессию (нет в `sessionsById`) — рисуем как
 * disabled с tooltip'ом «сессия не найдена», без обработчика клика.
 *
 * Ссылка — `<button>` (а не `<a href>`): навигация чисто внутри панели,
 * никаких URL-ей и переходов в новые табы. Click bubbling гасим, чтобы
 * не сработал onClick карточки (см. {@link MeetingCard}).
 */
interface SessionLinkRowProps {
  kind: 'prev' | 'next';
  ids: ReadonlyArray<string>;
  sessionsById: ReadonlyMap<string, SessionSummary>;
  viewedSessionId?: string;
  viewedSessionFirstMessage?: string;
  onNavigate: (sessionId: string) => void;
}

function SessionLinkRow(props: SessionLinkRowProps) {
  const arrow = props.kind === 'prev' ? '←' : '→';
  const label = props.kind === 'prev' ? 'откуда:' : 'что родилось:';
  return (
    <div
      className="flex items-center gap-1 flex-wrap text-[10px] text-muted"
      data-meeting-link-row={props.kind}
    >
      <span aria-hidden>{arrow}</span>
      <span>{label}</span>
      {props.ids.map((sessionId) => {
        const target = props.sessionsById.get(sessionId);
        const firstMessage =
          target && sessionId === props.viewedSessionId
            ? props.viewedSessionFirstMessage
            : undefined;
        return (
          <SessionLink
            key={sessionId}
            kind={props.kind}
            sessionId={sessionId}
            target={target}
            firstMessage={firstMessage}
            onNavigate={props.onNavigate}
          />
        );
      })}
    </div>
  );
}

interface SessionLinkProps {
  kind: 'prev' | 'next';
  sessionId: string;
  target: SessionSummary | undefined;
  firstMessage: string | undefined;
  onNavigate: (sessionId: string) => void;
}

function SessionLink(props: SessionLinkProps) {
  // Orphan-сессия — disabled-ссылка с фиксированным tooltip'ом «сессия
  // не найдена». Используем `aria-disabled`, а не `disabled`, чтобы
  // tooltip оставался читаемым на всех платформах (нативный disabled
  // в некоторых темах гасит и title).
  if (!props.target) {
    return (
      <button
        type="button"
        data-meeting-link={props.kind}
        data-meeting-link-target={props.sessionId}
        data-meeting-link-disabled="true"
        aria-disabled="true"
        title="сессия не найдена"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-sm border border-dashed border-border opacity-60 cursor-not-allowed"
      >
        <span aria-hidden className="text-muted">
          ?
        </span>
      </button>
    );
  }
  const summary = summarizeSessionForLink(props.target, props.firstMessage);
  return (
    <button
      type="button"
      data-meeting-link={props.kind}
      data-meeting-link-target={props.sessionId}
      title={summary.tooltip}
      aria-label={`Перейти к встрече: ${summary.tooltip}`}
      onClick={(event) => {
        // Клик по ссылке не должен открывать чат-таб карточки —
        // навигация только внутри панели (см. AC #0047 / Implementation
        // notes «Не открывать новые табы»).
        event.stopPropagation();
        props.onNavigate(props.sessionId);
      }}
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-sm border border-border-subtle hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer"
    >
      <SessionLinkIcons icons={summary.icons} />
    </button>
  );
}

/**
 * Иконки участников ссылки. Без аватара-фона и без текста — карточка
 * узкая, ссылок может быть несколько (multi-room: programmer→architect,
 * programmer→product). Используем lucide-иконку напрямую через
 * `roleIcons[role]`, чтобы не плодить аватарную обёртку с фоном.
 *
 * Если иконок нет (legacy-сессия без participants) — рисуем нейтральный
 * placeholder «·», чтобы клик-зона ссылки оставалась видимой.
 */
function SessionLinkIcons(props: { icons: ReadonlyArray<Role> }): ReactNode {
  if (props.icons.length === 0) {
    return (
      <span aria-hidden className="text-muted">
        ·
      </span>
    );
  }
  return (
    <>
      {props.icons.map((role) => {
        const Icon = roleIcons[role];
        return <Icon key={role} size={10} aria-hidden data-meeting-link-icon={role} />;
      })}
    </>
  );
}

/**
 * Цветная точка статуса. AC #0046:
 *  - `active` — зелёная (заливка var(--color-status-active));
 *  - `finished` — нейтральная (var(--vscode-descriptionForeground));
 *  - `paused` — заглушка под #0052: визуально нейтральна, но c
 *    `data-meeting-status="paused"` для будущей доработки.
 *
 * Цвета берём через CSS-переменные, не литералы — иначе при
 * переключении тёмной/светлой темы карточка перестала бы попадать
 * в палитру (см. правила в AGENT.md «Стили webview»).
 */
function StatusDot(props: { kind: 'active' | 'finished' | 'paused' }) {
  const colorVar =
    props.kind === 'active'
      ? 'var(--vscode-testing-iconPassed, #4ade80)'
      : 'var(--vscode-descriptionForeground)';
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full shrink-0"
      style={{ backgroundColor: colorVar }}
    />
  );
}
