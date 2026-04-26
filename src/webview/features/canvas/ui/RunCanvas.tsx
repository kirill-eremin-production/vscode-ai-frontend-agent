import { Component, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, HelpCircle, User as UserIcon, Wrench } from 'lucide-react';
import type { RunMeta, ToolEvent } from '@shared/runs/types';
import { Avatar, LoadingState, type Role } from '@shared/ui';
import {
  describeRunActivity,
  type RunActivity,
  type RunActivityKind,
} from '@shared/lib/run-status-caption';
import { formatRelativeTime } from '@shared/lib/time';
import {
  layoutCanvas,
  type CanvasLayout,
  type CanvasNode,
  type CanvasReportingLine,
  type CanvasUserElement,
} from '../layout';
import { ownerRoleOfActiveSession, selectActiveSessionForRole } from '../select-active-session';
import { resolveCubeDrillSession, resolveUserDrillSession } from '../drill-resolver';

/**
 * Канвас команды агентов в виде org-chart'а (#0042).
 *
 * До #0042 здесь был flow-граф с handoff-стрелками и анимациями
 * коммуникации (#0023–#0026). По решению из #0028 flow заменён на
 * иерархию: кубики ролей расположены строго по уровням (`HIERARCHY`),
 * между уровнями — статичные тонкие линии-«репортинги» без стрелок.
 * Реальная история работы команды переехала в журнал встреч (US-29).
 *
 * SVG-рендер вручную — у нас 2–3 кубика, react-flow/dagre дают ~200 KB
 * лишнего bundle'а без выгоды. Zoom/pan через мутацию `viewBox` (не
 * CSS-transform), чтобы текст и линии оставались чёткими.
 *
 * Drill-in (#0026) сохраняется: клик по кубику открывает чат сессии,
 * выбранной `resolveCubeDrillSession`. Стрелки коммуникации удалены
 * вместе с edge-моделью, поэтому drill по edge'ам больше неактуален.
 */
export interface RunCanvasProps {
  meta: RunMeta;
  tools: ToolEvent[];
  onSwitchToChat?: () => void;
  /** Drill-in (#0026): открыть выбранную сессию на вкладке «Чат». */
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
  // Один тикер на канвас — перерасчёт «N мин назад».
  // 60 сек хватает: меньшая разрешающая способность чем у formatRelativeTime.
  const now = useNowTicker(60_000);
  return (
    <div className="run-canvas relative h-full w-full overflow-hidden bg-[var(--vscode-editor-background)]">
      <CanvasViewport layout={layout} meta={meta} tools={tools} now={now} onDrillIn={onDrillIn} />
    </div>
  );
}

