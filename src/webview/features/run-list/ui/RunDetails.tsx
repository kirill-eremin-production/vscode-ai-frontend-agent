import { useMemo, useState } from 'react';
import { openFile, sendFinalizeSignal, sendUserMessage, useRunsState } from '@shared/runs/store';
import type {
  ChatMessage,
  RunMeta,
  RunStatus,
  SessionSummary,
  ToolEvent,
} from '@shared/runs/types';
import { contextLimitFor, zoneFor } from '@shared/runs/pricing';

/**
 * Карточка деталей выбранного рана — правая колонка экрана.
 *
 * Структура (сверху вниз):
 *  - заголовок и статус;
 *  - {@link RunUsageHeader} — суммарная стоимость рана, индикатор
 *    заполненности контекста и кнопка «Сжать» (US-12);
 *  - блок «Запрос» (исходный prompt пользователя);
 *  - {@link SessionTabs} — список сессий рана; на Phase 1 (#0008)
 *    всегда одна, но заводим вкладочный UI заранее, чтобы #0013
 *    (компактификация) подключился без правки разметки;
 *  - {@link AskUserBanner} — баннер pending-вопроса (если есть);
 *  - блок «Бриф» (если `brief.md` уже на диске);
 *  - единая лента chat + tools (см. {@link Timeline});
 *  - постоянный {@link Composer} для отправки сообщений.
 */
export function RunDetails() {
  const { selectedId, selectedDetails, pendingAsk, selectedBrief, selectedPlan } = useRunsState();

  if (!selectedId) {
    return <div className="run-details run-details--empty">Выберите ран слева.</div>;
  }
  if (!selectedDetails) {
    return <div className="run-details run-details--loading">Загружаю…</div>;
  }

  const { meta, chat, tools } = selectedDetails;

  return (
    <div className="run-details">
      <h2 className="run-details__title">{meta.title}</h2>
      <div className="run-details__status">
        Статус: <code>{meta.status}</code>
      </div>
      <RunUsageHeader meta={meta} />
      <section className="run-details__prompt">
        <h3>Запрос</h3>
        <pre>{meta.prompt}</pre>
      </section>
      <SessionTabs sessions={meta.sessions} activeSessionId={meta.activeSessionId} />
      {pendingAsk && <AskUserBanner question={pendingAsk.question} context={pendingAsk.context} />}
      {selectedBrief && (
        <section className="run-details__brief">
          <h3>Бриф</h3>
          <pre className="run-details__brief-content">{selectedBrief}</pre>
        </section>
      )}
      {selectedPlan && (
        <section className="run-details__brief">
          <h3>План</h3>
          <pre className="run-details__brief-content">{selectedPlan}</pre>
        </section>
      )}
      <Timeline chat={chat} tools={tools} />
      <Composer runId={meta.id} status={meta.status} hasPendingAsk={pendingAsk !== undefined} />
    </div>
  );
}

/**
 * Шапка с агрегатами рана: total cost, токены контекста, индикатор-бар
 * и (disabled на Phase 1) кнопка «Сжать контекст».
 *
 * Контекст-индикатор: считаем `lastTotalTokens` относительно soft-лимита
 * модели из локального `contextLimitFor`. Зона (green/yellow/red)
 * подсвечивает срочность сжатия. Если модель неизвестна — бар не
 * рисуем, показываем «контекст: ?» (TC-27).
 */
