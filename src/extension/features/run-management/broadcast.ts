import type { ExtensionToWebviewMessage } from './messages';

/**
 * Module-level event-emitter для исходящих webview-сообщений.
 *
 * Зачем нужен: agent-loop крутится в фоне (запущен из command'а или
 * сервисного слоя) и не имеет прямой ссылки на webview. Sidebar и
 * panel — это два разных webview, оба должны получать одинаковые
 * события (статусы, ask_user, новые сообщения чата).
 *
 * Решение: каждое webview-провод (sidebar/panel) при подключении
 * подписывается через `onBroadcast`, agent-loop'овые источники
 * вызывают `broadcast(msg)` — сообщение уходит во все активные
 * webview одновременно.
 *
 * Не используем `vscode.EventEmitter` — это ровно тот же паттерн,
 * но добавляет vscode-зависимость в чистый модуль типов и сообщений.
 */

/** Подписчик: функция, которой передадим сообщение. */
type Listener = (message: ExtensionToWebviewMessage) => void;

const listeners = new Set<Listener>();

/**
 * Подписаться на исходящие сообщения. Возвращает Disposable —
 * совместимо с `context.subscriptions`.
 */
export function onBroadcast(listener: Listener): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

/**
 * Разослать сообщение во все активные webview. Если webview закрыт —
 * VS Code сам игнорирует postMessage, ловить ошибки не нужно. Но мы
 * оборачиваем в try/catch на случай, если listener сам бросает —
 * один сломанный получатель не должен валить остальных.
 */
export function broadcast(message: ExtensionToWebviewMessage): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {
      // Один сбойный листенер не должен заблокировать остальные.
    }
  }
}
