/**
 * Минимальный fetch-клиент для OpenRouter Chat Completions API.
 *
 * Намеренно не используем SDK: пока проще видеть каждый HTTP-запрос
 * как есть, отлаживать сетевые ошибки и менять параметры. Когда
 * количество ролей вырастет, можно будет завернуть это в более
 * толстый слой, но сейчас — только то, что реально нужно.
 *
 * Без стриминга: первая итерация мульти-агентной системы должна
 * собираться предельно дёшево. Стриминг добавим, когда длинные
 * ответы ролей начнут реально мешать UX.
 *
 * Поддерживает tool-calls в OpenAI-совместимом формате (используется
 * agent-loop): запрос принимает массив `tools`, ответ возвращает
 * `tool_calls` от модели; сообщения с `role: "tool"` подаются обратно
 * на следующей итерации цикла.
 */

/** Идентификатор API OpenRouter — литералом, чтобы было видно в логах. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Заголовки `HTTP-Referer` и `X-Title` опциональны, но OpenRouter
 * рекомендует их заполнять — по ним он показывает источник запросов
 * в дашборде владельца ключа. Захардкожены, потому что расширение
 * у нас одно и публичных ссылок на него пока нет.
 */
const APP_REFERER = 'https://github.com/kirill-eremin-production/vscode-ai-frontend-agent';
const APP_TITLE = 'AI Frontend Agent (VS Code)';

/**
 * Один tool_call от модели в ответе assistant'а. Структура повторяет
 * формат OpenAI/OpenRouter: `id` нужен, чтобы привязать tool_result
 * обратно к этому вызову; `arguments` — JSON-строка (не объект),
 * это особенность протокола, мы парсим её на стороне agent-loop.
 */
export interface ToolCall {
  /** Идентификатор вызова, генерируется моделью. */
  id: string;
  /** Сейчас всегда `'function'` — других типов tool-call в API нет. */
  type: 'function';
  function: {
    /** Имя тула, которое модель решила вызвать. */
    name: string;
    /** Аргументы тула в виде JSON-строки. Парсим уже в agent-loop. */
    arguments: string;
  };
}

/**
 * Сообщение в формате OpenAI/OpenRouter Chat Completions.
 *
 * Дискриминированное по `role`: разные роли несут разные обязательные
 * поля (например, у `tool` есть `tool_call_id`, у `assistant` —
 * опциональные `tool_calls`). Так мы ловим разъезд формата на этапе
 * компиляции, а не в рантайме.
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      /** content может быть `null`, когда модель вызвала только тулы. */
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | {
      role: 'tool';
      /** Привязка к конкретному tool_call.id из предыдущего assistant'а. */
      tool_call_id: string;
      /** Результат тула — обычно JSON-строка с полем `result` или `error`. */
      content: string;
    };

/**
 * Описание тула в формате, который ожидает OpenRouter в поле `tools`
 * запроса. Совпадает с OpenAI tool definition: `parameters` —
 * JSON Schema аргументов.
 */
export interface ToolDefinitionWire {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema аргументов. Здесь — `unknown`, чтобы не плодить генерики. */
    parameters: Record<string, unknown>;
  };
}

/** Параметры одного синхронного запроса в OpenRouter. */
export interface ChatRequest {
  /** Полный slug модели в формате OpenRouter, например `anthropic/claude-haiku-4.5`. */
  model: string;
  /** История сообщений в порядке от системного к последнему пользовательскому. */
  messages: ChatMessage[];
  /** Жёсткий лимит выходных токенов; защищает от случайных «портянок». */
  maxTokens?: number;
  /** Температура (0..2). Не задаём дефолт — пусть сама модель решает. */
  temperature?: number;
  /** Список доступных моделей тулов. Пустой/undefined = чистый chat. */
  tools?: ToolDefinitionWire[];
}

/**
 * Результат успешного запроса — только то, что мы реально потребляем.
 * Возвращаем сразу assistant-сообщение целиком (а не голый content),
 * потому что для tool-loop нужны и `content`, и `tool_calls`.
 */
