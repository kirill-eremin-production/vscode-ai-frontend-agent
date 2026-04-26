import { useState } from 'react';
import { answerAsk, useRunsState } from '@shared/runs/store';

/**
 * Карточка деталей выбранного рана — правая колонка экрана.
 *
 * Сейчас рендерит: заголовок, статус, исходный prompt, форму ответа
 * на pending `ask_user` (если ран в `awaiting_user_input`) и сырой
 * список сообщений из chat.jsonl. Следующие итерации обогатят этот
 * компонент (роли, артефакты, approve-кнопки), но контракт со стором
 * останется тем же.
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

  const { meta, chat } = selectedDetails;

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
        // key привязан к askId — при смене вопроса компонент пересоздаётся
        // и черновик сбрасывается естественным путём, без useEffect.
        <AskUserForm
          key={pendingAsk.toolCallId}
          runId={meta.id}
          askId={pendingAsk.toolCallId}
          question={pendingAsk.question}
          context={pendingAsk.context}
        />
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
      <section className="run-details__chat">
        <h3>Лента ({chat.length})</h3>
        {chat.length === 0 ? (
          <p>Пока нет сообщений.</p>
        ) : (
          <ul>
            {chat.map((msg) => (
              <li key={msg.id} className="run-details__message">
                <div className="run-details__from">
                  {msg.from} · {new Date(msg.at).toLocaleTimeString()}
                </div>
                <pre>{msg.text}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Форма ответа пользователя на вопрос от агента (`ask_user`).
 *
 * Локальный state для черновика — намеренно не глобальный: вопрос
 * относится к конкретному рану, и при переключении рана черновик
 * терять не страшно. Сброс черновика при смене askId реализован
 * через `key={askId}` у родителя — компонент монтируется заново.
 */
function AskUserForm(props: { runId: string; askId: string; question: string; context?: string }) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    answerAsk(props.runId, props.askId, trimmed);
    // Не очищаем draft руками — store снимет pendingAsk и компонент
    // размонтируется. Если ответ не дошёл (resume не справился), форма
    // вернётся через `runs.askUser`-broadcast, и useEffect выше сбросит
    // черновик автоматически.
  };

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
      <textarea
        className="run-details__ask-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter — отправить (как в большинстве чат-форм).
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ответ пользователя…"
        rows={4}
      />
      <button
        className="run-details__ask-submit"
        type="button"
        onClick={submit}
        disabled={draft.trim().length === 0}
      >
        Ответить
      </button>
    </section>
  );
}
