import { test } from '@playwright/test';
import { expect } from '@playwright/test';
import { makeIsolatedDirs } from '../fixtures/vscode';
import { withVSCodeSession, prepareRestart } from '../dsl/session';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { expectRunStatus, expectBriefHasRequiredSections } from '../dsl/run-assertions';

/**
 * TC-25. Учёт стоимости и токенов накапливается за все шаги agent-loop'а
 * и переживает перезапуск VS Code — US-12 / #0008.
 *
 * Что проверяем:
 *  1) В каждом assistant-событии `tools.jsonl` есть `usage` с
 *     prompt/completion/total и посчитанной costUsd (тариф взят из
 *     `pricing/registry.ts`, который для PRODUCT_MODEL даёт известные
 *     числа; здесь сценарий тоже использует тот же model, чтобы тариф
 *     совпал и costUsd был числом, а не null).
 *  2) `runs/<id>/meta.json` агрегирует usage по всем шагам: суммы
 *     токенов корректны, lastTotalTokens = total последнего ответа.
 *  3) После закрытия и повторного открытия VS Code счётчики на месте
 *     (агрегаты лежат на диске, не в памяти extension host'а).
 *
 * Важно: `generateTitle` (см. service.createRun) дёргает OpenRouter
 * напрямую, **не** через `runAgentLoop`, поэтому первый response сценария
 * (TITLE) не попадает в `tools.jsonl` и в усреднённый usage. Это
 * сознательно — title-генерация сейчас «бесплатная» с точки зрения
 * учёта рана. Когда понадобится считать и её, добавим отдельный механизм
 * (issue-кандидат: #0014). Поэтому сценарий начинаем с TITLE-заглушки,
 * а usage проверяем только по тем шагам, что реально прошли через loop.
 */

const MODEL = 'google/gemini-3.1-flash-lite-preview';

const PROMPT = 'Сделай простую todo-страницу.';
const TITLE = 'Todo-страница';
const QUESTION = 'Должны ли задачи группироваться по тегам?';
const USER_ANSWER = 'Нет, плоский список.';

const BRIEF = `# Todo-страница

## Проблема
Пользователю некуда быстро записать задачу.

## Целевой пользователь и сценарий
Любой пользователь сайта; добавляет задачу, отмечает выполненной.

## User stories
- Как пользователь, я хочу добавить задачу одной строкой.

## Acceptance criteria
1. Список задач плоский, без группировки.
2. Задача может быть отмечена выполненной.

## Не-цели
- Совместный доступ к задачам.

## Связанные артефакты kb
—`;

// Сценарий: [TITLE, ask_user, BRIEF].
//  - TITLE съест `generateTitle` (вне loop'а) — usage не учитываем;
//  - ask_user съест первая итерация loop'а в session 1, шаг попадёт
//    в tools.jsonl с usage'ем;
//  - BRIEF съест resume в session 2 — второй шаг с usage'ем.
// Числа разные у двух loop-шагов — чтобы суммы можно было отличить от
// значений последнего шага.
const STEP1_USAGE = { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 };
const STEP2_USAGE = { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480 };

const FULL_SCENARIO = scenario(
  fakeFinalAnswer(TITLE), // вне loop'а, usage в учёт не попадает
  fakeToolCall('ask_user', { question: QUESTION }, 'call_ask', {
    model: MODEL,
    usage: STEP1_USAGE,
  }),
  fakeFinalAnswer(BRIEF, { model: MODEL, usage: STEP2_USAGE })
);

// PRICING для MODEL: input 0.25 / output 1.50 за 1M.
const expectedCost = (u: { prompt_tokens: number; completion_tokens: number }) =>
  (u.prompt_tokens / 1_000_000) * 0.25 + (u.completion_tokens / 1_000_000) * 1.5;

