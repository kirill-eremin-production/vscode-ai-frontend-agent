/**
 * Константы и идентификаторы роли программиста (issue #0027).
 *
 * По образу [architect.ts](./architect.ts): role-id, модель, тариф,
 * soft-лимит контекста, лимит итераций. Длинный prompt живёт в
 * [programmer.prompt.ts](./programmer.prompt.ts).
 */

/**
 * Идентификатор роли. Совпадает с именем поддиректории kb
 * (`.agents/knowledge/programmer/`) — sandbox привязан к этому имени
 * через [role-kb-tools](../../../features/product-role/role-kb-tools.ts).
 */
export const PROGRAMMER_ROLE = 'programmer' as const;

/**
 * Модель программиста.
 *
 * Issue #0027 требует «сильную code-модель». Берём
 * `anthropic/claude-sonnet-4-6` через OpenRouter — лучший компромисс
 * между качеством патчей и стоимостью на 2026-04-26. По мере появления
 * более выгодных моделей меняем здесь.
 */
export const PROGRAMMER_MODEL = 'anthropic/claude-sonnet-4-6';

/**
 * Тариф модели (USD за 1M токенов). Источник — OpenRouter pricing для
 * `anthropic/claude-sonnet-4-6` на 2026-04-26. Если pricing изменится,
 * OpenRouter всё равно вернёт фактическую стоимость в `usage.cost` —
 * эти числа используются `pricing/registry` лишь как fallback.
 */
export const PROGRAMMER_PRICING = {
  inputPerMTok: 3,
  outputPerMTok: 15,
} as const;

/**
 * Soft-limit контекста для индикатора заполненности. Sonnet 4.6 имеет
 * жёсткий лимит 200k. Берём те же 200k — индикатор станет красным
 * раньше, чем модель реально упрётся в лимит, и пользователь увидит,
 * что пора компактифицироваться.
 */
export const PROGRAMMER_CONTEXT_LIMIT_TOKENS = 200_000;

/**
 * Лимит итераций agent-loop'а программиста.
 *
 * Дефолтные 20 (см. `DEFAULT_MAX_ITERATIONS` в loop.ts) подходят для
 * брифа/плана, где модель за пару раундов отвечает текстом. Программист
 * же реализует множество подзадач: на каждую — `fs.list` → `fs.read` →
 * `fs.grep` → `fs.write`, плюс kb-чтения в начале и `summary` в конце.
 * Даже на одной подзадаче легко уходит 5–7 шагов. Поднимаем до 40 —
 * это всё равно жёсткая anti-runaway граница, но даёт реалистичный
 * запас на 4–6 подзадач без преждевременного срыва.
 */
export const PROGRAMMER_MAX_ITERATIONS = 40;
