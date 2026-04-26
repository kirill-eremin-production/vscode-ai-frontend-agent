import { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Network } from 'lucide-react';
import { Badge, IconButton } from '@shared/ui';
import {
  selectSessionsPanelCollapsed,
  selectSession,
  setSessionsPanelCollapsed,
  useRunsState,
} from '@shared/runs/store';
import type { SessionSummary } from '@shared/runs/types';

/**
 * Правая панель — дерево сессий выбранного рана (#0019).
 *
 * Раньше эта логика жила в `RunDetails.tsx` (`SessionTabs`); в #0019
 * она целиком переехала сюда, чтобы основная лента занимала всю ширину
 * main-area, а навигация по сессиям имела отдельную поверхность.
 *
 * Collapsed-state — per-run:
 *  - явный выбор пользователя побеждает (persist через UI-префы);
 *  - иначе fallback по количеству сессий (1 → свёрнуто, больше → нет).
 *  - подробности — в `selectSessionsPanelCollapsed` в store.
 *
 * Компонент сам читает выбранный ран из store: AppShell просто рендерит
 * `<SessionsPanel />` без пропсов и не должен знать о per-run логике.
 */
export function SessionsPanel() {
  const state = useRunsState();
  const collapsed = selectSessionsPanelCollapsed(state);
  const meta = state.selectedDetails?.meta;
  const runId = state.selectedId;
  const sessionsCount = meta?.sessions.length ?? 0;

  // viewedSessionId = что реально показывается в ленте чата. Тот же
  // расчёт, что и в RunDetails: явный выбор или активная сессия рана.
  const viewedSessionId = state.selectedSessionId ?? meta?.activeSessionId ?? '';

  if (collapsed) {
    return (
      <aside
        className="flex flex-col items-center gap-1 py-1 border-l border-border bg-surface-elevated"
        aria-label="Сессии рана (свёрнуто)"
      >
        <IconButton
          aria-label="Развернуть панель сессий"
          icon={<ChevronLeft size={14} aria-hidden />}
          onClick={() => runId && setSessionsPanelCollapsed(runId, false)}
          disabled={!runId}
        />
        <Network size={14} aria-hidden className="text-muted" />
        {sessionsCount > 0 && (
          <Badge
            variant="neutral"
            title={`${sessionsCount} ${pluralizeSessions(sessionsCount)} в этом ране`}
          >
            {sessionsCount}
          </Badge>
        )}
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
          onClick={() => runId && setSessionsPanelCollapsed(runId, true)}
          disabled={!runId}
        />
      </header>
      <div className="flex-1 overflow-auto p-2">
        {meta && runId && meta.sessions.length > 0 ? (
          <SessionTree
            runId={runId}
            sessions={meta.sessions}
            activeSessionId={meta.activeSessionId}
            viewedSessionId={viewedSessionId}
          />
        ) : (
          <p className="text-[11px] text-muted m-0">
            {runId ? 'У этого рана пока нет сессий.' : 'Выберите ран слева.'}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * Дерево вкладок сессий рана (#0012). Корни — сессии без `parentSessionId`,
 * дети — agent↔agent сессии-мосты, рождённые handoff'ом. Логика
 * группировки и сортировки перенесена 1-в-1 из старого `SessionTabs`
 * в `RunDetails.tsx`, чтобы не плодить расхождений (#0019 acceptance).
 */
function SessionTree(props: {
  runId: string;
  sessions: SessionSummary[];
  activeSessionId: string;
  viewedSessionId: string;
}) {
  const tree = useMemo(() => buildSessionTree(props.sessions), [props.sessions]);
  return (
    <nav className="flex flex-col" aria-label="Дерево сессий">
      <SessionTreeLevel
        nodes={tree}
        depth={0}
        runId={props.runId}
        activeSessionId={props.activeSessionId}
        viewedSessionId={props.viewedSessionId}
      />
    </nav>
  );
}

interface SessionNode {
  session: SessionSummary;
  /** Сквозной индекс по всем сессиям рана — для дефолтного label «Чат N». */
  index: number;
  children: SessionNode[];
}

/**
 * Собрать lookup parent → children. Сироты (parentSessionId, чьего родителя
 * нет в списке) поднимаются в корень — иначе невидимыми останутся.
 * Сортируем братьев и сестёр по `createdAt`: время — единственный
 * естественный порядок «как разворачивались события рана».
 */
function buildSessionTree(sessions: SessionSummary[]): SessionNode[] {
  const nodes: SessionNode[] = sessions.map((session, index) => ({
    session,
    index,
    children: [],
  }));
  const nodeById = new Map<string, SessionNode>();
  for (const node of nodes) nodeById.set(node.session.id, node);
  const roots: SessionNode[] = [];
  for (const node of nodes) {
    const parentId = node.session.parentSessionId;
    const parent = parentId ? nodeById.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortByCreated = (a: SessionNode, b: SessionNode) =>
    a.session.createdAt.localeCompare(b.session.createdAt);
  roots.sort(sortByCreated);
  for (const node of nodes) node.children.sort(sortByCreated);
  return roots;
}

function SessionTreeLevel(props: {
  nodes: SessionNode[];
  depth: number;
  runId: string;
  activeSessionId: string;
  viewedSessionId: string;
}) {
  return (
    <ul className="list-none m-0" style={{ paddingLeft: props.depth === 0 ? 0 : 12 }}>
      {props.nodes.map((node) => {
        const isViewed = node.session.id === props.viewedSessionId;
        const isLive = node.session.id === props.activeSessionId;
        const label = sessionLabel(node.session, node.index);
        return (
          <li key={node.session.id} className="my-0.5">
            <button
              type="button"
              aria-pressed={isViewed}
              className={
                'w-full flex items-center justify-between gap-1 px-2 py-1 text-left text-[12px] rounded-sm border ' +
                (isViewed
                  ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)] border-border'
                  : 'bg-transparent text-foreground border-transparent hover:bg-[var(--vscode-list-hoverBackground)]')
              }
              onClick={() => selectSession(props.runId, node.session.id)}
              title={`${label} · статус ${node.session.status}${isLive ? ' · активная' : ''}`}
            >
              <span className="flex items-center gap-1 min-w-0">
                {props.depth > 0 && (
                  <span aria-hidden="true" className="text-muted">
                    ↳
                  </span>
                )}
                <span className="truncate">{label}</span>
                {isLive && (
                  <span aria-label="активная сессия" title="Активная сессия">
                    {' '}
                    ●
                  </span>
                )}
              </span>
              <SessionKindBadge session={node.session} />
            </button>
            {node.children.length > 0 && (
              <SessionTreeLevel
                nodes={node.children}
                depth={props.depth + 1}
                runId={props.runId}
                activeSessionId={props.activeSessionId}
                viewedSessionId={props.viewedSessionId}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SessionKindBadge(props: { session: SessionSummary }) {
  if (props.session.kind === 'agent-agent') {
    return (
      <Badge variant="accent" title="Сессия-мост между агентами">
        🤝 Передача
      </Badge>
    );
  }
  // user-agent — индекс «Чат N» уже в label; в бейдже дублируем kind
  // короткой меткой, чтобы строка читалась одинаково с agent-agent.
  return (
    <Badge variant="neutral" title="Чат пользователя с агентом">
      Чат
    </Badge>
  );
}

/**
 * Имя таба сессии — короткая подсказка о её роли. По `kind`:
 *  - user-agent → «Чат N» (initial — обычно с продактом);
 *  - agent-agent → «Передача» (мост между агентами, после handoff'а).
 */
function sessionLabel(session: SessionSummary, index: number): string {
  if (session.kind === 'agent-agent') return 'Передача';
  return `Чат ${index + 1}`;
}

function pluralizeSessions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сессия';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сессии';
  return 'сессий';
}
