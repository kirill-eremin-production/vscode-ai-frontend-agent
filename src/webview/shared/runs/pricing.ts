/**
 * Webview-сторона реестра контекст-лимитов моделей.
 *
 * Дублирует extension/shared/pricing/registry.ts по тому же принципу,
 * что и `types.ts`: ESLint-границы запрещают webview импортировать из
 * extension, и наоборот. Когда контракт устаканится — вынесем в общий
 * package. Сейчас цена дубля минимальна (одна константа на модель).
 *
 * Используется индикатором заполненности контекста в RunDetails.
 */

/**
 * Soft-лимит контекста для индикатора UI. Совпадает с
 * `PRODUCT_CONTEXT_LIMIT_TOKENS` из `extension/entities/run/roles/product.ts`.
 * Менять в обоих местах одновременно.
 */
const CONTEXT_LIMIT_REGISTRY: Record<string, number> = {
  'google/gemini-3.1-flash-lite-preview': 200_000,
};

/** Лимит модели или undefined, если не зафиксирован. */
export function contextLimitFor(model: string | null): number | undefined {
  if (!model) return undefined;
  return CONTEXT_LIMIT_REGISTRY[model];
}

/**
 * Зона заполненности по доле от soft-лимита.
 *  - <60% → green: всё ок;
 *  - 60–85% → yellow: пора задуматься о сжатии;
 *  - >85% → red: близко к деградации модели, лучше нажать «Сжать».
 *
 * Границы выбраны эмпирически и совпадают с UX из тикета #0008.
 */
export type ContextZone = 'green' | 'yellow' | 'red';

export function zoneFor(ratio: number): ContextZone {
  if (ratio >= 0.85) return 'red';
  if (ratio >= 0.6) return 'yellow';
  return 'green';
}
