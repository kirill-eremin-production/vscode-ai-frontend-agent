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
 * Сообщение в формате OpenAI/OpenRouter Chat Completions.
 * Используем минимально необходимое подмножество ролей —
 * tool-calls и vision добавим, когда дойдём до соответствующих ролей.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
}

/** Результат успешного запроса — только то, что мы реально потребляем. */
export interface ChatResponse {
  /** Финальный текст ответа модели. */
  content: string;
  /** Какая модель фактически ответила (OpenRouter может подменять). */
  model: string;
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
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const content = data.choices?.[0]?.message?.content ?? '';
      // Пустой content формально валиден (модель может вернуть ""),
      // но это почти всегда симптом ошибки — лучше явно просигналить.
      if (!content) {
        throw new OpenRouterError('OpenRouter returned empty content', response.status);
      }

      return {
        content,
        model: data.model ?? request.model,
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
