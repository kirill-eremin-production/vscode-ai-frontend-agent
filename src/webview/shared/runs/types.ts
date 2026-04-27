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

/**
 * Участник сессии. Зеркало `Participant` из extension/entities/run/types.ts.
 * Используется канвасом команды (#0023) для определения, кого рисовать
 * на каком кубике и куда ведут стрелки handoff'ов.
 *
 * **Длина массива.** После #0034 — произвольная ≥ 1. До этого код мог
 * полагаться на пару (`[0]`/`[1]`/`length === 2`), что блокировало
 * многоучастниковые комнаты (#0036, #0038). Теперь обход — только через
 * `some/filter/map`, индекс по позиции запрещён.
 */
export type Participant = { kind: 'user' } | { kind: 'agent'; role: string };

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * Алиас на `prev[0]` (#0035). Источник правды теперь — массивные
   * `prev`/`next`; поле живёт для обратной совместимости с UI до #0046.
   */
  parentSessionId?: string;
  usage: UsageAggregate;
  /**
   * Список участников сессии. После #0034 extension при чтении meta.json
   * всегда нормализует legacy-формат → массив длины ≥ 1, поэтому в
   * runtime webview видит корректный массив. Поле формально оставлено
   * optional на стороне webview, чтобы юнит-тесты UI могли строить
   * synthetic RunMeta без participants и проверять defensive-ветви
   * (`?? []`) в `layout`/`drill-resolver`/`flashes` — реальные данные
   * из extension'а под условие `!participants` уже не попадают.
   */
  participants?: Participant[];
  /**
   * Метаданные встречи (#0035). На стороне webview оставлены опциональными
   * по той же причине, что и `participants`: extension всегда нормализует
   * их при чтении, но синтетические тестовые RunMeta'ы могут не задавать.
   *
   *  - `inputFrom` — роль/источник, инициировавший сессию (`'user'` для
   *    корневой; для bridge — роль `participants[0]` родителя).
   *  - `prev` — id родительских сессий (для линейной цепочки длина 1).
   *  - `next` — id дочерних сессий (заполняется extension'ом из
   *    обратного индекса).
   */
  inputFrom?: string;
  prev?: string[];
  next?: string[];
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
  /** Путь к brief.md (workspace-relative). Заполняется при финализации продакта. */
  briefPath?: string;
  /** Путь к plan.md (workspace-relative). Заполняется при финализации архитектора. */
  planPath?: string;
  /**
   * Путь к summary.md (workspace-relative). Заполняется тулом
   * `writeSummary` при финализации программиста (#0027).
   */
  summaryPath?: string;
}

/**
 * Облегчённый снимок meeting-request для webview (#0052). Зеркало
 * `MeetingRequestSummary` из IPC-контракта extension'а. Заявки в
 * статусах `resolved`/`failed` сюда не попадают — UI работает только
 * с pending. Поля `requesterRole`/`requesteeRole` хранятся строкой:
 * на стороне webview всегда одна из ролей иерархии (`product`,
 * `architect`, `programmer`); валидация — на стороне extension'а.
 */
export interface MeetingRequestSummary {
  id: string;
  requesterRole: string;
  requesteeRole: string;
  contextSessionId: string;
  message: string;
  createdAt: string;
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
    }
  | {
      /**
       * Системная запись о том, что роль присоединена к сессии-комнате
       * (#0036). Пишется ровно одним вызовом `pullIntoRoom`. UI журнала
       * встреч (#0046) рендерит её отдельным стилем; до тех пор в ленте
       * `RunDetails` запись просто скрывается (см. buildTimeline).
       */
      kind: 'participant_joined';
      at: string;
      /** Роль, которую втащили в комнату — `architect`, `programmer`, … */
      role: string;
    };
