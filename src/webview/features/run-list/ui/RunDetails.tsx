import { useMemo, useState } from 'react';
import { openFile, sendFinalizeSignal, sendUserMessage, useRunsState } from '@shared/runs/store';
import type { ChatMessage, RunStatus, ToolEvent } from '@shared/runs/types';

/**
 * Карточка деталей выбранного рана — правая колонка экрана.
 *
 * Рендерит:
 *  - заголовок и статус;
 *  - блок «Бриф» (если есть `brief.md`);
 *  - баннер активного `ask_user`-вопроса (если ран в `awaiting_user_input`);
 *  - единую ленту: chat.jsonl + tools.jsonl мерджатся по timestamp,
 *    каждое событие — своя «карточка» (см. {@link Timeline});
 *  - постоянный composer для отправки сообщения пользователя.
 *
 * Composer работает в обоих режимах через единый IPC `runs.user.message`:
 *  - `awaiting_user_input` → текст пойдёт ответом на текущий ask_user;
 *  - `awaiting_human` / `failed` → текст продолжит диалог (US-10);
 *  - `running` / `draft` → Send disabled (UX-защита, extension тоже
 *    отбросит на стороне маршрутизации).
 */
export function RunDetails() {
  const { selectedId, selectedDetails, pendingAsk, selectedBrief } = useRunsState();

  if (!selectedId) {
    return <div className="run-details run-details--empty">Выберите ран слева.</div>;
  }
  if (!selectedDetails) {
    // selectedId уже есть, но `runs.get.result` ещё не пришёл —
    // или ран был удалён вручную в файловой системе.
    return <div className="run-details run-details--loading">Загружаю…</div>;
  }

  const { meta, chat, tools } = selectedDetails;

  return (
    <div className="run-details">
      <h2 className="run-details__title">{meta.title}</h2>
      <div className="run-details__status">
        Статус: <code>{meta.status}</code>
      </div>
      <section className="run-details__prompt">
        <h3>Запрос</h3>
        <pre>{meta.prompt}</pre>
      </section>
      {pendingAsk && (
        // Баннер с текущим вопросом — рендерим над лентой, чтобы
        // пользователь не «терял» его в потоке tool_call'ов. Сам
        // ответ вводится в composer ниже (форма не дублируется).
        <AskUserBanner question={pendingAsk.question} context={pendingAsk.context} />
      )}
      {selectedBrief && (
        // Бриф рендерим как сырой markdown в <pre> — внешний markdown-рендер
        // тянуть не хочется ради одного блока. Когда роли начнут давать
        // больше markdown-контента (план архитектора и т.п.), вынесем
        // общий компонент с подсветкой.
        <section className="run-details__brief">
          <h3>Бриф</h3>
          <pre className="run-details__brief-content">{selectedBrief}</pre>
        </section>
      )}
      <Timeline chat={chat} tools={tools} />
      <Composer runId={meta.id} status={meta.status} hasPendingAsk={pendingAsk !== undefined} />
    </div>
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
 *
 * Видим во всех статусах кроме `draft`. Send активен только в
 * `awaiting_user_input` / `awaiting_human` / `failed` — в `running`
 * пользователь видит подсказку, что нужно дождаться шага агента.
 * Сложного queueing «отправь, когда running закончится» намеренно
 * не делаем: проще и предсказуемее дождаться руками.
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
    // Очищаем сразу: сообщение уже ушло в extension, оптимистично
    // пустим composer и подождём отрисовки в ленте через broadcast.
    setDraft('');
  };

  // Подсказка-плейсхолдер зависит от того, что мы сейчас отправляем —
  // пользователь должен видеть смысл своего ввода без чтения статуса.
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
          // Cmd/Ctrl+Enter — отправить (как в большинстве чат-форм).
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
        // US-13: явный сигнал «достаточно вопросов». Доступен только пока
        // на ране висит pending ask_user — иначе кнопке нечего «прерывать».
        // Текст ответа extension подставит сам (PRODUCT_FINALIZE_MARKER).
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
 * `sort` (Array.prototype.sort стабилен в Node ≥12 / V8 7.0+, что
 * покрывает все актуальные runtime'ы webview).
 *
 * Уникальный ключ вычисляется отдельно: у `ChatMessage` есть `id`,
 * у `ToolEvent` — нет, но связка `kind + at + tool_call_id?` практически
 * уникальна в рамках одного рана, т.к. agent-loop пишет события строго
 * последовательно с новым ISO-таймстампом на каждом шаге.
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

/** Один элемент ленты — либо чат, либо tool-событие. */
type TimelineItem =
  | { kind: 'chat'; key: string; at: string; message: ChatMessage }
  | { kind: 'tool'; key: string; at: string; event: ToolEvent };

function mergeTimeline(chat: ChatMessage[], tools: ToolEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const message of chat) {
    items.push({ kind: 'chat', key: `chat:${message.id}`, at: message.at, message });
  }
  tools.forEach((event, index) => {
    // У ToolEvent нет id, но `at` + `kind` + индекс в исходном массиве
    // даёт стабильный ключ для React: даже если у двух событий совпадёт
    // ISO-таймстамп (теоретически возможно при batch-write), индекс
    // гарантирует уникальность в пределах массива tools.
    items.push({
      kind: 'tool',
      key: `tool:${event.kind}:${event.at}:${index}`,
      at: event.at,
      event,
    });
  });
  // Стабильный sort по timestamp. Сообщения с одинаковым `at` сохраняют
  // относительный порядок (chat-первым, потом tools), что естественно
  // для смешанной ленты: пользовательский ввод обычно «опережает»
  // tool-результаты на той же миллисекунде.
  items.sort((left, right) => left.at.localeCompare(right.at));
  return items;
}

/** Простой пузырь чат-сообщения: автор + время + текст. */
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
 *  - assistant: показываем tool_calls как «🛠 модель позвала X (args)».
 *    Голый assistant.content без tool_calls в ленту не выводим — он уже
 *    дублируется в `chat.jsonl` (продакт пишет превью брифа), и второе
 *    отображение визуально дублирует. Если же у assistant есть И content,
 *    И tool_calls — content пропускаем, всё равно в чате будет.
 *  - tool_result: «↪ X → result/error». Если в результате есть `path`
 *    (наш kb.write возвращает `{ ok, path }`), путь — кликабельный.
 *  - system: муттированная строка-диагностика.
 */
function ToolEntry(props: { event: ToolEvent }) {
  const { event } = props;
  const time = new Date(event.at).toLocaleTimeString();

  if (event.kind === 'assistant') {
    if (!event.tool_calls || event.tool_calls.length === 0) {
      // Чистый текст assistant'а уже виден в чате (через chat.jsonl
      // от роли). В технической ленте не дублируем, чтобы не было
      // визуального шума.
      return null;
    }
    return (
      <>
        <div className="run-details__tool-header">🛠 модель вызывает тулы · {time}</div>
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

/** Карточка одного tool_call: имя + свёрнутый JSON-argumentов. */
function ToolCallCard(props: { name: string; argumentsJson: string }) {
  // Аргументы пришли строкой от модели. Пытаемся распарсить и pretty-print'ить;
  // если не вышло (модель прислала невалидный JSON, что бывает) — показываем
  // как есть, без падения.
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

/**
 * Извлечь путь к файлу из произвольного tool_result. Сейчас знаем только
 * `kb.write` (отдаёт `{ ok, path }`), но проверка по форме «есть строковое
 * поле path» накроет и будущие тулы того же контракта (например, write_brief).
 */
function extractFilePath(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const candidate = (result as { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Резолвить путь, который тул отдал относительно kb-корня, в путь от
 * корня workspace. `kb.write` пишет в `.agents/knowledge/`, поэтому
 * именно этот префикс и добавляем. Когда появятся другие тулы с другими
 * корнями — расширим эту функцию (или вынесем мэппинг в отдельный модуль).
 */
function toWorkspacePath(relativeFromKb: string): string {
  return `.agents/knowledge/${relativeFromKb}`;
}

/**
 * JSON.stringify с защитой от циклов и слишком длинных результатов —
 * лента не должна превращаться в стену текста при больших ответах
 * `kb.read`/`kb.grep`.
 */
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
