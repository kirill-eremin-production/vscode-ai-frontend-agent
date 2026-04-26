import { Component, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, HelpCircle, Wrench } from 'lucide-react';
import type { RunMeta, ToolEvent } from '@shared/runs/types';
import { Avatar, LoadingState, type Role } from '@shared/ui';
import {
  describeRunActivity,
  type RunActivity,
  type RunActivityKind,
} from '@shared/lib/run-status-caption';
import { formatRelativeTime } from '@shared/lib/time';
import { layoutCanvas, type CanvasEdge, type CanvasLayout, type CanvasNode } from '../layout';
import { ownerRoleOfActiveSession, selectActiveSessionForRole } from '../select-active-session';
import { resolveCubeDrillSession } from '../drill-resolver';
import { diffMetaForFlashes, type FlashKind } from '../flashes';

/**
 * Канвас команды агентов (#0023, foundation).
 *
 * Статичный layered-граф: кубики ролей + рёбра handoff'ов. Live-апдейты
 * (#0024), анимация (#0025) и drill-in (#0026) — следующими тикетами.
 *
 * SVG-рендер вручную — у нас 2–4 ноды, react-flow/dagre дают ~200 KB
 * лишнего bundle'а без выгоды. Zoom/pan через мутацию `viewBox` (не
 * CSS-transform), чтобы текст и стрелки оставались чёткими.
 *
 * State zoom/offset — in-memory, без persist (см. issue acceptance).
 */
export interface RunCanvasProps {
  meta: RunMeta;
  tools: ToolEvent[];
  onSwitchToChat?: () => void;
  /**
   * Drill-in (#0026): открыть выбранную сессию на вкладке «Чат». RunCanvas
   * сам решает, какую сессию передать (для кубика — owned-сессия роли,
   * для стрелки — bridgeSessionId), наружу уходит уже готовый sessionId.
   */
  onDrillIn?: (sessionId: string) => void;
}

export function RunCanvas(props: RunCanvasProps) {
  return (
    <CanvasErrorBoundary onSwitchToChat={props.onSwitchToChat}>
      <RunCanvasInner {...props} />
    </CanvasErrorBoundary>
  );
}

function RunCanvasInner({ meta, tools, onDrillIn }: RunCanvasProps) {
  const layout = useMemo(() => layoutCanvas(meta), [meta]);
  // Один тикер на канвас (а не на каждый кубик) — перерасчёт «N мин назад».
  // 60 сек хватает: меньшая разрешающая способность чем у formatRelativeTime.
  const now = useNowTicker(60_000);
  const flashes = useArrowFlashes(meta);
  return (
    <div className="run-canvas relative h-full w-full overflow-hidden bg-[var(--vscode-editor-background)]">
      <CanvasViewport
        layout={layout}
        meta={meta}
        tools={tools}
        now={now}
        flashes={flashes}
        onDrillIn={onDrillIn}
      />
    </div>
  );
}

const FLASH_DURATIONS_MS: Record<FlashKind, number> = {
  appear: 3000,
  message: 1000,
};
const FLASH_DEBOUNCE_MS = 300;

/**
 * Подписка на «вспышки» рёбер канваса (#0025).
 *
 * Diff'им предыдущий и текущий `meta` чистой функцией `diffMetaForFlashes`
 * и держим map `edgeId → flashKind` с автосбросом по таймеру. Все
 * timestamps анимаций — в `setTimeout`, чтобы рендер кубиков и зум-уровень
 * не зависели от тикера времени и оставались стабильными.
 *
 * Историческая «глухота»: первый вызов (prevRef.current === undefined)
 * не порождает событий — иначе при первом монтировании канваса для
 * давно идущего рана все стрелки бы разом «вспыхнули» как новые.
 *
 * Throttle: для одного и того же edgeId не запускаем повторную вспышку
 * чаще, чем раз в 300мс — это снимает визуальный шум при каскадах
 * (5 tool_calls подряд → одна вспышка).
 */
