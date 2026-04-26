/**
 * Public API фичи `chat` (#0020 + #0041). Bubble-сообщение `ChatMessage`
 * и скролл-обёртка `ChatFeed` для ленты диалога. Tool-карточки —
 * пока отдельной фичи нет, рендерятся внутри RunDetails (до #0021).
 *
 * `ParticipantsHeader` — шапка чат-вью со списком аватаров участников
 * сессии. `ParticipantJoinedRow` — компактная строка-системка о вступлении
 * роли в комнату. Оба добавлены в #0041 для отображения N>2 участников.
 */
export { ChatMessage } from './ui/ChatMessage';
export type { ChatMessageProps } from './ui/ChatMessage';
export { ChatFeed } from './ui/ChatFeed';
export type { ChatFeedProps } from './ui/ChatFeed';
export { ToolCard } from './ui/ToolCard';
export type { ToolCardProps, ToolCardStatus } from './ui/ToolCard';
export { ParticipantsHeader } from './ui/ParticipantsHeader';
export type { ParticipantsHeaderProps } from './ui/ParticipantsHeader';
export { ParticipantJoinedRow } from './ui/ParticipantJoinedRow';
export type { ParticipantJoinedRowProps } from './ui/ParticipantJoinedRow';
