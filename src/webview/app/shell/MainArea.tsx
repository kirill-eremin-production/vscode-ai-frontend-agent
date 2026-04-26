import { MainEmptyState, NewRunForm } from '@features/new-run';
import { useRunsState } from '@shared/runs/store';
import { RunDetails } from './RunDetails';

/**
 * Центральная колонка трёхпанельного shell'а (#0017). Переключается
 * между тремя режимами:
 *
 *  - `'run-details'` — карточка выбранного рана.
 *  - `'new-run'` — экран создания нового рана (#0018, `NewRunForm`).
 *  - `'empty'` — `MainEmptyState`: иконка + CTA «Новый ран».
 *
 * `RunDetails` живёт здесь же, в `app/shell`, а не в `features/run-list`:
 * после #0020 он потребляет `@features/chat`, а сиблингов между фичами
 * импортировать нельзя — поэтому композиция выехала в `app/`.
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
      <main className="flex flex-col min-h-0">
        <RunDetails />
      </main>
    );
  }

  return (
    <main className="flex flex-col min-h-0 overflow-auto">
      <MainEmptyState />
    </main>
  );
}
