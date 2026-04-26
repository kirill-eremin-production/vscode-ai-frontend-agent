/**
 * Типы предметной области рана для webview.
 *
 * Намеренное дублирование с `src/extension/entities/run/types.ts` и
 * `src/extension/entities/run/storage.ts`: ESLint-границы запрещают
 * импорт из extension в webview, и наоборот. Это даёт уверенность,
 * что общий код не утечёт в браузерный бандл. Когда контракт устаканится,
 * можно будет вынести типы в отдельный не-связанный с runtime пакет,
 * но сейчас стоимость дублирования минимальна (один файл).
 */

export type RunStatus =
  | 'draft'
  | 'running'
  | 'awaiting_user_input'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  /**
   * Сессия закрыта компактификацией (#0013) — read-only, доступна
   * через таб. На уровне рана это значение не используется (RunMeta.status
   * всегда отражает статус активной сессии).
   */
  | 'compacted';

/**
 * Агрегат usage — суммарные токены/стоимость за серию assistant-ответов.
 * Зеркало `UsageAggregate` из extension/entities/run/types.ts.
 *
 * `costUsd: null` означает «среди шагов есть модель без зафиксированного
 * тарифа, итог считать нечестно». UI обязан показывать «—», а не «$0».
 *
 * `lastTotalTokens` — оценка «сколько контекста уйдёт в следующий шаг»
 * (на самом деле totalTokens прошлого ответа). Используется в индикаторе
 * заполненности контекста (US-12).
 */
export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastTotalTokens: number;
  lastModel: string | null;
}

/**
 * Лёгкое описание сессии для шапки RunMeta — рендерится как таб.
 * Полный SessionMeta (participants, parentSessionId и т.п.) тут не нужен.
 */
export type SessionKind = 'user-agent' | 'agent-agent';

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  usage: UsageAggregate;
}

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
  /** id текущей активной сессии — UI по умолчанию её и показывает. */
  activeSessionId: string;
  /** Все сессии рана (минимум одна — initial). */
  sessions: SessionSummary[];
  /** Суммарный usage по всем сессиям рана — для шапки. */
  usage: UsageAggregate;
}

/**
 * Зеркало `ToolEvent` из storage.ts. Это лента tool_calls/tool_results/
 * системных диагностик, которую webview мерджит с `chat` по timestamp
 * и рендерит в единой ленте рана (US-11).
 *
 * Дискриминированный union по `kind` — каждый вариант рендерится
 * в карточке рана по-своему: assistant с tool_calls = «🛠 модель
 * позвала тулы», tool_result = «↪ результат», system = «диагностика».
 */
export type ToolEvent =
  | {
      kind: 'assistant';
      at: string;
      /** Текст ответа модели (может быть null, если только tool_calls). */
      content: string | null;
      tool_calls?: Array<{
        id: string;
        name: string;
        /** JSON-строка аргументов — храним как есть, рендер сам распарсит. */
        arguments: string;
      }>;
      /**
       * Usage этого шага. Может отсутствовать у событий до #0008 либо
       * если OpenRouter не вернул `usage` в этом запросе. UI показывает
       * подпись «cost · in/out» только когда поле есть.
       */
      usage?: {
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        /** USD; null = модель без зафиксированного тарифа. */
        costUsd: number | null;
      };
    }
  | {
      kind: 'tool_result';
      at: string;
      tool_call_id: string;
      tool_name: string;
      /** Результат тула при успехе — произвольный JSON-сериализуемый объект. */
      result?: unknown;
      /** Сообщение об ошибке (валидация, sandbox, исключение в handler). */
      error?: string;
    }
  | {
      kind: 'system';
      at: string;
      /** Текст диагностики: лимит итераций, фатальная ошибка цикла, resume-маркер. */
      message: string;
    };
