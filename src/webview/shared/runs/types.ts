/**
 * Типы предметной области рана для webview.
 *
 * Намеренное дублирование с `src/extension/entities/run/types.ts`:
 * ESLint-границы запрещают импорт из extension в webview, и наоборот.
 * Это даёт уверенность, что общий код не утечёт в браузерный бандл.
 * Когда контракт устаканится, можно будет вынести типы в отдельный
 * не-связанный с runtime пакет, но сейчас стоимость дублирования
 * минимальна (один файл).
 */

export type RunStatus =
  | 'draft'
  | 'running'
  | 'awaiting_user_input'
  | 'awaiting_human'
  | 'done'
  | 'failed';

/**
 * Описание ожидающего ответа `ask_user`. Зеркало `PendingAsk` из
 * `src/extension/entities/run/storage.ts` (контракт IPC).
 */
export interface PendingAsk {
  toolCallId: string;
  question: string;
  context?: string;
  at: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  at: string;
  text: string;
}

export interface RunMeta {
  id: string;
  title: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}
