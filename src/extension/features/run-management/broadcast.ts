import { appendToolEvent, type ToolEvent } from '@ext/entities/run/storage';
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

/**
 * Записать tool-событие в `tools.jsonl` И сразу broadcast'нуть его
 * во все webview. Объединено в одну функцию, потому что эти два
 * действия должны идти строго парой: иначе UI рассинхронизируется
 * с диском (увидит событие до того, как оно записано — и наоборот).
 *
 * Используется agent-loop'ом и tool-handler'ами вместо «голого»
 * `appendToolEvent`. Storage остаётся чистым от знания о webview
 * (его можно дёргать из тестов и CLI без broadcast-побочки).
 */
export async function recordToolEvent(runId: string, event: ToolEvent): Promise<void> {
  await appendToolEvent(runId, event);
  broadcast({ type: 'runs.tool.appended', runId, event });
}
