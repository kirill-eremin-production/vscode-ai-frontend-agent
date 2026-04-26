/**
 * Public API фичи `canvas` (#0023). Канвас команды агентов: статичные
 * кубики ролей и связи (handoff'ы) между ними. Live, анимация, drill-in
 * — следующие тикеты (#0024–#0026).
 */
export { RunCanvas } from './ui/RunCanvas';
export type { RunCanvasProps } from './ui/RunCanvas';
export { layoutCanvas } from './layout';
export type { CanvasNode, CanvasEdge, CanvasLayout } from './layout';
