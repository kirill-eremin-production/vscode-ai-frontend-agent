/**
 * Публичный API фичи `message-log`.
 * Тип `IncomingMessage` тоже реэкспортируем — он понадобится тем,
 * кто захочет шарить контракт сообщений (например, тестам или
 * будущим фичам, которые добавят свои варианты сообщений).
 */
export { MessageLog } from './ui/MessageLog';
export type { IncomingMessage } from './model/useMessageLog';
