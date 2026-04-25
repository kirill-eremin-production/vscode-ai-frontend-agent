import { useRunsState } from '@shared/runs/store';

/**
 * Карточка деталей выбранного рана — правая колонка экрана.
 *
 * Сейчас рендерит минимум: заголовок, статус, исходный prompt
 * и сырой список сообщений из chat.jsonl. Следующие итерации
 * обогатят этот компонент (роли, артефакты, approve-кнопки),
 * но контракт со стором останется тем же.
 */
export function RunDetails() {
  const { selectedId, selectedDetails } = useRunsState();

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
