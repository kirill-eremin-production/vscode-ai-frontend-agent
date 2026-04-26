import {
  PRODUCT_MODEL,
  PRODUCT_PRICING,
  PRODUCT_CONTEXT_LIMIT_TOKENS,
} from '@ext/entities/run/roles/product';
import {
  ARCHITECT_MODEL,
  ARCHITECT_PRICING,
  ARCHITECT_CONTEXT_LIMIT_TOKENS,
} from '@ext/entities/run/roles/architect';
import {
  PROGRAMMER_MODEL,
  PROGRAMMER_PRICING,
  PROGRAMMER_CONTEXT_LIMIT_TOKENS,
} from '@ext/entities/run/roles/programmer';

/**
 * Реестр тарифов и контекст-лимитов моделей.
 *
 * Зачем отдельный файл вместо «pricing на роли»:
 *  - реестр индексируется по `model` (slug OpenRouter), который
 *    приходит в response — не по роли. Это позволяет поддерживать
 *    подмену модели OpenRouter'ом и корректно посчитать стоимость
 *    того, что реально ответило (`response.model`).
 *  - тестам нужен способ сымитировать «модель без тарифа» (TC-27 в
 *    #0008): сценарий возвращает `model: 'unknown/...'` и реестр
 *    отдаёт `undefined`, стоимость становится `null` — без правки
 *    реального продакта.
 *
 * Литералы значений живут рядом с моделью (`product.ts`): источник
 * правды один. Реестр только связывает «модель → тариф/лимит».
 */

/** Тариф модели в USD за 1M токенов. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Для моделей с скидкой на cached input — опционально. */
  cachedInputPerMTok?: number;
}

/** Использование одного шага модели в нормализованной форме. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Источник правды по моделям. Дополняется по мере появления новых
 * ролей: один новый импорт + одна строка в каждом `*_REGISTRY`.
 */
const PRICING_REGISTRY: Record<string, Pricing> = {
  [PRODUCT_MODEL]: PRODUCT_PRICING,
  [ARCHITECT_MODEL]: ARCHITECT_PRICING,
  [PROGRAMMER_MODEL]: PROGRAMMER_PRICING,
};

const CONTEXT_LIMIT_REGISTRY: Record<string, number> = {
  [PRODUCT_MODEL]: PRODUCT_CONTEXT_LIMIT_TOKENS,
  [ARCHITECT_MODEL]: ARCHITECT_CONTEXT_LIMIT_TOKENS,
  [PROGRAMMER_MODEL]: PROGRAMMER_CONTEXT_LIMIT_TOKENS,
};

/**
 * Тариф модели или undefined, если не зафиксирован. Возвращать `null`
 * специально не стали — `undefined` точнее семантически («неизвестно»),
 * а `null` (стоимость не считается) образуется уже на следующем шаге.
 */
export function pricingFor(model: string): Pricing | undefined {
  return PRICING_REGISTRY[model];
}

/** Soft-лимит контекста для индикатора UI. Undefined — лимит неизвестен. */
export function contextLimitFor(model: string): number | undefined {
  return CONTEXT_LIMIT_REGISTRY[model];
}

/**
 * Посчитать стоимость одного шага. Возвращает `null`, если для модели
 * не зафиксирован тариф (UI показывает «—» вместо 0 — не вводит
 * пользователя в заблуждение).
 *
 * Если у тарифа есть `cachedInputPerMTok` — пока не используется (нет
 * способа отделить cached-input в OpenRouter response единообразно).
 * Заглушка под будущее, не текущая фича.
 */
export function costFor(model: string, usage: Usage): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPerMTok;
  return inputCost + outputCost;
}
