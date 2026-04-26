/**
 * Public API фичи `canvas`. С #0042 — иерархический org-chart команды
 * агентов: статичные кубики ролей + тонкие линии-«репортинги» между
 * уровнями. Edge-модель и анимации коммуникации удалены — реальная
 * история работы живёт в журнале встреч (#0029, US-29).
 */
export { RunCanvas } from './ui/RunCanvas';
export type { RunCanvasProps } from './ui/RunCanvas';
export { layoutCanvas } from './layout';
export type { CanvasNode, CanvasReportingLine, CanvasLayout, CanvasUserElement } from './layout';
