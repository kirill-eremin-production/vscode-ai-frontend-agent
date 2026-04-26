import { RunDetails } from '@features/run-list';
import { useRunsState } from '@shared/runs/store';

/**
 * Центральная колонка трёхпанельного shell'а (#0017). Переключается
 * между тремя режимами:
 *
 *  - `'run-details'` — карточка выбранного рана (текущий `RunDetails`).
 *    Сюда же попадаем при выборе рана из списка и сразу после успешного
 *    `runs.created`.
 *  - `'new-run'` — экран создания нового рана. Реальная реализация в
 *    #0018; на этом этапе показываем заглушку, чтобы убедиться, что
 *    переключение режимов работает.
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
        <NewRunStub />
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

function NewRunStub() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-muted">
      Форма создания — #0018
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-muted">
      Выберите ран слева или создайте новый.
    </div>
  );
}
