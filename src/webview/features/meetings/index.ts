/**
 * Public API фичи `meetings` (#0046). Журнал встреч — карточки сессий
 * рана с участниками, инициатором, временем и статусом. Панель сама
 * управляет своим collapsed-state через общий store (тот же селектор,
 * что и `SessionsPanel`); side-area-режим переключается tab-strip'ом
 * в её шапке через `setSidePanelTab` (см. `@shared/runs/store`).
 */
export { MeetingsPanel } from './ui/MeetingsPanel';
export { MeetingCard } from './ui/MeetingCard';
export type { MeetingCardProps } from './ui/MeetingCard';
