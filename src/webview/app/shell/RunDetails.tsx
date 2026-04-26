import { useMemo, useState } from 'react';
import { sendFinalizeSignal, sendUserMessage, useRunsState } from '@shared/runs/store';
import type { ChatMessage, RunMeta, RunStatus, ToolEvent } from '@shared/runs/types';
import { contextLimitFor, zoneFor } from '@shared/runs/pricing';
import { ChatFeed, ChatMessage as ChatBubble, ToolCard } from '@features/chat';
import type { ToolCardStatus } from '@features/chat';

/**
 * Карточка деталей выбранного рана — центральная колонка.
 *
 * После #0020 RunDetails переехал из `features/run-list` в `app/shell`,
 * потому что фичам запрещено импортировать сиблингов: чтобы потреблять
 * `@features/chat`, RunDetails должен жить в композиционном слое.
 *
 * Layout: flex column на всю высоту main-area. Шапка/бриф/план — fixed,
 * `ChatFeed` забирает всё оставшееся пространство со своим скроллом
 * (нужно для авто-скролла к низу), composer — снизу. Рендеринг
 * tool-events временно остаётся здесь же — переедет в #0021.
 */
export function RunDetails() {
  const {
    selectedId,
    selectedSessionId,
    selectedDetails,
    pendingAsk,
    selectedBrief,
    selectedPlan,
  } = useRunsState();

  if (!selectedId) {
    return <div className="p-3 text-muted">Выберите ран слева.</div>;
  }
  if (!selectedDetails) {
    return <div className="p-3 text-muted">Загружаю…</div>;
  }

  const { meta, chat, tools } = selectedDetails;
  const viewedSessionId = selectedSessionId ?? meta.activeSessionId;
  const isViewingActive = viewedSessionId === meta.activeSessionId;

  return (
    <div className="run-details flex flex-col min-h-0 h-full">
      <div className="flex-shrink-0 px-3 py-2 border-b border-border-subtle">
        <h2 className="run-details__title text-[13px] font-semibold m-0">{meta.title}</h2>
        <div className="run-details__status text-[11px] text-muted mt-0.5">
          Статус: <code>{meta.status}</code>
        </div>
        <RunUsageHeader meta={meta} />
        <details className="run-details__prompt mt-1">
          <summary className="text-[11px] text-muted cursor-pointer">Запрос</summary>
          <pre className="text-[11px] mt-1 whitespace-pre-wrap">{meta.prompt}</pre>
        </details>
        {pendingAsk && (
          <AskUserBanner question={pendingAsk.question} context={pendingAsk.context} />
        )}
        {selectedBrief && (
          <details className="run-details__brief mt-1">
            <summary className="text-[11px] text-muted cursor-pointer">Бриф</summary>
            <pre className="text-[11px] mt-1 whitespace-pre-wrap">{selectedBrief}</pre>
          </details>
        )}
        {selectedPlan && (
          <details className="run-details__brief mt-1">
            <summary className="text-[11px] text-muted cursor-pointer">План</summary>
            <pre className="text-[11px] mt-1 whitespace-pre-wrap">{selectedPlan}</pre>
          </details>
        )}
      </div>
      <Timeline chat={chat} tools={tools} sessionId={viewedSessionId} />
      <Composer
        runId={meta.id}
        status={meta.status}
        hasPendingAsk={pendingAsk !== undefined}
        isViewingActive={isViewingActive}
      />
    </div>
  );
}

/**
 * Шапка с агрегатами рана: total cost, токены контекста, индикатор-бар
 * и (disabled на Phase 1) кнопка «Сжать контекст».
 */
