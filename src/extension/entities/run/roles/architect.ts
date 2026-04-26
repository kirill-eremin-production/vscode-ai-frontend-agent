/**
 * Константы и идентификаторы роли архитектора.
 *
 * По образу [product.ts](./product.ts): role-id, модель, тариф, soft-лимит
 * контекста и жёсткие секции `plan.md`. Разнесено по двум файлам по тем
 * же причинам — длинный prompt живёт в [architect.prompt.ts](./architect.prompt.ts).
 */

/**
 * Идентификатор роли. Совпадает с именем поддиректории kb
 * (`.agents/knowledge/architect/`) — sandbox привязан к этому имени
 * через [role-kb-tools](../../../features/architect-role/role-kb-tools.ts).
 */
export const ARCHITECT_ROLE = 'architect' as const;

/**
 * Модель архитектора.
 *
 * Issue #0004 требует «более умную модель, чем у продакта». Берём
 * `google/gemini-2.5-pro` через OpenRouter — серьёзнее flash-lite и
 * умеет в длинный контекст. По мере появления более выгодных моделей
 * меняем здесь.
 */
export const ARCHITECT_MODEL = 'google/gemini-2.5-pro';

/**
 * Тариф архитекторской модели (USD за 1M токенов). Источник —
 * OpenRouter pricing для `google/gemini-2.5-pro` на 2026-04-26.
 * Если pricing изменится, OpenRouter всё равно вернёт фактическую
 * стоимость в `usage.cost` — эти числа используются `pricing/registry`
 * лишь как fallback для индикатора.
 */
export const ARCHITECT_PRICING = {
  inputPerMTok: 1.25,
  outputPerMTok: 10,
} as const;

/**
 * Soft-limit контекста для индикатора заполненности (тот же подход,
 * что у продакта). Gemini 2.5 Pro имеет жёсткий лимит ~2M, но качество
 * деградирует раньше — берём 200k как у продакта, поднимем при
 * наблюдении.
 */
export const ARCHITECT_CONTEXT_LIMIT_TOKENS = 200_000;

/**
 * Жёсткая структура секций `plan.md`. Используется и в system prompt'е
 * (архитектор обязан выдать ровно эти заголовки), и (в будущем)
 * парсером роли программиста.
 */
export const PLAN_SECTIONS = [
  '## Цели',
  '## Подзадачи',
  '## Архитектурные решения',
  '## Риски и граничные случаи',
  '## Связанные артефакты kb',
] as const;
