import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  ChatMessage,
  MeetingRequestSummary,
  RunMeta,
  RunStatus,
  SessionSummary,
} from '@shared/runs/types';
import { Badge, IconButton } from '@shared/ui';
import {
  drillIntoSession,
  selectPendingRequests,
  selectSessionsPanelCollapsed,
  selectSidePanelTab,
  setSessionsPanelCollapsed,
  setSidePanelTab,
  useRunsState,
} from '@shared/runs/store';
import type { SidePanelTab } from '@shared/runs/store';
import { MeetingCard } from './MeetingCard';
import { getFirstMessageText, getMessagePreview, sortMeetingsByCreatedDesc } from '../lib/format';

/**
 * Панель «Встречи» — хронологический список сессий рана (#0046, AC #0029).
 *
 * Поведение:
 *  - читает `selectedDetails.meta.sessions` из общего store, сортирует
 *    по `createdAt` desc (свежие сверху);
 *  - превью одной строки берётся из `selectedDetails.chat`, если эта
 *    сессия — текущая просматриваемая. Backend пока не пушит preview
 *    per session; для остальных карточек показываем нейтральный
 *    fallback «Встреча N» (см. Outcome #0046);
 *  - клик по карточке → drill-in в чат-таб этой сессии. Маршрут
 *    одинаков с canvas (см. {@link drillIntoSession}).
 *
 * Live-обновления приходят из общего store (`runs.updated`,
 * `runs.message.appended`) — компонент сам ничего не подписывает.
 *
 * Шасси (collapse-state + tab-strip) рендерится локально, симметрично
 * `SessionsPanel`. Дублирование на ~30 строк JSX в двух местах
 * сознательное: features/* нельзя импортировать друг из друга
 * (boundaries-плагин, см. `eslint.config.mjs`), а выделять отдельную
 * фичу `side-area` ради двух кнопок переключения преждевременно.
 */
