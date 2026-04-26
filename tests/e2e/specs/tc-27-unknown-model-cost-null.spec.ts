import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer } from '../dsl/scenario';
import { expectRunStatus, expectBriefHasRequiredSections } from '../dsl/run-assertions';

/**
 * TC-27. Модель без зафиксированного тарифа: стоимость = null, ран
 * не падает, токены всё равно посчитаны — US-12 / #0008.
 *
 * Что проверяем:
 *  - в `tools.jsonl` assistant-событие несёт `usage`, но `costUsd: null`
 *    (pricing-registry не знает эту модель);
 *  - агрегат `meta.usage.costUsd` тоже null (правило «один неизвестный
 *    тариф ⇒ итог неизвестен» — иначе UI ввёл бы пользователя в
 *    заблуждение нулевой стоимостью);
 *  - `inputTokens` / `outputTokens` накоплены — модель работала, мы
 *    просто не знаем, сколько она стоит;
 *  - ран нормально доходит до `awaiting_human`, brief на диске.
 *
 * Сценарий минимальный: TITLE (съедает `generateTitle`, не через loop)
 * + финальный бриф через loop. Тест фокусируется на одном assistant-шаге
 * loop'а с неизвестной моделью — этого хватает, чтобы убедиться:
 *   - usage в событии записан, costUsd=null;
 *   - агрегат `meta.usage.costUsd` тоже null;
 *   - inputTokens/outputTokens проставлены.
 *
 * Важно: TITLE не попадает в tools.jsonl, потому что `generateTitle`
 * дёргает OpenRouter напрямую, а не через `runAgentLoop`. Это
 * соответствует поведению любого продактового рана.
 */

const UNKNOWN_MODEL = 'unknown/test-pricing-model';

const PROMPT = 'Сделай счётчик кликов.';
const TITLE = 'Счётчик кликов';

const BRIEF = `# Счётчик кликов

## Проблема
Пользователю нужен счётчик нажатий на кнопку без сохранения состояния.

## Целевой пользователь и сценарий
Любой пользователь; нажимает кнопку, видит число.

## User stories
- Как пользователь, я хочу видеть, сколько раз нажал на кнопку.

## Acceptance criteria
1. Кнопка увеличивает счётчик на 1 за нажатие.

## Не-цели
- Сохранение значения между перезагрузками.

## Связанные артефакты kb
—`;

const STEP_USAGE = { prompt_tokens: 250, completion_tokens: 70, total_tokens: 320 };

test('TC-27: модель без тарифа — costUsd null, ран не падает', async ({ agent }) => {
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE), // вне loop'а, usage в учёт не попадает
      fakeFinalAnswer(BRIEF, { model: UNKNOWN_MODEL, usage: STEP_USAGE })
    )
  );

  await agent.setApiKey();
  await agent.createRun(PROMPT);
  await agent.waitForRunStatus('awaiting_human');

  const run = agent.lastRun();

  expectRunStatus(run, 'awaiting_human');
  expectBriefHasRequiredSections(run);

  // Loop отыграл один шаг (финальный бриф) — assistant-событие с usage,
  // costUsd=null (модель не в реестре).
  const assistantEvents = run.toolEvents.filter((e) => e.kind === 'assistant');
  expect(assistantEvents).toHaveLength(1);
  const event = assistantEvents[0];
  expect(event.usage, 'usage записан, даже если тариф неизвестен').toBeDefined();
  expect(event.usage?.model).toBe(UNKNOWN_MODEL);
  expect(event.usage?.costUsd, 'costUsd null для неизвестной модели').toBeNull();

  // Агрегаты: токены проставлены, стоимость — null. Это и есть основной
  // инвариант TC-27: модель работала, мы посчитали токены, но стоимость
  // показываем как «—», а не «$0».
  const meta = run.meta;
  expect(meta?.usage.inputTokens).toBe(STEP_USAGE.prompt_tokens);
  expect(meta?.usage.outputTokens).toBe(STEP_USAGE.completion_tokens);
  expect(meta?.usage.lastTotalTokens).toBe(STEP_USAGE.total_tokens);
  expect(meta?.usage.lastModel).toBe(UNKNOWN_MODEL);
  expect(meta?.usage.costUsd, 'агрегатная стоимость null при неизвестной модели').toBeNull();
});
