import { MainEmptyState, NewRunForm } from '@features/new-run';
import { RunDetails } from '@features/run-list';
import { useRunsState } from '@shared/runs/store';

/**
 * Центральная колонка трёхпанельного shell'а (#0017). Переключается
 * между тремя режимами:
 *
 *  - `'run-details'` — карточка выбранного рана.
 *  - `'new-run'` — экран создания нового рана (#0018, `NewRunForm`).
 *  - `'empty'` — `MainEmptyState`: иконка + CTA «Новый ран».
 *
 * Дерево сессий (#0012) пока остаётся внутри `RunDetails`; переезд в
 * правую панель — задача #0019. До тех пор показываем небольшую
 * подсказку наверху main-area, чтобы пользователь не искал сессии в
 * пустой пока правой панели.
 */
export function MainArea() {
  const { mainAreaMode, selectedId } = useRunsState();

  if (mainAreaMode === 'new-run') {
    return (
      <main className="flex flex-col min-h-0 overflow-auto">
        <NewRunForm />
      </main>
    );
  }

  if (selectedId) {
    return (
      <main className="flex flex-col min-h-0 overflow-auto">
        <p className="px-3 py-1 text-[11px] text-muted border-b border-border-subtle">
          Дерево сессий переедет в правую панель в #0019.
        </p>
        <div className="flex-1 min-h-0 overflow-auto">
          <RunDetails />
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-col min-h-0 overflow-auto">
      <MainEmptyState />
    </main>
  );
}