function RunUsageHeader(props: { meta: RunMeta }) {
  const usage = props.meta.usage;
  const limit = contextLimitFor(usage.lastModel);
  const ratio = limit && limit > 0 ? Math.min(usage.lastTotalTokens / limit, 1) : 0;
  const zone = zoneFor(ratio);
  const cost = formatCost(usage.costUsd);
  return (
    <section className="run-details__usage">
      <div className="run-details__usage-row">
        <span className="run-details__usage-label">Стоимость:</span>
        <span className="run-details__usage-value" title="Сумма по всем сессиям рана">
          {cost}
        </span>
        <span className="run-details__usage-sep">·</span>
        <span className="run-details__usage-label">Токенов (in/out):</span>
        <span className="run-details__usage-value">
          {formatTokens(usage.inputTokens)} / {formatTokens(usage.outputTokens)}
        </span>
      </div>
      <div className="run-details__usage-row">
        <span className="run-details__usage-label">Контекст:</span>
        {limit ? (
          <>
            <div
              className={`run-details__context-bar run-details__context-bar--${zone}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={usage.lastTotalTokens}
              title={`${usage.lastTotalTokens.toLocaleString('ru-RU')} / ${limit.toLocaleString('ru-RU')} токенов`}
            >
              <div
                className="run-details__context-fill"
                style={{ width: `${(ratio * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="run-details__usage-value">
              {formatTokens(usage.lastTotalTokens)} / {formatTokens(limit)}
            </span>
          </>
        ) : (
          <span
            className="run-details__usage-value"
            title="Лимит контекста для этой модели не зафиксирован"
          >
            ?
          </span>
        )}
        <button
          className="run-details__compact-btn"
          type="button"
          disabled
          title="Ручная компактификация контекста — будет в #0013. Кнопка пока неактивна."
        >
          Сжать контекст
        </button>
      </div>
    </section>
  );
}

/**
 * Полоска вкладок сессий рана. На Phase 1 (#0008) сессий всегда одна
 * («Session 1»), но компонент уже отрисовывает строку вкладок —
 * чтобы #0013 (компактификация) сразу же показывал старую и новую
 * сессии без правки markup.
 *
 * Кликабельность отключена для всех вкладок, кроме активной — переход
 * между сессиями требует поддержки read-only ленты, что сделаем
 * следующим тикетом.
 */
function SessionTabs(props: { sessions: SessionSummary[]; activeSessionId: string }) {
  if (props.sessions.length === 0) return null;
  return (
    <nav className="run-details__sessions" aria-label="Сессии рана">
      {props.sessions.map((session, index) => {
        const isActive = session.id === props.activeSessionId;
        const label = `Session ${index + 1}`;
        return (
          <button
            key={session.id}
            type="button"
            className={`run-details__session-tab${isActive ? ' run-details__session-tab--active' : ''}`}
            disabled={!isActive}
            title={`${label} · статус ${session.status} · ${formatTokens(session.usage.inputTokens + session.usage.outputTokens)} токенов`}
          >
            {label}
            {session.status === 'compacted' && (
              <span className="run-details__session-badge"> compacted</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Активный вопрос от агента. Visual-only компонент — поле ввода
 * у нас одно (composer), отдельная форма ответа намеренно не
 * плодится (US-10 acceptance: «отдельной формы не плодим»).
 */
function AskUserBanner(props: { question: string; context?: string }) {
  return (
    <section className="run-details__ask">
      <h3>Вопрос от агента</h3>
      <p className="run-details__ask-question">{props.question}</p>
      {props.context && (
        <details className="run-details__ask-context">
          <summary>Контекст</summary>
          <pre>{props.context}</pre>
        </details>
      )}
      <p className="run-details__ask-hint">Ответ — в поле ниже.</p>
    </section>
  );
}

/**
 * Composer — постоянное поле ввода сообщения пользователя.
 * Видим во всех статусах, кроме `draft`. Send активен только когда
 * extension реально может принять сообщение.
 */
function Composer(props: { runId: string; status: RunStatus; hasPendingAsk: boolean }) {
  const [draft, setDraft] = useState('');

  if (props.status === 'draft') return null;

  const sendable =
    props.status === 'awaiting_user_input' ||
    props.status === 'awaiting_human' ||
    props.status === 'failed';

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || !sendable) return;
    sendUserMessage(props.runId, trimmed);
    setDraft('');
  };

  const placeholder = props.hasPendingAsk
    ? 'Ответ на вопрос агента…'
    : props.status === 'awaiting_human'
      ? 'Дополнить, поправить, продолжить диалог…'
      : props.status === 'failed'
        ? 'Сообщение для повторной попытки…'
        : 'Дождитесь завершения шага агента…';

  return (
    <section className="run-details__composer">
      <textarea
        className="run-details__composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={3}
        disabled={!sendable}
      />
      <button
        className="run-details__composer-submit"
        type="button"
        onClick={submit}
        disabled={!sendable || draft.trim().length === 0}
      >
        {props.hasPendingAsk ? 'Ответить' : 'Отправить'}
      </button>
      {props.hasPendingAsk && (
        <button
          className="run-details__composer-finalize"
          type="button"
          onClick={() => sendFinalizeSignal(props.runId)}
          title="Прекратить вопросы и оформить brief.md, зафиксировав оставшиеся допущения в decisions/"
        >
          Достаточно вопросов, оформляй
        </button>
      )}
      {!sendable && (
        <p className="run-details__composer-hint">
          Агент сейчас работает — поле ввода активируется, когда шаг закончится.
        </p>
      )}
    </section>
  );
}

/**
 * Единая лента chat + tools. Сортируется по timestamp `at` стабильным
 * `sort` (Array.prototype.sort стабилен в Node ≥12 / V8 7.0+).
 */
function Timeline(props: { chat: ChatMessage[]; tools: ToolEvent[] }) {
  const items = useMemo(() => mergeTimeline(props.chat, props.tools), [props.chat, props.tools]);

  return (
    <section className="run-details__chat">
      <h3>Лента ({items.length})</h3>
      {items.length === 0 ? (
        <p>Пока нет сообщений.</p>
      ) : (
        <ul>
          {items.map((item) =>
            item.kind === 'chat' ? (
              <li key={item.key} className="run-details__entry run-details__entry--chat">
                <ChatBubble message={item.message} />
              </li>
            ) : (
              <li key={item.key} className="run-details__entry run-details__entry--tool">
                <ToolEntry event={item.event} />
              </li>
            )
          )}
        </ul>
      )}
    </section>
  );
}

type TimelineItem =
  | { kind: 'chat'; key: string; at: string; message: ChatMessage }
  | { kind: 'tool'; key: string; at: string; event: ToolEvent };

function mergeTimeline(chat: ChatMessage[], tools: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const message of chat) {
    items.push({ kind: 'chat', key: `chat:${message.id}`, at: message.at, message });
  }
  tools.forEach((event, index) => {
    items.push({
      kind: 'tool',
      key: `tool:${event.kind}:${event.at}:${index}`,
      at: event.at,
      event,
    });
  });
  items.sort((left, right) => left.at.localeCompare(right.at));
  return items;
}

function ChatBubble(props: { message: ChatMessage }) {
  return (
    <>
      <div className="run-details__from">
        {props.message.from} · {new Date(props.message.at).toLocaleTimeString()}
      </div>
      <pre>{props.message.text}</pre>
    </>
  );
}

/**
 * Карточка tool-события. Три ветки рендера:
 *  - assistant: tool_calls + per-step usage badge (стоимость и токены
 *    конкретно этого шага — US-12 «каждое assistant подписано стоимостью»);
 *  - tool_result: «↪ X → result/error» с возможной ссылкой на файл;
 *  - system: маленькая строка-диагностика.
 */
function ToolEntry(props: { event: ToolEvent }) {
  const { event } = props;
  const time = new Date(event.at).toLocaleTimeString();

  if (event.kind === 'assistant') {
    if (!event.tool_calls || event.tool_calls.length === 0) {
      // Чистый текст assistant'а уже виден в чате (через chat.jsonl
      // от роли). В технической ленте не дублируем — но usage badge
      // всё равно покажем, если есть: пользователю важно видеть
      // стоимость и финального шага.
      if (event.usage) {
        return (
          <div className="run-details__tool-header">
            🛠 финальный ответ модели · {time}
            <UsageBadge usage={event.usage} />
          </div>
        );
      }
      return null;
    }
    return (
      <>
        <div className="run-details__tool-header">
          🛠 модель вызывает тулы · {time}
          {event.usage && <UsageBadge usage={event.usage} />}
        </div>
        {event.tool_calls.map((call) => (
          <ToolCallCard key={call.id} name={call.name} argumentsJson={call.arguments} />
        ))}
      </>
    );
  }

  if (event.kind === 'tool_result') {
    const filePath = extractFilePath(event.result);
    return (
      <>
        <div className="run-details__tool-header">
          ↪ {event.tool_name} · {time}
          {event.error !== undefined ? (
            <span className="run-details__tool-error"> ошибка</span>
          ) : null}
        </div>
        {event.error !== undefined ? (
          <pre className="run-details__tool-error-text">{event.error}</pre>
        ) : (
          <details className="run-details__tool-result">
            <summary>Результат</summary>
            <pre>{stringifyForPreview(event.result)}</pre>
          </details>
        )}
        {filePath && (
          <button
            className="run-details__file-link"
            type="button"
            onClick={() => openFile(toWorkspacePath(filePath))}
            title="Открыть в редакторе"
          >
            📄 {filePath}
          </button>
        )}
      </>
    );
  }

  // system
  return (
    <div className="run-details__tool-system">
      ⓘ {event.message} · {time}
    </div>
  );
}

/**
 * Маленький badge с usage конкретного шага. Стоимость показываем в USD
 * (или «—» если costUsd null), токены — в формате «in/out».
 */
function UsageBadge(props: {
  usage: NonNullable<Extract<ToolEvent, { kind: 'assistant' }>['usage']>;
}) {
  const cost = formatCost(props.usage.costUsd);
  return (
    <span
      className="run-details__usage-badge"
      title={`Модель: ${props.usage.model} · prompt ${props.usage.promptTokens} · completion ${props.usage.completionTokens}`}
    >
      {' '}
      · {cost} · {formatTokens(props.usage.promptTokens)}/
      {formatTokens(props.usage.completionTokens)}
    </span>
  );
}

function ToolCallCard(props: { name: string; argumentsJson: string }) {
  let pretty = props.argumentsJson;
  try {
    pretty = JSON.stringify(JSON.parse(props.argumentsJson), null, 2);
  } catch {
    // оставим как есть
  }
  return (
    <details className="run-details__tool-call">
      <summary>
        <code>{props.name}</code>
      </summary>
      <pre>{pretty}</pre>
    </details>
  );
}

function extractFilePath(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const candidate = (result as { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function toWorkspacePath(relativeFromKb: string): string {
  return `.agents/knowledge/${relativeFromKb}`;
}

function stringifyForPreview(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  if (serialized.length > 4000) {
    return `${serialized.slice(0, 4000)}\n…\n[обрезано: ${serialized.length} символов всего]`;
  }
  return serialized;
}

/**
 * Форматировать стоимость в USD. `null` показываем как «—» с подписью
 * «тариф не задан» (через title в шапке) — это TC-27 в #0008: модель
 * без зафиксированного тарифа не должна показываться как «$0».
 */
function formatCost(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

/** Компактное форматирование токенов: 1234 → «1.2k», 123 → «123». */
function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
