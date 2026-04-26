/**
 * Public API фичи `chat` (#0020). Bubble-сообщение `ChatMessage`
 * и скролл-обёртка `ChatFeed` для ленты диалога. Tool-карточки —
 * пока отдельной фичи нет, рендерятся внутри RunDetails (до #0021).
 */
export { ChatMessage } from './ui/ChatMessage';
export type { ChatMessageProps } from './ui/ChatMessage';
export { ChatFeed } from './ui/ChatFeed';
export type { ChatFeedProps } from './ui/ChatFeed';