/**
 * Возвращает «текущее время» в виде Date, обновляемое каждые `intervalMs`.
 * Один setInterval на канвас — кубики получают тот же `now` через props,
 * пересчитывают «N минут назад» в render'е без собственного state.
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
  // viewBox без сброса zoom/offset.
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
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const ratio = nextZoom / zoom;
    setOffset((prev) => ({
      x: cursorX - (cursorX - prev.x) * ratio,
      y: cursorY - (cursorY - prev.y) * ratio,
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
        {/*
         * Линии-репортинги рисуем первыми, чтобы кубики перекрывали их
         * концы (визуально аккуратнее, чем z-index в SVG).
         * Список приходит из layout'а и зависит только от набора ролей —
         * на каждый poll-tick он не меняется (AC #0042).
         */}
        {layout.reportingLines.map((line) => (
          <CanvasReportingLineView key={line.id} line={line} />
        ))}
        {/*
         * User-блок (#0043): линия от User к продакту такого же стиля,
         * что и межуровневые, и сам круглый аватар. Рендерим линию
         * раньше круга, чтобы аватар перекрывал её конец (как и кубики).
         * Drill-сессия резолвится один раз — это и контракт e2e через
         * `data-canvas-drill-session`, и closure для onClick/onKeyDown.
         */}
        <CanvasReportingLineView line={layout.userElement.line} />
        {(() => {
          const userDrillSessionId = props.onDrillIn
            ? resolveUserDrillSession(props.meta)
            : undefined;
          return (
            <CanvasUserView
              element={layout.userElement}
              drillSessionId={userDrillSessionId}
              onDrillIn={
                userDrillSessionId && props.onDrillIn
                  ? () => props.onDrillIn?.(userDrillSessionId)
                  : undefined
              }
            />
          );
        })()}
        {layout.nodes.map((node) => {
          // Резолвим drill-сессию один раз в рендере: это и contract для
          // e2e (через `data-canvas-drill-session` на cube), и одна и та
          // же closure для onClick/onKeyDown.
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

/**
 * Тонкая статичная линия между двумя соседними уровнями. Без стрелок,
 * без подписей, без анимаций — это org-chart-«репортинг», а не
 * визуализация коммуникации. `aria-hidden` — линия чисто декоративная,
 * её смысл выражают сами кубики (роль и иерархия по y).
 */
function CanvasReportingLineView({ line }: { line: CanvasReportingLine }) {
  return (
    <line
      data-canvas-reporting-line={line.id}
      x1={line.x}
      y1={line.fromY}
      x2={line.x}
      y2={line.toY}
      stroke="var(--border-subtle, var(--vscode-input-border, #444))"
      strokeWidth={1}
      strokeOpacity={0.6}
      aria-hidden
    />
  );
}

interface CanvasUserViewProps {
  element: CanvasUserElement;
  /**
   * id корневой user↔product сессии (#0043). Резолвится в `RunCanvas`
   * через `resolveUserDrillSession`, прокидывается сюда для атрибута
   * `data-canvas-drill-session` (контракт e2e и диагностика DOM) и
   * для замыкания onClick/onKeyDown.
   */
  drillSessionId?: string;
  /** Открыть корневую сессию рана; `undefined` — клик no-op. */
  onDrillIn?: () => void;
}

/**
 * Визуальный элемент User над иерархией агентов (#0043).
 *
 * Круглый аватар + иконка `User` из lucide. Намеренно отличается от
 * кубиков агентов формой (круг, не прямоугольник) и размером
 * (USER_DIAMETER < NODE_H), чтобы передать «User — заказчик, не член
 * команды». Поведение по клавиатуре — то же, что у кубика: Enter/Space
 * = активация, role="button", tabIndex=0. memo — для устойчивости к
 * тикеру времени (props стабильны).
 */
const CanvasUserView = memo(function CanvasUserView(props: CanvasUserViewProps) {
  const { element, drillSessionId, onDrillIn } = props;
  const interactive = Boolean(onDrillIn);
  return (
    <g
      data-canvas-user
      data-canvas-drill-session={drillSessionId}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onDrillIn}
      onKeyDown={(event) => {
        if (!onDrillIn) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onDrillIn();
        }
      }}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      aria-label="Заказчик"
      style={interactive ? { cursor: 'pointer' } : undefined}
    >
      <circle
        cx={element.cx}
        cy={element.cy}
        r={element.radius}
        fill="var(--vscode-input-background)"
        stroke="var(--color-role-user, var(--vscode-focusBorder))"
        strokeWidth={2}
      />
      {/*
       * Иконка через foreignObject — переиспользуем lucide-react как и
       * у кубиков. Bounding box в локальных координатах круга:
       * левый-верхний угол = (cx-r, cy-r), сторона = 2r. Внутри —
       * центрируем иконку flex'ом. Размер иконки чуть меньше диаметра,
       * чтобы оставить визуальный «отступ» внутри круга.
       */}
      <foreignObject
        x={element.cx - element.radius}
        y={element.cy - element.radius}
        width={element.radius * 2}
        height={element.radius * 2}
      >
        <div className="flex h-full w-full items-center justify-center text-foreground">
          <UserIcon size={Math.round(element.radius * 1.1)} aria-hidden />
        </div>
      </foreignObject>
    </g>
  );
});

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
 * Все `data-canvas-*`-атрибуты — стабильные хуки для e2e (TC-37+).
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
      data-canvas-level={node.level}
      transform={`translate(${node.x}, ${node.y})`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onDrillIn}
      onKeyDown={(event) => {
        if (!onDrillIn) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
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
      {/* Цветная полоса акцента слева — по роли */}
      <rect
        x={0}
        y={0}
        width={4}
        height={node.height}
        rx={2}
        ry={2}
        fill={`var(--color-role-${node.role})`}
      />
      {/* Аватар + имя роли через foreignObject — переиспользуем React-Avatar */}
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
  programmer: 'Программист',
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
 *  - Кубик роли описывается статусом «её» сессии. Но живой статус
 *    (thinking/tool) показывается только владельцу активной сессии:
 *    после handoff'а у продакта статус сессии может оставаться, скажем,
 *    `awaiting_human`, но визуально это уже «закончил бриф», а не
 *    активная работа. Так избегаем «двух одновременно работающих»
 *    кубиков на момент handoff'а.
 */
function activityForNode(node: CanvasNode, meta: RunMeta, tools: ToolEvent[]): RunActivity {
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