export interface ChatResponse {
  /** Сообщение assistant'а — уже в формате `ChatMessage`, готово к подаче обратно. */
  message: Extract<ChatMessage, { role: 'assistant' }>;
  /** Какая модель фактически ответила (OpenRouter может подменять). */
  model: string;
  /**
   * Причина остановки модели. `'stop'` — финальный ответ; `'tool_calls'` —
   * модель ждёт результаты тулов и продолжит после них; `'length'` —
   * упёрлись в `maxTokens`.
   */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | string;
  /** Использование токенов, если провайдер вернул эту информацию. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Кастомная ошибка клиента — несёт HTTP-статус, чтобы вызывающий
 * код мог различать `401 invalid key` и сетевые сбои.
 */
export class OpenRouterError extends Error {
  constructor(
    message: string,
    /** HTTP-статус ответа; -1 если запрос вообще не дошёл. */
    public readonly status: number,
    /** Оригинальное тело ответа для диагностики. */
    public readonly body?: string
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Сколько раз повторять при retry-достойных статусах (429/5xx). */
const MAX_RETRIES = 3;
/** Базовая задержка между попытками; реальный sleep = base * 2^attempt. */
const BASE_BACKOFF_MS = 500;

/**
 * Отдельная вспомогательная функция: пауза в миллисекундах.
 * Вынесена ради читаемости retry-цикла; тестировать удобнее, если
 * её можно при необходимости подменить.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Решает, имеет ли смысл повторять запрос.
 * 429 = rate limit, 5xx = временные проблемы провайдера.
 * Всё остальное (400/401/403/404) — это ошибки запроса/ключа,
 * их повтор бесполезен и только спалит лимит.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Выполнить chat completion с автоматическим retry для временных сбоев.
 *
 * @param apiKey  ключ OpenRouter; на этом уровне достаём его уже извне,
 *                чтобы клиент оставался pure-функцией без зависимости от
 *                VS Code SecretStorage.
 * @param request параметры запроса.
 * @returns       нормализованный {@link ChatResponse}.
 * @throws        {@link OpenRouterError} при невосстановимой ошибке.
 */
export async function chat(apiKey: string, request: ChatRequest): Promise<ChatResponse> {
  // Тело запроса собираем явно, чтобы не отправлять undefined-поля
  // и держать payload минимальным и читаемым в DevTools/логах.
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools !== undefined && request.tools.length > 0) body.tools = request.tools;

  let lastError: OpenRouterError | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': APP_REFERER,
          'X-Title': APP_TITLE,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Сетевой сбой — это именно тот случай, когда retry имеет смысл.
      // status = -1 сигнализирует «запрос не дошёл», чтобы внешние
      // потребители могли отличить его от HTTP-ошибок.
      lastError = new OpenRouterError(err instanceof Error ? err.message : 'network error', -1);
      if (attempt < MAX_RETRIES - 1) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      // Парсинг ответа: OpenRouter возвращает структуру, совместимую
      // с OpenAI Chat Completions, поэтому достаём `choices[0]`.
      const data = (await response.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            role?: string;
            content?: string | null;
            tool_calls?: ToolCall[];
          };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const choice = data.choices?.[0];
      const rawMessage = choice?.message;
      const finishReason = choice?.finish_reason ?? 'stop';
      const content = rawMessage?.content ?? null;
      const toolCalls = rawMessage?.tool_calls;

      // Если нет ни текста, ни tool_calls — модель явно сломалась.
      // Лучше явно просигналить, чем тихо вернуть пустой ответ.
      if ((content === null || content === '') && (!toolCalls || toolCalls.length === 0)) {
        throw new OpenRouterError('OpenRouter returned empty assistant message', response.status);
      }

      const message: Extract<ChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };

      return {
        message,
        model: data.model ?? request.model,
        finishReason,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : undefined,
      };
    }

    // Сюда попадаем только при !response.ok. Тело читаем как текст,
    // потому что при ошибках провайдер иногда отдаёт не-JSON (HTML/plain).
    const errorBody = await response.text().catch(() => '');
    lastError = new OpenRouterError(
      `OpenRouter HTTP ${response.status}`,
      response.status,
      errorBody
    );

    // На retry-достойных статусах ждём и пробуем ещё раз.
    // На остальных — сразу пробрасываем, повтор не поможет.
    if (isRetryableStatus(response.status) && attempt < MAX_RETRIES - 1) {
      await delay(BASE_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    throw lastError;
  }

  // Сюда попадаем, если цикл завершился без return/throw — теоретически
  // невозможно, но TypeScript этого не знает. Бросаем накопленную ошибку.
  throw lastError ?? new OpenRouterError('OpenRouter request failed', -1);
}
