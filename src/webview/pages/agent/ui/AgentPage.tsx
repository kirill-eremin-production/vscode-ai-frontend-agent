import { OpenInTabButton } from '@features/open-in-tab';
import { RunCreateForm } from '@features/run-create';
import { RunDetails, RunList } from '@features/run-list';

/**
 * Главная страница webview-агента.
 *
 * По FSD страница — это композиция фич и виджетов в готовый layout.
 * Она НЕ должна содержать собственной бизнес-логики и не должна
 * напрямую звать VS Code API. Если страница начинает «думать» —
 * это сигнал, что логику пора вынести в новую фичу или в `model/`
 * существующей.
 *
 * Layout: сверху — заголовок и кнопка «Open in tab», ниже —
 * двухколоночная зона: слева список ранов и форма создания,
 * справа — детали выбранного. Список и форма находятся в одной
 * колонке, потому что начало работы пользователя естественнее
 * читается сверху вниз: «вот мои раны» → «начать новый».
 */
export function AgentPage() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>AI Frontend Agent</h1>
        <OpenInTabButton />
      </header>
      <div className="app__layout">
        <aside className="app__sidebar">
          <RunCreateForm />
          <RunList />
        </aside>
        <section className="app__main">
          <RunDetails />
        </section>
      </div>
    </main>
  );
}
