import { Avatar, type Role } from '@shared/ui';
import type { Participant, RunStatus, SessionSummary } from '@shared/runs/types';
import { formatInputFromLabel, formatStartedAt, participantToRole } from '../lib/format';

/**
 * Карточка одной встречи (#0046). Показывает участников аватарами,
 * пометку источника входа `← inputFrom`, время старта, статус и
 * однострочное превью.
 *
 * Карточка — кликабельная (drill-in в чат соответствующей сессии);
 * обработчик клика приходит сверху из {@link MeetingsPanel}, чтобы
 * сама карточка не зависела от store. Это упрощает рендер в
 * Storybook (story передаёт no-op onSelect) и unit-тестирование.
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
  onSelect: (sessionId: string) => void;
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
  const startedLabel = formatStartedAt(props.session.createdAt, props.now);
  const inputFromLabel = formatInputFromLabel(props.session.inputFrom);
  const statusKind = statusKindFor(props.session.status, props.isLive);
  const statusText = STATUS_LABELS[statusKind];
  const titleLabel = `Встреча ${props.index + 1}`;
  const participants = props.session.participants ?? [];

  return (
    <button
      type="button"
      data-meeting-card
      data-session-id={props.session.id}
      data-meeting-status={statusKind}
      aria-pressed={props.isActive}
      onClick={() => props.onSelect(props.session.id)}
      className={
        'w-full flex flex-col gap-1 px-2 py-1.5 text-left text-[12px] rounded-sm border transition-colors ' +
        (props.isActive
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
            data-meeting-input-from={props.session.inputFrom}
            title={inputFromLabel}
          >
            {inputFromLabel}
          </span>
        )}
      </div>
      {props.preview ? (
        <span
          className="text-[11px] text-muted truncate block"
          data-meeting-preview
          title={props.preview}
        >
          {props.preview}
        </span>
      ) : (
        <span className="text-[11px] text-muted truncate block opacity-70">{titleLabel}</span>
      )}
    </button>
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
