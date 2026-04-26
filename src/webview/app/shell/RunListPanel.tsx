import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { IconButton } from '@shared/ui';
import { RunList } from '@features/run-list';
import { setLeftPanelCollapsed, startNewRun } from '@shared/runs/store';

/**
 * Левый сайдбар — список ранов (#0017).
 *
 * Шапка содержит кнопки «+ Новый ран» и «Свернуть» (IconButton из #0016).
 * Composer создания рана из этой панели убран — он переедет в main-area
 * (#0018). До тех пор кнопка «+ Новый ран» переводит main-area в режим
 * `'new-run'` через `startNewRun()`, в котором сейчас отрисовывается
 * заглушка.
 *
 * В свёрнутом состоянии панель остаётся видимой узкой полосой 32px:
 * иконки «+ Новый ран» и «Развернуть» (acceptance #0017). Это даёт
 * пользователю обе ключевые точки входа в один клик, без необходимости
 * сначала разворачивать панель.
 */
export interface RunListPanelProps {
  collapsed: boolean;
}

export function RunListPanel(props: RunListPanelProps) {
  if (props.collapsed) {
    return (
      <aside
        className="flex flex-col items-center gap-1 py-1 border-r border-border bg-surface-elevated"
        aria-label="Список ранов (свёрнут)"
      >
        <IconButton
          aria-label="Развернуть список ранов"
          icon={<ChevronRight size={14} aria-hidden />}
          onClick={() => setLeftPanelCollapsed(false)}
        />
        <IconButton
          aria-label="Новый ран"
          icon={<Plus size={14} aria-hidden />}
          onClick={startNewRun}
        />
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col min-h-0 border-r border-border bg-surface-elevated"
      aria-label="Список ранов"
    >
      <header className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border-subtle">
        <span className="text-[12px] font-semibold leading-none">Раны</span>
        <div className="flex items-center gap-1">
          <IconButton
            aria-label="Новый ран"
            icon={<Plus size={14} aria-hidden />}
            onClick={startNewRun}
          />
          <IconButton
            aria-label="Свернуть список ранов"
            icon={<ChevronLeft size={14} aria-hidden />}
            onClick={() => setLeftPanelCollapsed(true)}
          />
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        <RunList />
      </div>
    </aside>
  );
}