function RunUsageHeader(props: { meta: RunMeta }) {
  const usage = props.meta.usage;
  const limit = contextLimitFor(usage.lastModel);
  const ratio = limit && limit > 0 ? Math.min(usage.lastTotalTokens / limit, 1) : 0;
  const zone = zoneFor(ratio);
  const cost = formatCost(usage.costUsd);
  return (
    <section className="run-details__usage flex items-center gap-2 text-[11px] text-muted mt-1 flex-wrap">
      <span title="Сумма по всем сессиям рана">{cost}</span>
      <span>·</span>
      <span>
        {formatTokens(usage.inputTokens)}/{formatTokens(usage.outputTokens)} токенов
      </span>
      <span>·</span>
      {limit ? (
        <>
          <div
            className={`run-details__context-bar run-details__context-bar--${zone} h-1.5 w-20 rounded bg-[var(--vscode-input-background)] overflow-hidden`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={usage.lastTotalTokens}
            title={`${usage.lastTotalTokens.toLocaleString('ru-RU')} / ${limit.toLocaleString('ru-RU')} токенов`}
          >
            <div
              className="run-details__context-fill h-full bg-[var(--vscode-progressBar-background)]"
              style={{ width: `${(ratio * 100).toFixed(1)}%` }}
            />
          </div>
          <span>
            {formatTokens(usage.lastTotalTokens)}/{formatTokens(limit)}
          </span>
        </>
      ) : (
        <span title="Лимит контекста для этой модели не зафиксирован">контекст: ?</span>
      )}
      <button
        className="run-details__compact-btn text-[11px] underline opacity-50"
        type="button"
        disabled
        title="Ручная компактификация контекста — будет в #0013."
      >
        Сжать
      </button>
    </section>
  );
}

function AskUserBanner(props: { question: string; context?: string }) {
  return (
    <section className="run-details__ask mt-2 p-2 rounded-sm border border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)]">
      <h3 className="text-[12px] font-semibold m-0">Вопрос от агента</h3>
      <p className="run-details__ask-question text-[12px] my-1">{props.question}</p>
      {props.context && (
        <details className="run-details__ask-context">
          <summary className="text-[11px] cursor-pointer">Контекст</summary>
          <pre className="text-[11px] mt-1 whitespace-pre-wrap">{props.context}</pre>
        </details>
      )}
      <p className="run-details__ask-hint text-[11px] text-muted m-0">Ответ — в поле ниже.</p>
    </section>
  );
}

function Composer(props: {
  runId: string;
  status: RunStatus;
  hasPendingAsk: boolean;
  isViewingActive: boolean;
}) {
  const [draft, setDraft] = useState('');

  if (props.status === 'draft') return null;

  if (!props.isViewingActive) {
    return (
      <section className="run-details__composer flex-shrink-0 px-3 py-2 border-t border-border-subtle">
        <p className="run-details__composer-hint text-[11px] text-muted m-0">
          Эта сессия — read-only. Чтобы продолжить диалог, вернитесь в активную сессию.
        </p>
      </section>
    );
  }

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
    <section className="run-details__composer flex-shrink-0 flex flex-col gap-1 px-3 py-2 border-t border-border-subtle">
      <textarea
        className="run-details__composer-input w-full p-2 text-[12px] bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-border rounded-sm"
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
      <div className="flex items-center gap-2">
        <button
          className="run-details__composer-submit px-2 py-1 text-[12px] bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] rounded-sm disabled:opacity-50"
          type="button"
          onClick={submit}
          disabled={!sendable || draft.trim().length === 0}
        >
          {props.hasPendingAsk ? 'Ответить' : 'Отправить'}
        </button>
        {props.hasPendingAsk && (
          <button
            className="run-details__composer-finalize px-2 py-1 text-[12px] underline"
            type="button"
            onClick={() => sendFinalizeSignal(props.runId)}
            title="Прекратить вопросы и оформить brief.md"
          >
            Достаточно вопросов, оформляй
          </button>
        )}
      </div>
      {!sendable && (
        <p className="run-details__composer-hint text-[11px] text-muted m-0">
          Агент сейчас работает — поле ввода активируется, когда шаг закончится.
        </p>
      )}
    </section>
  );
}

type AssistantUsage = NonNullable<Extract<ToolEvent, { kind: 'assistant' }>['usage']>;

interface ToolCallTimelineItem {
  kind: 'tool';
  key: string;
  at: string;
  name: string;
  argumentsJson: string;
  status: ToolCardStatus;
  endedAt?: string;
  result?: unknown;
  error?: string;
}

type TimelineItem =
  | { kind: 'chat'; key: string; at: string; message: ChatMessage }
  | { kind: 'system'; key: string; at: string; message: string }
  | { kind: 'usage'; key: string; at: string; usage: AssistantUsage }
  | ToolCallTimelineItem;

