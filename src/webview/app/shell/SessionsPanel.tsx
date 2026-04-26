import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from '@shared/ui';
import { setRightPanelCollapsed } from '@shared/runs/store';

/**
 * Правый сайдбар — будущая панель сессий (#0019). На этапе #0017 это
 * заглушка: layout уже трёхколоночный, переключение свёрнут/развёрнут
 * работает, но содержимого пока нет. Дерево сессий, которое сейчас
 * живёт в `RunDetails`, переедет сюда отдельным тикетом.
 *
 * Свёрнутая полоса показывает только «развернуть» — в отличие от
 * левой панели, у этой нет дополнительной горячей кнопки уровня
 * «+ Новый ран» (по acceptance #0017 такая кнопка нужна только слева).
 */
export interface SessionsPanelProps {
  collapsed: boolean;
}

export function SessionsPanel(props: SessionsPanelProps) {
  if (props.collapsed) {
    return (
      <aside
        className="flex flex-col items-center gap-1 py-1 border-l border-border bg-surface-elevated"
        aria-label="Сессии рана (свёрнуто)"
      >
        <IconButton
          aria-label="Развернуть панель сессий"
          icon={<ChevronLeft size={14} aria-hidden />}
          onClick={() => setRightPanelCollapsed(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col min-h-0 border-l border-border bg-surface-elevated"
      aria-label="Сессии рана"
    >
      <header className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border-subtle">
        <span className="text-[12px] font-semibold leading-none">Сессии</span>
        <IconButton
          aria-label="Свернуть панель сессий"
          icon={<ChevronRight size={14} aria-hidden />}
          onClick={() => setRightPanelCollapsed(true)}
        />
      </header>
      <div className="flex-1 overflow-auto p-2 text-[12px] text-muted">
        Sessions panel — TBD #0019
      </div>
    </aside>
  );
}