// eslint-disable-next-line no-empty-pattern -- Playwright API требует destructuring-параметр; фикстуры здесь не нужны.
test('TC-25: usage накапливается и переживает перезапуск VS Code', async ({}, testInfo) => {
  const dirs1 = makeIsolatedDirs();

  // Сессия 1: дойти до ask_user (две модельные итерации) и закрыться.
  await withVSCodeSession(dirs1, testInfo, 'session-1', async (agent) => {
    agent.openRouter.respondWith(FULL_SCENARIO);
    await agent.setApiKey();
    await agent.createRun(PROMPT);
    await agent.waitForAssistantToolCall('ask_user');
    await agent.waitForAskUserForm(QUESTION);

    // На этом моменте loop отыграл ровно один шаг (ask_user), значит
    // в tools.jsonl одно assistant-событие — с usage'ем.
    const run = agent.lastRun();
    const assistantEvents = run.toolEvents.filter((e) => e.kind === 'assistant');
    expect(assistantEvents).toHaveLength(1);
    const askEvent = assistantEvents[0];
    expect(askEvent.usage, 'у assistant-шага есть usage').toBeDefined();
    expect(askEvent.usage?.model).toBe(MODEL);
    expect(typeof askEvent.usage?.costUsd).toBe('number');

    // Агрегат рана отражает один шаг.
    const meta = run.meta;
    expect(meta?.usage.inputTokens).toBe(STEP1_USAGE.prompt_tokens);
    expect(meta?.usage.outputTokens).toBe(STEP1_USAGE.completion_tokens);
    expect(meta?.usage.lastTotalTokens).toBe(STEP1_USAGE.total_tokens);
    expect(meta?.usage.lastModel).toBe(MODEL);
    expect(meta?.usage.costUsd).toBeCloseTo(expectedCost(STEP1_USAGE), 10);
  });

  // Сессия 2: после рестарта агрегаты должны быть на месте.
  // FULL_SCENARIO имеет 3 ответа, первая сессия отыграла 2 (title +
  // ask_user). Третий — финальный бриф для resume.
  const dirs2 = prepareRestart(dirs1, { fullScenario: FULL_SCENARIO, consumedResponses: 2 });

  await withVSCodeSession(dirs2, testInfo, 'session-2', async (agent) => {
    await agent.setApiKey();
    await agent.openSidebar();
    await agent.selectRun('any');

    // Пока ничего не делаем — проверяем, что агрегаты на диске не
    // обнулились между сессиями (это и есть ключевая часть TC-25:
    // usage переживает перезапуск VS Code).
    const beforeAnswer = agent.lastRun().meta;
    expect(beforeAnswer?.usage.inputTokens).toBe(STEP1_USAGE.prompt_tokens);
    expect(beforeAnswer?.usage.outputTokens).toBe(STEP1_USAGE.completion_tokens);
    expect(beforeAnswer?.usage.lastTotalTokens).toBe(STEP1_USAGE.total_tokens);
    expect(beforeAnswer?.usage.costUsd).toBeCloseTo(expectedCost(STEP1_USAGE), 10);

    // Отвечаем — resume пишет второй шаг (финальный бриф) с usage.
    await agent.waitForAskUserForm(QUESTION);
    await agent.answerAsk(USER_ANSWER);
    await agent.waitForBrief();

    const run = agent.lastRun();
    expectRunStatus(run, 'awaiting_human');
    expectBriefHasRequiredSections(run);

    // Второй loop-шаг прибавил step2 поверх step1.
    const meta = run.meta;
    expect(meta?.usage.inputTokens).toBe(STEP1_USAGE.prompt_tokens + STEP2_USAGE.prompt_tokens);
    expect(meta?.usage.outputTokens).toBe(
      STEP1_USAGE.completion_tokens + STEP2_USAGE.completion_tokens
    );
    expect(meta?.usage.lastTotalTokens).toBe(STEP2_USAGE.total_tokens);
    expect(meta?.usage.costUsd).toBeCloseTo(
      expectedCost(STEP1_USAGE) + expectedCost(STEP2_USAGE),
      10
    );

    // Оба loop-шага в `tools.jsonl` имеют usage.
    const assistantEvents = run.toolEvents.filter((e) => e.kind === 'assistant');
    expect(assistantEvents).toHaveLength(2);
    for (const event of assistantEvents) {
      expect(event.usage).toBeDefined();
    }
  });
});