function useArrowFlashes(meta: RunMeta): Map<string, FlashKind> {
  const [active, setActive] = useState<Map<string, FlashKind>>(() => new Map());
  const prevRef = useRef<RunMeta | undefined>(undefined);
  const lastAtRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const events = diffMetaForFlashes(prevRef.current, meta);
    prevRef.current = meta;
    if (events.length === 0) return;

    const now = Date.now();
    const startedThisTick: Array<{ edgeId: string; kind: FlashKind }> = [];
    for (const event of events) {
      const last = lastAtRef.current.get(event.edgeId) ?? 0;
      if (now - last < FLASH_DEBOUNCE_MS) continue;
      lastAtRef.current.set(event.edgeId, now);
      startedThisTick.push(event);
    }
    if (startedThisTick.length === 0) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive((prev) => {
      const next = new Map(prev);
      for (const e of startedThisTick) next.set(e.edgeId, e.kind);
      return next;
    });

    for (const event of startedThisTick) {
      const existing = timersRef.current.get(event.edgeId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timersRef.current.delete(event.edgeId);
        setActive((prev) => {
          if (!prev.has(event.edgeId)) return prev;
          const next = new Map(prev);
          next.delete(event.edgeId);
          return next;
        });
      }, FLASH_DURATIONS_MS[event.kind]);
      timersRef.current.set(event.edgeId, timer);
    }
  }, [meta]);

  // Очистка таймеров при размонтировании, чтобы setActive не вызвался
  // в уже отмонтированном компоненте.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return active;
}

/**
 * Возвращает «текущее время» в виде Date, обновляемое каждые `intervalMs`.
 * Один setInterval на канвас — кубики получают тот же `now` через props,
 * пересчитывают «N минут назад» в render'е без собственного state.
 *
 * Live-region обновлений: смены статуса (`runs.updated` и др.) едут через
 * store и сами триггерят ререндер; этот тикер нужен только для деградации
 * относительного времени, чтобы «1 мин» становился «2 мин» без события.
 */
function useNowTicker(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

function CanvasViewport(props: {
  layout: CanvasLayout;
  meta: RunMeta;
  tools: ToolEvent[];
  now: Date;
  flashes: Map<string, FlashKind>;
  onDrillIn?: (sessionId: string) => void;
}) {
  const { layout } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: layout.width, h: layout.height });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null
  );

  // Респонсивность: следим за фактическим размером контейнера и переcчитываем
  // viewBox без сброса zoom/offset (пользователь не теряет позицию при ресайзе).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  // Сброс по клавише `0` — глобально на window, потому что фокус может
  // быть на кубике/кнопке внутри канваса.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '0' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (nextZoom === zoom) return;
    // Зум центрируем в курсоре: точка под курсором должна остаться на месте.
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const k = nextZoom / zoom;
    setOffset((prev) => ({
      x: cx - (cx - prev.x) * k,
      y: cy - (cy - prev.y) * k,
    }));
    setZoom(nextZoom);
  };

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    // Drag по фону — не по кубикам. Кубики останавливают propagation.
    if (event.button !== 0) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
    };
  };

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setOffset({
        x: drag.baseX + (event.clientX - drag.startX),
        y: drag.baseY + (event.clientY - drag.startY),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // viewBox = (offset / zoom; size / zoom). Один источник трансформации.
  const viewBox = `${-offset.x / zoom} ${-offset.y / zoom} ${size.w / zoom} ${size.h / zoom}`;

  return (
    <div
      ref={containerRef}
      className="run-canvas__viewport h-full w-full cursor-grab active:cursor-grabbing"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      data-canvas-root
    >
      <svg
        className="run-canvas__svg block h-full w-full"
        viewBox={viewBox}
        preserveAspectRatio="xMinYMin meet"
      >
        <defs>
          <marker
            id="canvas-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--vscode-foreground)" opacity="0.65" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <CanvasEdgeView
            key={edge.id}
            edge={edge}
            from={layout.nodes.find((n) => n.role === edge.from)}
            to={layout.nodes.find((n) => n.role === edge.to)}
            flash={props.flashes.get(edge.id)}
            onDrillIn={props.onDrillIn}
          />
        ))}
        {layout.nodes.map((node) => {
          // Резолвим drill-сессию один раз в рендере: это и contract для
          // e2e (через `data-canvas-drill-session` на cube), и одна и та же
          // closure для onClick/onKeyDown — без расхождений между «что
          // показывает атрибут» и «куда уйдёт клик».
          const drillSessionId = props.onDrillIn
            ? resolveCubeDrillSession(node.role, props.meta)
            : undefined;
          return (
            <CanvasNodeView
              key={node.id}
              node={node}
              activity={activityForNode(node, props.meta, props.tools)}
              now={props.now}
              drillSessionId={drillSessionId}
              onDrillIn={
                drillSessionId && props.onDrillIn
                  ? () => props.onDrillIn?.(drillSessionId)
                  : undefined
              }
            />
          );
        })}
      </svg>
      <CanvasZoomControls
        zoom={zoom}
        onZoomIn={() => setZoom((z) => Math.min(MAX_ZOOM, +(z * 1.2).toFixed(2)))}
        onZoomOut={() => setZoom((z) => Math.max(MIN_ZOOM, +(z / 1.2).toFixed(2)))}
        onReset={reset}
      />
    </div>
  );
}