/**
 * Единая лента chat + tools (#0020 + #0021).
 *
 * Tool-события парсятся в пары call+result по `tool_call_id` и рендерятся
 * как `<ToolCard>`. Чистый assistant без tool_calls (но с usage) даёт
 * маленькую usage-строку. `kind: 'system'` — однострочная диагностика.
 *
 * Auto-expand: считаем «последняя error-карточка в видимой сессии» —
 * для неё передаём `defaultOpen`. Остальные — свёрнуты по умолчанию,
 * локальный state живёт внутри Collapsible.
 */
function Timeline(props: { chat: ChatMessage[]; tools: ToolEvent[]; sessionId: string }) {
  const items = useMemo(() => buildTimeline(props.chat, props.tools), [props.chat, props.tools]);
  const lastErrorKey = useMemo(() => {
    let key: string | undefined;
    for (const item of items) if (item.kind === 'tool' && item.status === 'error') key = item.key;
    return key;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="run-details__chat flex-1 min-h-0 flex items-center justify-center text-[12px] text-muted">
        Пока нет сообщений.
      </div>
    );
  }

  return (
    <ChatFeed resetKey={props.sessionId} contentKey={items.length}>
      {items.map((item) => {
        if (item.kind === 'chat') return <ChatBubble key={item.key} message={item.message} />;
        if (item.kind === 'system') {
          return (
            <div key={item.key} className="run-details__tool-system text-[11px] text-muted px-1">
              ⓘ {item.message} · {formatTime(item.at)}
            </div>
          );
        }
        if (item.kind === 'usage') {
          return (
            <div
              key={item.key}
              className="run-details__tool-header text-[11px] text-muted px-1"
              title={`Модель: ${item.usage.model} · prompt ${item.usage.promptTokens} · completion ${item.usage.completionTokens}`}
            >
              финальный ответ · {formatCost(item.usage.costUsd)} ·{' '}
              {formatTokens(item.usage.promptTokens)}/{formatTokens(item.usage.completionTokens)}
            </div>
          );
        }
        return (
          <ToolCard
            key={item.key}
            name={item.name}
            argumentsJson={item.argumentsJson}
            startedAt={item.at}
            endedAt={item.endedAt}
            status={item.status}
            result={item.result}
            error={item.error}
            defaultOpen={item.key === lastErrorKey}
          />
        );
      })}
    </ChatFeed>
  );
}

function buildTimeline(chat: ChatMessage[], tools: ToolEvent[]): TimelineItem[] {
  // 1) индексируем tool_result по tool_call_id, чтобы спарить с call'ом
  const resultsById = new Map<
    string,
    { at: string; result?: unknown; error?: string; toolName: string }
  >();
  for (const event of tools) {
    if (event.kind === 'tool_result') {
      resultsById.set(event.tool_call_id, {
        at: event.at,
        result: event.result,
        error: event.error,
        toolName: event.tool_name,
      });
    }
  }

  const items: TimelineItem[] = [];
  for (const message of chat) {
    items.push({ kind: 'chat', key: `chat:${message.id}`, at: message.at, message });
  }
  tools.forEach((event, index) => {
    if (event.kind === 'system') {
      items.push({
        kind: 'system',
        key: `sys:${event.at}:${index}`,
        at: event.at,
        message: event.message,
      });
      return;
    }
    if (event.kind === 'tool_result') return; // склеен в pair с call'ом ниже
    // assistant
    if (!event.tool_calls || event.tool_calls.length === 0) {
      if (event.usage) {
        items.push({
          kind: 'usage',
          key: `usage:${event.at}:${index}`,
          at: event.at,
          usage: event.usage,
        });
      }
      return;
    }
    for (const call of event.tool_calls) {
      const matched = resultsById.get(call.id);
      const status: ToolCardStatus = !matched
        ? 'running'
        : matched.error !== undefined
          ? 'error'
          : 'ok';
      items.push({
        kind: 'tool',
        key: `tool:${call.id}`,
        at: event.at,
        name: call.name,
        argumentsJson: call.arguments,
        status,
        endedAt: matched?.at,
        result: matched?.result,
        error: matched?.error,
      });
    }
  });
  items.sort((left, right) => left.at.localeCompare(right.at));
  return items;
}

function formatTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCost(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
