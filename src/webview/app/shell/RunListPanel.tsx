import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { IconButton, Tooltip } from '@shared/ui';
import { RunList } from '@features/run-list';
import { setLeftPanelCollapsed, startNewRun, useRunsState } from '@shared/runs/store';

/**
 * Левый сайдбар — список ранов (#0017).
 *
 * Шапка содержит кнопки «+ Новый ран» и «Свернуть» (IconButton из #0016).
 * Composer создания рана из этой панели убран в main-area (#0018) —
 * кнопка «+ Новый ран» переводит main-area в режим `'new-run'`.
 *
 * Без открытого workspace кнопка «+ Новый ран» disabled с tooltip
 * «Откройте папку проекта» (US-5 / #0018) — и в раскрытом виде, и в
 * свёрнутой полосе. Сама форма не открывается; иначе пользователь
 * упёрся бы в ошибку storage'а после первого сабмита.
 *
 * В свёрнутом состоянии панель остаётся видимой узкой полосой 32px:
 * иконки «Развернуть» и «+ Новый ран». Это даёт пользователю обе
 * ключевые точки входа в один клик, без необходимости сначала
 * разворачивать панель.
 */
export interface RunListPanelProps {
  collapsed: boolean;
}

const NEW_RUN_DISABLED_TOOLTIP = 'Откройте папку проекта';

export function RunListPanel(props: RunListPanelProps) {
  const { hasWorkspace } = useRunsState();

  // Tooltip из Radix хочет ReactElement в trigger; для disabled-кнопки
  // оборачиваем её в span, иначе hover/focus не ловятся. В enabled-
  // случае tooltip не нужен — родная aria-label из IconButton достаточна.
  const renderNewRunButton = (size: 14) => {
    const button = (
      <IconButton
        aria-label="Новый ран"
        icon={<Plus size={size} aria-hidden />}
        onClick={startNewRun}
        disabled={!hasWorkspace}
      />
    );
    if (hasWorkspace) return button;
    return (
      <Tooltip content={NEW_RUN_DISABLED_TOOLTIP}>
        <span className="inline-flex">{button}</span>
      </Tooltip>
    );
  };

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
        {renderNewRunButton(14)}
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
          {renderNewRunButton(14)}
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