interface CanvasNodeViewProps {
  node: CanvasNode;
  activity: RunActivity;
  now: Date;
  /**
   * Drill-in (#0026): id сессии, в которую уйдёт клик/Enter. Используется
   * для `data-canvas-drill-session` — это контракт для e2e и
   * диагностический атрибут: видно прямо в DOM, какая сессия откроется
   * по клику, без необходимости лезть в runtime-state webview.
   */
  drillSessionId?: string;
  /** Drill-in (#0026): открыть сессию этой роли в чате. */
  onDrillIn?: () => void;
}

/**
 * Кубик роли. memo — чтобы общий тикер `now` не пересоздавал ноду без
 * необходимости (props стабильны: layout пересчитывается только на
 * смену meta, activity — чистая функция от meta+tools).
 *
 * Все `data-canvas-*`-атрибуты — стабильные хуки для e2e (TC-37).
 * Цвет бордера и иконка-бейдж зависят от `activity.kind`:
 *  - failed → красный бордер + AlertCircle;
 *  - awaiting_user → warning-бордер + HelpCircle;
 *  - awaiting_human → нейтральный + бейдж «Готово» (CheckCircle2);
 *  - running thinking/tool → нейтральный + LoadingState внутри;
 *  - idle/done → нейтральный без декораций.
 */
const CanvasNodeView = memo(function CanvasNodeView(props: CanvasNodeViewProps) {
  const { node, activity, now, drillSessionId, onDrillIn } = props;
  const tone = toneForKind(activity.kind);
  const showSpinner = activity.kind === 'thinking' || activity.kind === 'tool';
  const relTime = node.lastActivityAt ? formatRelativeTime(node.lastActivityAt, now) : undefined;
  return (
    <g
      data-canvas-role={node.role}
      data-canvas-activity={activity.kind}
      data-canvas-drill-session={drillSessionId}
      transform={`translate(${node.x}, ${node.y})`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onDrillIn}
      onKeyDown={(e) => {
        if (!onDrillIn) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDrillIn();
        }
      }}
      tabIndex={onDrillIn ? 0 : undefined}
      role={onDrillIn ? 'button' : undefined}
      style={onDrillIn ? { cursor: 'pointer' } : undefined}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={6}
        ry={6}
        fill="var(--vscode-input-background)"
        stroke={tone.borderColor}
        strokeWidth={tone.borderWidth}
      />
      {/* Цветная полоса акцента слева — по роли (см. issue notes) */}
      <rect
        x={0}
        y={0}
        width={4}
        height={node.height}
        rx={2}
        ry={2}
        fill={`var(--color-role-${node.role})`}
      />
      {/* Аватар + имя роли через foreignObject — чтобы переиспользовать React-Avatar */}
      <foreignObject x={12} y={10} width={node.width - 16} height={node.height - 12}>
        <div className="flex flex-col gap-1 text-[12px] leading-tight">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar role={node.role} size="sm" shape="circle" />
            <span className="font-semibold truncate">{ROLE_LABEL[node.role]}</span>
            <CornerBadge kind={activity.kind} />
          </div>
          <div
            className="text-[11px] text-muted truncate"
            data-canvas-activity-label
            title={activity.label}
          >
            {showSpinner ? <LoadingState label={activity.label} /> : activity.label || '—'}
          </div>
          {relTime && (
            <div className="text-[10px] text-muted/80" title={relTime.tooltip}>
              {relTime.label}
            </div>
          )}
        </div>
      </foreignObject>
    </g>
  );
});

