import { RunCreateForm } from '@features/run-create';
import { RunDetails } from '@features/run-list';
import { useRunsState } from '@shared/runs/store';

/**
 * Центральная колонка трёхпанельного shell'а (#0017). Переключается
 * между тремя режимами:
 *
 *  - `'run-details'` — карточка выбранного рана (текущий `RunDetails`).
 *    Сюда же попадаем при выборе рана из списка и сразу после успешного
 *    `runs.created`.
 *  - `'new-run'` — экран создания нового рана. Здесь рендерится
 *    существующая `RunCreateForm` из `@features/run-create` — раньше
 *    она жила в сайдбаре; #0018 заменит её более полноценным экраном
 *    (с черновиками, выбором роли и т.п.). До тех пор это та же форма,
 *    просто переехавшая в main-area, чтобы UI-сценарий «создать ран»
 *    не регрессировал.
 *  - `'empty'` — приглашение «выберите ран». Дефолт при первом запуске,
 *    пока пользователь ничего не открыл.
 *
 * Дерево сессий (#0012) пока остаётся внутри `RunDetails`; переезд в
 * правую панель — задача #0019. До тех пор показываем небольшую
 * подсказку наверху main-area, чтобы пользователь не искал сессии в
 * пустой пока правой панели.
 */
export function MainArea() {
  const { mainAreaMode, selectedId } = useRunsState();

  return (
    <main className="flex flex-col min-h-0 overflow-auto">
      {mainAreaMode === 'new-run' ? (
        <div className="p-3">
          <RunCreateForm />
        </div>
      ) : selectedId ? (
        <>
          <p className="px-3 py-1 text-[11px] text-muted border-b border-border-subtle">
            Дерево сессий переедет в правую панель в #0019.
          </p>
          <div className="flex-1 min-h-0 overflow-auto">
            <RunDetails />
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-muted">
      Выберите ран слева или создайте новый.
    </div>
  );
}
