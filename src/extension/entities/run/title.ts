import { chat } from '@ext/shared/openrouter/client';

/**
 * Генератор короткого заголовка для рана.
 *
 * Модель выбрана по принципу «дешёвая и быстрая»: для одной строки
 * в 3–6 слов её способностей хватает с большим запасом, а каждый ран
 * платит за этот вызов, поэтому экономия осмыслена.
 */
const TITLE_MODEL = 'google/gemini-3.1-flash-lite-preview';

/**
 * System prompt намеренно жёсткий: модель склонна добавлять кавычки,
 * точки, поясняющие префиксы вроде «Заголовок: …». Прямо запрещаем
 * всё это, чтобы можно было использовать ответ как есть.
 *
 * Просим отвечать на языке исходного запроса, а не на английском —
 * это важно для пользователей, которые формулируют задачи по-русски.
 */
const TITLE_SYSTEM_PROMPT = [
  'You produce ultra-short run titles for an AI agent task tracker.',
  'Rules:',
  '- 3 to 6 words',
  '- no quotes, no punctuation at the end, no trailing period',
  '- no prefixes like "Title:", "Task:", just the title itself',
  '- match the language of the user prompt (Russian prompt → Russian title)',
  '- describe what the user wants done, not how',
].join('\n');

/**
 * Запасной заголовок, если cheap-модель упала или вернула мусор.
 * Берём первые ~40 символов исходного запроса — никогда не хуже,
 * чем пустая строка, и сразу даёт понять, о чём ран.
 */
function fallbackTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 40) return trimmed || 'Без названия';
  return trimmed.slice(0, 40) + '…';
}

/**
 * Получить короткий заголовок для рана.
 *
 * Никогда не бросает исключение: если сеть/ключ/модель отказали —
 * возвращаем fallback, потому что отсутствие красивого заголовка
 * не должно блокировать создание рана.
 *
 * @param apiKey ключ OpenRouter, уже прочитанный из SecretStorage.
 * @param prompt исходный запрос пользователя.
 */
export async function generateTitle(apiKey: string, prompt: string): Promise<string> {
  try {
    const response = await chat(apiKey, {
      model: TITLE_MODEL,
      // Низкая температура: заголовки должны быть стабильными
      // и без креатива, иначе модель начинает «художничать».
      temperature: 0.2,
      // Жёсткий лимит — заголовок ну никак не больше ~30 токенов.
      maxTokens: 40,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });

    // Чистим от того, что модель всё-таки иногда добавляет вопреки
    // инструкции: окружающие кавычки, переносы строк, финальные точки.
    // Title-роль не использует тулы, поэтому ожидаем чистый текстовый
    // ответ — `content` гарантированно не null в этой ветке.
    const raw = response.message.content ?? '';
    const cleaned = raw
      .trim()
      .replace(/^["'«»]+|["'«»]+$/g, '')
      .replace(/[.\s]+$/g, '')
      .split('\n')[0]
      .trim();

    return cleaned.length > 0 ? cleaned : fallbackTitle(prompt);
  } catch {
    // Логировать здесь не будем — вызывающий слой увидит, что заголовок
    // пришёл из fallback по факту (можно сравнить с prompt) и при
    // необходимости покажет уведомление.
    return fallbackTitle(prompt);
  }
}
