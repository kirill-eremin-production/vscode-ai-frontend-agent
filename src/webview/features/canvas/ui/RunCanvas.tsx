import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { RunMeta, ToolEvent } from '@shared/runs/types';
import { Avatar, type Role } from '@shared/ui';
import { describeRunActivity } from '@shared/lib/run-status-caption';
import { layoutCanvas, type CanvasEdge, type CanvasLayout, type CanvasNode } from '../layout';

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
}

export function RunCanvas(props: RunCanvasProps) {
  return (
    <CanvasErrorBoundary onSwitchToChat={props.onSwitchToChat}>
      <RunCanvasInner {...props} />
    </CanvasErrorBoundary>
  );
}

function RunCanvasInner({ meta, tools }: RunCanvasProps) {
  const layout = useMemo(() => layoutCanvas(meta), [meta]);
  return (
    <div className="run-canvas relative h-full w-full overflow-hidden bg-[var(--vscode-editor-background)]">
      <CanvasViewport layout={layout} meta={meta} tools={tools} />
    </div>
  );
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

function CanvasViewport(props: { layout: CanvasLayout; meta: RunMeta; tools: ToolEvent[] }) {
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
          />
        ))}
        {layout.nodes.map((node) => (
          <CanvasNodeView
            key={node.id}
            node={node}
            label={labelForNode(node, props.meta, props.tools)}
          />
        ))}
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

function CanvasNodeView(props: { node: CanvasNode; label: string }) {
  const { node, label } = props;
  return (
    <g
      data-canvas-role={node.role}
      transform={`translate(${node.x}, ${node.y})`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={6}
        ry={6}
        fill="var(--vscode-input-background)"
        stroke="var(--border-subtle, var(--vscode-input-border, #444))"
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
          </div>
          <div className="text-[11px] text-muted truncate">{label}</div>
          {node.lastActivityAt && (
            <div className="text-[10px] text-muted/80">{formatTime(node.lastActivityAt)}</div>
          )}
        </div>
      </foreignObject>
    </g>
  );
}

function CanvasEdgeView(props: {
  edge: CanvasEdge;
  from: CanvasNode | undefined;
  to: CanvasNode | undefined;
}) {
  const { edge, from, to } = props;
  if (!from || !to) return null;
  const fx = from.x + from.width;
  const fy = from.y + from.height / 2;
  const tx = to.x;
  const ty = to.y + to.height / 2;
  const dx = Math.max(40, (tx - fx) / 2);
  const path = `M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  const midX = (fx + tx) / 2;
  const midY = (fy + ty) / 2 - 6;
  return (
    <g
      data-canvas-edge={`${edge.from}->${edge.to}`}
      data-canvas-edge-kind={edge.kind}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <path
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

function labelForNode(node: CanvasNode, meta: RunMeta, tools: ToolEvent[]): string {
  if (node.role === 'user') return 'участник';
  const activity = describeRunActivity({ meta, tools, role: node.role });
  return activity.label || 'idle';
}

function formatTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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
