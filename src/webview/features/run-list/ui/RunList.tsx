import { selectRun, useRunsState, useRunsWiring } from '@shared/runs/store';

/**
 * Список ранов — левая колонка экрана.
 *
 * Использует `useRunsWiring` ровно один раз: этот хук вешает
 * глобальный обработчик сообщений на window и стартует первый
 * `runs.list`. Решено держать его именно здесь, а не на странице,
 * чтобы фича была самодостаточной и легко переиспользовалась
 * (вставил `<RunList />` — получил рабочий список).
 *
 * Если в будущем `RunDetails` появится на странице БЕЗ `RunList`,
 * хук нужно будет поднять выше. Это известное ограничение, но
 * для текущей композиции корректно.
 */
export function RunList() {
  // Подписка на сообщения extension. Идемпотентна: повторный вызов
  // useEffect внутри хука не создаст дублирующих слушателей.
  useRunsWiring();

  const { runs, selectedId } = useRunsState();

  if (runs.length === 0) {
    return (
      <div className="run-list run-list--empty">
        Пока ни одного рана. Опишите задачу справа и нажмите Start run.
      </div>
    );
  }

  return (
    <ul className="run-list">
      {runs.map((run) => {
        const isSelected = run.id === selectedId;
        return (
          <li key={run.id}>
            <button
              type="button"
              className={'run-list__item' + (isSelected ? ' run-list__item--selected' : '')}
              onClick={() => selectRun(run.id)}
            >
              <span className="run-list__title">{run.title}</span>
              <span className="run-list__meta">
                {new Date(run.createdAt).toLocaleString()} · {run.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