interface NodeTone {
  borderColor: string;
  borderWidth: number;
}

function toneForKind(kind: RunActivityKind): NodeTone {
  switch (kind) {
    case 'failed':
      return {
        borderColor: 'var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
        borderWidth: 2,
      };
    case 'awaiting_user':
      return {
        borderColor: 'var(--vscode-inputValidation-warningBorder, var(--vscode-charts-yellow))',
        borderWidth: 2,
      };
    default:
      return {
        borderColor: 'var(--border-subtle, var(--vscode-input-border, #444))',
        borderWidth: 1,
      };
  }
}

/**
 * Уголковая иконка-бейдж в правой части шапки. Только для статусов,
 * которые имеет смысл подсвечивать визуально кроме подписи.
 * `aria-hidden`: смысл уже передан текстом подписи и `role="status"`
 * внутри LoadingState — иконка чисто декоративная.
 */
function CornerBadge({ kind }: { kind: RunActivityKind }): ReactNode {
  const cls = 'ml-auto shrink-0 h-3.5 w-3.5';
  switch (kind) {
    case 'failed':
      return (
        <AlertCircle aria-hidden className={clsx(cls, 'text-[var(--vscode-errorForeground)]')} />
      );
    case 'awaiting_user':
      return <HelpCircle aria-hidden className={clsx(cls, 'text-[var(--vscode-charts-yellow)]')} />;
    case 'awaiting_human':
      return (
        <CheckCircle2 aria-hidden className={clsx(cls, 'text-[var(--vscode-charts-green)]')} />
      );
    case 'tool':
      return <Wrench aria-hidden className={clsx(cls, 'animate-pulse text-muted')} />;
    default:
      return null;
  }
}

