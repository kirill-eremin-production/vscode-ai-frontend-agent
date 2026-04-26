import { OpenInTabButton } from '@features/open-in-tab';
import { SessionsPanel } from '@features/sessions-panel';
import { selectSessionsPanelCollapsed, useRunsState } from '@shared/runs/store';
import { MainArea } from './MainArea';
import { RunListPanel } from './RunListPanel';

/**
 * Корневой layout webview'а — три колонки `[RunListPanel] [MainArea] [SessionsPanel]`
 * (#0017). Левая панель — глобально collapsible через UI-преф; правая
 * (панель сессий) — per-run (#0019), её ширина считается через
 * `selectSessionsPanelCollapsed` от выбранного рана.
 *
 * Ширины колонок управляются CSS Grid через `grid-template-columns`:
 * у крайних колонок два значения — collapsed (32px полоса с иконками)
 * и expanded (~240px). Главная колонка всегда `1fr` — забирает всё
 * оставшееся пространство, в т.ч. при сворачивании любой из боковых.
 *
 * Заголовок «AI Frontend Agent» и кнопка «Open in tab» вынесены в
 * top-bar над сеткой: они должны быть видимы независимо от состояния
 * панелей.
 */
const COLUMN_EXPANDED = '240px';
const COLUMN_COLLAPSED = '32px';

export function AppShell() {
  const state = useRunsState();
  const sessionsCollapsed = selectSessionsPanelCollapsed(state);

  const gridTemplate = `${state.leftPanelCollapsed ? COLUMN_COLLAPSED : COLUMN_EXPANDED} 1fr ${
    sessionsCollapsed ? COLUMN_COLLAPSED : COLUMN_EXPANDED
  }`;

  return (
    <div className="flex flex-col h-screen bg-surface text-foreground">
      <header className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h1 className="text-[13px] font-semibold leading-none">AI Frontend Agent</h1>
        <OpenInTabButton />
      </header>
      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: gridTemplate }}>
        <RunListPanel collapsed={state.leftPanelCollapsed} />
        <MainArea />
        <SessionsPanel />
      </div>
    </div>
  );
}