export function MeetingsPanel() {
  const state = useRunsState();
  const collapsed = selectSessionsPanelCollapsed(state);
  const activeTab = selectSidePanelTab(state);
  const meta = state.selectedDetails?.meta;
  const runId = state.selectedId;
  const sessionsCount = meta?.sessions.length ?? 0;

  if (collapsed) {
    return (
      <aside
        className="flex flex-col items-center gap-1 py-1 border-l border-border bg-surface-elevated"
        aria-label="Журнал встреч (свёрнуто)"
        data-side-panel-tab={activeTab}
      >
        <IconButton
          aria-label="Развернуть боковую панель"
          icon={<ChevronLeft size={14} aria-hidden />}
          onClick={() => runId && setSessionsPanelCollapsed(runId, false)}
          disabled={!runId}
        />
        <CalendarDays size={14} aria-hidden className="text-muted" />
        {sessionsCount > 0 && (
          <Badge variant="neutral" title={`${sessionsCount} встреч в этом ране`}>
            {sessionsCount}
          </Badge>
        )}
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col min-h-0 border-l border-border bg-surface-elevated"
      aria-label="Журнал встреч рана"
      data-side-panel-tab={activeTab}
    >
      <header className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border-subtle">
        <SidePanelTabs
          activeTab={activeTab}
          onChange={(next) => runId && setSidePanelTab(runId, next)}
        />
        <IconButton
          aria-label="Свернуть боковую панель"
          icon={<ChevronRight size={14} aria-hidden />}
          onClick={() => runId && setSessionsPanelCollapsed(runId, true)}
          disabled={!runId}
        />
      </header>
      <div className="flex-1 overflow-auto p-2 flex flex-col gap-2">
        <PendingRequestsInbox runId={runId} pendingRequests={selectPendingRequests(state, runId)} />
        <MeetingsPanelBody
          meta={meta}
          runId={runId}
          chat={state.selectedDetails?.chat ?? []}
          pendingRequests={selectPendingRequests(state, runId)}
        />
      </div>
    </aside>
  );
}

interface MeetingsPanelBodyProps {
  meta: RunMeta | undefined;
  runId: string | undefined;
  chat: ReadonlyArray<ChatMessage>;
  /**
   * Pending meeting-requests рана (#0052). Используется для подсветки
   * карточек, чьи `id` совпадает с `contextSessionId` заявки —
   * визуально это «сессия на паузе, инициатор ждёт ответа».
   */
  pendingRequests: ReadonlyArray<MeetingRequestSummary>;
}

/**
 * Длительность визуальной подсветки карточки после перехода по prev/next
 * (#0047 AC: «подсвечивает её на ~1.5s»). Вынесена константой, чтобы
 * unit/e2e-тесты могли при необходимости импортировать (пока не нужно)
 * и чтобы цифра не разъехалась с CSS-переходом outline'а.
 */
const FLASH_DURATION_MS = 1500;

function MeetingsPanelBody(props: MeetingsPanelBodyProps) {
  const now = useNow(30_000);
  const meta = props.meta;
  const runId = props.runId;
  const sessions = useMemo(() => sortMeetingsByCreatedDesc(meta?.sessions ?? []), [meta?.sessions]);

  // Map<contextSessionId, requesteeRole> — для O(1) поиска при рендере
  // карточек. Строится из pending-заявок: каждая заявка «приклеивает»
  // сессию-инициатор к роли-адресату. На один контекст-сессию может
  // быть только одна pending-заявка (тул `team.invite` отбраковывает
  // дубликаты по тому же requestee), поэтому конфликтов не ожидаем.
  const pausedRequesteeBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const request of props.pendingRequests) {
      map.set(request.contextSessionId, request.requesteeRole);
    }
    return map;
  }, [props.pendingRequests]);

  // Индекс «sessionId → сессия» прокидывается в каждую карточку, чтобы
  // SessionLinkRow без обхода массива нашёл соседа по prev/next-id.
  // Memo по списку сессий: при появлении новой live-сессии map
  // пересобирается, на статике остаётся той же ссылкой.
  const sessionsById = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  // Регистр карточек по sessionId — нужен, чтобы по клику prev/next
  // позвать `scrollIntoView` на нужном элементе. Используем ref-объект
  // (а не state), потому что карта DOM-узлов не должна вызывать
  // ре-рендер при изменении.
  const cardElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const setCardElement = useCallback(
    (sessionId: string) => (element: HTMLElement | null) => {
      if (element) {
        cardElementsRef.current.set(sessionId, element);
      } else {
        cardElementsRef.current.delete(sessionId);
      }
    },
    []
  );

  // Подсвеченная сессия + таймер на её снятие. Один setTimeout на
  // всю панель: если пользователь быстро кликает по разным prev/next,
  // предыдущий таймер сбрасывается, чтобы свежая подсветка не
  // снялась раньше времени.
  const [flashSessionId, setFlashSessionId] = useState<string | undefined>();
  const flashTimerRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      // Чистим таймер при unmount панели — иначе если пользователь
      // переключился с meetings на sessions сразу после клика,
      // setFlashSessionId сработает по уже размонтированному компоненту
      // (React выкинет warning).
      if (flashTimerRef.current !== undefined) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = undefined;
      }
    },
    []
  );

  const handleNavigateLink = useCallback((sessionId: string) => {
    const element = cardElementsRef.current.get(sessionId);
    if (!element) return;
    // AC #0047 / Implementation notes: scroll smooth, центрируем —
    // карточка может оказаться у самого верха или у низа, центр
    // визуально корректнее всего показывает «куда мы пришли».
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashSessionId(sessionId);
    if (flashTimerRef.current !== undefined) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashSessionId((current) => (current === sessionId ? undefined : current));
      flashTimerRef.current = undefined;
    }, FLASH_DURATION_MS);
  }, []);

  if (!meta || !runId) {
    return <p className="text-[11px] text-muted m-0">Выберите ран слева.</p>;
  }
  if (sessions.length === 0) {
    return <p className="text-[11px] text-muted m-0">У этого рана пока нет встреч.</p>;
  }

  // viewedSessionId зеркалит логику SessionsPanel/RunDetails: явный
  // выбор пользователя или активная сессия рана. Используется для
  // подсветки текущей карточки.
  const viewedSessionId = meta.activeSessionId;

  const previewByActive = getMessagePreview(props.chat);
  // Первое сообщение просматриваемой сессии — для tooltip'а
  // prev/next-ссылки (см. summarizeSessionForLink). Для остальных
  // сессий per-session preview недоступно; tooltip ограничится временем.
  const firstMessageByViewed = getFirstMessageText(props.chat);

  return (
    <ul className="list-none m-0 p-0 flex flex-col gap-1" data-testid="meetings-list">
      {sessions.map((session, index) => (
        <li key={session.id}>
          <MeetingCard
            session={session}
            index={index}
            isActive={session.id === viewedSessionId}
            isLive={isSessionLive(session, meta)}
            now={now}
            // Превью доступно только для просматриваемой сессии — её
            // chat живёт в store. Для остальных карточек показываем
            // нейтральный fallback (см. MeetingCard).
            preview={session.id === viewedSessionId ? previewByActive : undefined}
            sessionsById={sessionsById}
            viewedSessionId={viewedSessionId}
            viewedSessionFirstMessage={firstMessageByViewed}
            isFlashing={flashSessionId === session.id}
            pausedRequesteeRole={pausedRequesteeBySession.get(session.id)}
            onCardElement={setCardElement(session.id)}
            onSelect={(sessionId) => drillIntoSession(runId, sessionId)}
            onNavigateLink={handleNavigateLink}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Inbox «Заявки на встречи» (#0052). Список pending meeting-request'ов
 * рана: формат «<requesterRole> → <requesteeRole>: <preview>». Клик по
 * элементу делает drill-in в `contextSessionId` — пользователь оказывается
 * в той сессии, где инициатор поставил встречу.
 *
 * Заявок мало (на иерархии #0033 максимум 2-3 в флайт), поэтому скролл
 * не нужен — встраиваем как фиксированную секцию над списком встреч.
 * Полное скрытие на пустом списке (а не «нет заявок» текстом) — иначе
 * inbox занимает вертикаль на всех ранах, где встреч нет вообще.
 */
function PendingRequestsInbox(props: {
  runId: string | undefined;
  pendingRequests: ReadonlyArray<MeetingRequestSummary>;
}) {
  if (!props.runId || props.pendingRequests.length === 0) return null;
  // Сортируем по createdAt asc: «самая старая первой» — ровно та, что
  // первой попадёт в резолв при освобождении адресата (см. meeting-resolver).
  const sorted = [...props.pendingRequests].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
  return (
    <section
      className="flex flex-col gap-1 border border-border-subtle rounded-sm p-2 bg-[var(--vscode-input-background)]"
      data-pending-requests-inbox
      aria-label="Заявки на встречи"
    >
      <header className="text-[11px] text-muted font-semibold">
        Заявки на встречи ({sorted.length})
      </header>
      <ul className="list-none m-0 p-0 flex flex-col gap-1" data-testid="pending-requests-list">
        {sorted.map((request) => (
          <li key={request.id}>
            <PendingRequestRow
              request={request}
              onSelect={() =>
                props.runId && drillIntoSession(props.runId, request.contextSessionId)
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Превью текста заявки. Сообщение инициатора — тот самый параметр
 * `message` тула `team.invite`/`team.escalate`. Длинное превью обрезаем
 * по 80 символам, чтобы инбокс не «прыгал» по высоте.
 */
const REQUEST_PREVIEW_LIMIT = 80;

function PendingRequestRow(props: { request: MeetingRequestSummary; onSelect: () => void }) {
  const { request } = props;
  const preview =
    request.message.length > REQUEST_PREVIEW_LIMIT
      ? request.message.slice(0, REQUEST_PREVIEW_LIMIT - 1) + '…'
      : request.message;
  return (
    <button
      type="button"
      data-pending-request
      data-pending-request-id={request.id}
      data-pending-request-context={request.contextSessionId}
      onClick={props.onSelect}
      title={request.message}
      className={
        'w-full text-left px-2 py-1 text-[11px] rounded-sm border border-transparent ' +
        'hover:bg-[var(--vscode-list-hoverBackground)] focus-visible:outline-none ' +
        'focus-visible:ring-2 focus-visible:ring-[var(--vscode-focusBorder)]'
      }
    >
      <span className="text-muted">{request.requesterRole}</span>
      <span aria-hidden> → </span>
      <span className="text-muted">{request.requesteeRole}</span>
      <span aria-hidden>: </span>
      <span className="text-foreground">{preview}</span>
    </button>
  );
}

/**
 * Tab-strip между «Сессии» и «Встречи» (#0046). Контракт `SidePanelTab`
 * приходит из общего store, обработчик клика отдаёт обратно следующий
 * таб — компонент намеренно stateless, чтобы и `MeetingsPanel`, и
 * `SessionsPanel` могли инлайнить одни и те же кнопки без общей фичи.
 */
function SidePanelTabs(props: { activeTab: SidePanelTab; onChange: (next: SidePanelTab) => void }) {
  const tabs: ReadonlyArray<{ id: SidePanelTab; label: string; title: string }> = [
    { id: 'sessions', label: 'Сессии', title: 'Дерево сессий рана' },
    { id: 'meetings', label: 'Встречи', title: 'Журнал встреч рана' },
  ];
  return (
    <nav className="flex items-center gap-1" role="tablist" aria-label="Разделы боковой панели">
      {tabs.map((tab) => {
        const isActive = tab.id === props.activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-side-panel-tab-button={tab.id}
            onClick={() => props.onChange(tab.id)}
            title={tab.title}
            className={
              'px-2 py-0.5 text-[11px] rounded-sm border ' +
              (isActive
                ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)] border-border'
                : 'bg-transparent text-foreground border-transparent hover:bg-[var(--vscode-list-hoverBackground)]')
            }
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Live-флаг сессии: «активная сессия рана» И ран в одном из
 * рабочих/ожидающих статусов. Совпадение с правилом #0044 cube-state:
 * для канваса live-индикация «есть, что показать» начинается с тех же
 * статусов.
 */
function isSessionLive(session: SessionSummary, meta: RunMeta): boolean {
  if (session.id !== meta.activeSessionId) return false;
  const liveStatuses: RunStatus[] = ['running', 'awaiting_user_input', 'awaiting_human'];
  return liveStatuses.includes(meta.status);
}

/**
 * Хук «текущее время в ms», обновляется по таймеру. Один tick = одна
 * перерисовка панели. 30s — компромисс: relative-метка `Nm ago`
 * меняется минутно, но первое обновление после загрузки покажется не
 * через минуту, а через 0..30s.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