function CanvasEdgeView(props: {
  edge: CanvasEdge;
  from: CanvasNode | undefined;
  to: CanvasNode | undefined;
  flash?: FlashKind;
  onDrillIn?: (sessionId: string) => void;
}) {
  const { edge, from, to, flash, onDrillIn } = props;
  if (!from || !to) return null;
  // Drill-in (#0026) активен только если у ребра есть привязка к bridge-
  // сессии — на практике handoff/user-edge всегда привязаны, но пусть
  // тип останется опциональным (страховка от рассинхрона с layout).
  const drill =
    edge.bridgeSessionId && onDrillIn ? () => onDrillIn(edge.bridgeSessionId!) : undefined;
  const fx = from.x + from.width;
  const fy = from.y + from.height / 2;
  const tx = to.x;
  const ty = to.y + to.height / 2;
  const dx = Math.max(40, (tx - fx) / 2);
  const path = `M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  const midX = (fx + tx) / 2;
  const midY = (fy + ty) / 2 - 6;
  // Класс анимации зависит от flash kind. Сам path всегда отрисован —
  // appear-анимация это «дорисовка»: dash-flow вдоль длины (см. CSS),
  // которая поверх обычной линии создаёт ощущение «течения». Для
  // reduced-motion CSS-fallback оставляет только короткое изменение цвета.
  const flashClass = flash
    ? clsx(
        'run-canvas__edge',
        flash === 'appear' && 'run-canvas__edge--appear',
        flash === 'message' && 'run-canvas__edge--message'
      )
    : undefined;
  return (
    <g
      data-canvas-edge={`${edge.from}->${edge.to}`}
      data-canvas-edge-kind={edge.kind}
      data-canvas-edge-session={edge.bridgeSessionId}
      data-arrow-flashing={flash ? 'true' : undefined}
      data-arrow-flash-kind={flash ?? undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={drill}
      onKeyDown={(e) => {
        if (!drill) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          drill();
        }
      }}
      tabIndex={drill ? 0 : undefined}
      role={drill ? 'button' : undefined}
      style={drill ? { cursor: 'pointer' } : undefined}
    >
      <path
        className={flashClass}
        d={path}
        fill="none"
        stroke="var(--vscode-foreground)"
        strokeOpacity={edge.kind === 'user' ? 0.4 : 0.65}
        strokeDasharray={edge.kind === 'user' ? '4 3' : undefined}
        strokeWidth={1.5}
        markerEnd="url(#canvas-arrow)"
      />
      {edge.label && (
        <text
          x={midX}
          y={midY}
          textAnchor="middle"
          fontSize={11}
          fill="var(--vscode-foreground)"
          opacity={0.75}
        >
          {edge.label}
        </text>
      )}
    </g>
  );
}

function CanvasZoomControls(props: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="run-canvas__zoom absolute right-2 bottom-2 flex items-center gap-1 rounded-sm bg-[var(--vscode-input-background)] border border-border-subtle p-1 text-[11px]">
      <button type="button" className="px-1" onClick={props.onZoomOut} title="Уменьшить">
        −
      </button>
      <button
        type="button"
        className="px-1 min-w-[3em]"
        onClick={props.onReset}
        title="Сбросить (0)"
      >
        {Math.round(props.zoom * 100)}%
      </button>
      <button type="button" className="px-1" onClick={props.onZoomIn} title="Увеличить">
        +
      </button>
    </div>
  );
}

const ROLE_LABEL: Record<Role, string> = {
  product: 'Продакт',
  architect: 'Архитектор',
  user: 'Вы',
  system: 'Система',
};

/**
 * Живая активность кубика (#0024). Чистая функция — на канвасе она же
 * пересчитывается на каждый ререндер store'а (`runs.updated` /
 * `runs.message.appended` / `runs.tool.appended`), что и даёт
 * реактивность без отдельной подписки.
 *
 * Логика:
 *  - User-кубик (только в hybrid'е) подсвечен в `awaiting_user_input`
 *    как «слово за тобой», в остальных случаях — нейтральный.
 *  - Кубик роли — описывается статусом «её» сессии. Но живой статус
 *    (thinking/tool) показывается только владельцу активной сессии:
 *    после handoff'а у продакта статус сессии может оставаться, скажем,
 *    `awaiting_human`, но визуально это уже «закончил бриф», а не
 *    активная работа. Так избегаем «двух одновременно работающих»
 *    кубиков на момент handoff'а (см. acceptance).
 */
function activityForNode(node: CanvasNode, meta: RunMeta, tools: ToolEvent[]): RunActivity {
  if (node.role === 'user') {
    if (meta.status === 'awaiting_user_input') {
      return { kind: 'awaiting_user', label: 'Слово за тобой' };
    }
    return { kind: 'idle', label: 'участник' };
  }

  const session = selectActiveSessionForRole(meta, node.role);
  if (!session) return { kind: 'idle', label: '—' };

  const activeOwner = ownerRoleOfActiveSession(meta);
  if (activeOwner !== node.role) {
    return { kind: 'idle', label: idleArtifactLabel(node.role, meta) };
  }

  return describeRunActivity({ meta: { status: session.status }, tools, role: node.role });
}

function idleArtifactLabel(role: Role, meta: RunMeta): string {
  if (role === 'product' && meta.briefPath) return 'закончил бриф';
  if (role === 'architect' && meta.planPath) return 'закончил план';
  return '—';
}

interface CanvasErrorBoundaryProps {
  onSwitchToChat?: () => void;
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  error: Error | undefined;
}

/**
 * Ловит исключения в RunCanvas — если рендер упал, не валит весь webview,
 * а показывает баннер с предложением открыть чат-вкладку (issue acceptance).
 * Класс, потому что хук-эквивалента ErrorBoundary в React пока нет.
 */
class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  constructor(props: CanvasErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined };
  }
  static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('[run-canvas] render failed', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className={clsx(
          'run-canvas__fallback flex flex-col items-start gap-2 p-3 text-[12px]',
          'bg-[var(--vscode-inputValidation-warningBackground)] text-[var(--vscode-foreground)]'
        )}
        role="alert"
      >
        <strong>Карта временно недоступна.</strong>
        <span className="text-muted">{this.state.error.message}</span>
        {this.props.onSwitchToChat && (
          <button
            type="button"
            className="underline text-[var(--vscode-textLink-foreground)]"
            onClick={this.props.onSwitchToChat}
          >
            Открыть вкладку «Чат»
          </button>
        )}
      </div>
    );
  }
}
