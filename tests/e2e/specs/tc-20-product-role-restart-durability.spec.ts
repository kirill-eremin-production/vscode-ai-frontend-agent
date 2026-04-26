import { test } from '@playwright/test';
import { makeIsolatedDirs } from '../fixtures/vscode';
import { withVSCodeSession, prepareRestart } from '../dsl/session';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
  expectResumeMarker,
  expectRunStatus,
  expectBriefHasRequiredSections,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-20. Продактовый ран переживает перезапуск VS Code на ask_user — US-8.
 *
 * Аналог TC-16 (durability smoke), но для роли product:
 *  - запуск идёт через UI (`createRun` в webview), а не через slash-команду;
 *  - resumer — `registerProductResumer` (#0003), не smoke-resumer.
 *
 * Сценарий — единый, делится между двумя сессиями:
 *   session 1 «съедает» response[0..1] (заголовок + ask_user) и
 *   останавливается, не отвечая. session 2 после рестарта получает
 *   `kb.write` + финальный бриф.
 *
 * Тест не использует фикстуру `agent`, потому что та держит `Page`
 * одного запуска — после `app.close()` все её локаторы невалидны.
 * Жизненный цикл VS Code управляется вручную через `withVSCodeSession`
 * + `prepareRestart` из DSL.
 */

const PROMPT = 'Сделай dashboard со статистикой пользователей.';
const TITLE = 'Дашборд пользователей';
const QUESTION = 'Какие метрики и за какой период показывать на дашборде?';
const USER_ANSWER = 'DAU/MAU за 30 дней, средняя сессия в минутах, конверсия в платящих.';

const KB_DECISION_PATH = 'decisions/2026-04-26-dashboard-metrics.md';
const KB_DECISION_CONTENT = `---
type: decision
created: 2026-04-26
updated: 2026-04-26
related: []
---

# Метрики дашборда пользователей

## Решение
DAU/MAU за 30 дней, средняя длительность сессии в минутах, конверсия в платящих.
`;

const BRIEF = `# Дашборд пользователей

## Проблема
У команды нет единого места, где видны базовые метрики пользователей.

## Целевой пользователь и сценарий
Продакт открывает дашборд утром, проверяет ключевые метрики за 30 дней.

## User stories
- Как продакт, я хочу видеть DAU/MAU, среднюю сессию и конверсию, чтобы реагировать на провалы.

## Acceptance criteria
1. Дашборд показывает DAU и MAU за 30 дней.
2. Средняя длительность сессии в минутах.
3. Конверсия в платящих пользователей.

## Не-цели
- Произвольные SQL-запросы и кастомные периоды.

## Связанные артефакты kb
- product/decisions/2026-04-26-dashboard-metrics.md`;

// Полный сценарий (4 ответа модели):
//  [0] заголовок (первая сессия)
//  [1] ask_user                    (первая сессия съедает и встаёт)
//  [2] kb.write decision           (после ответа во второй сессии)
//  [3] финальный бриф              (финал во второй сессии)
const FULL_SCENARIO = scenario(
  fakeFinalAnswer(TITLE),
  fakeToolCall('ask_user', { question: QUESTION }, 'call_ask'),
  fakeToolCall('kb.write', { path: KB_DECISION_PATH, content: KB_DECISION_CONTENT }, 'call_write'),
  fakeFinalAnswer(BRIEF)
);

// eslint-disable-next-line no-empty-pattern -- Playwright API требует destructuring-параметр; фикстуры здесь не нужны.
test('TC-20: продактовый ран на ask_user переживает перезапуск VS Code', async ({}, testInfo) => {
  const dirs1 = makeIsolatedDirs();

  // Сессия 1: открыть UI, создать ран, дойти до ask_user и закрыться,
  // не отвечая.
  await withVSCodeSession(dirs1, testInfo, 'session-1', async (agent) => {
    agent.openRouter.respondWith(FULL_SCENARIO);
    await agent.setApiKey();
    await agent.createRun(PROMPT);

    // Дожидаемся, что цикл реально дошёл до ask_user. Без этого
    // риск убить VS Code раньше, чем fake-fetch отдаст ответ #1.
    await agent.waitForAssistantToolCall('ask_user');

    // Подтверждаем по UI: store webview увидел вопрос. На этой фазе
    // строгих ассертов делать не нужно — главный инвариант проверяется
    // во второй сессии по артефактам на диске.
    await agent.waitForAskUserForm(QUESTION);
  });

  // Сессия 2: свежие launcher-папки (минуют Electron singleton-локи)
  // + workspace тот же + сценарий с уже отыгранными первыми двумя
  // ответами. callIndex в fake-fetch сбросится при активации, поэтому
  // обрезка обязательна — иначе resume снова получит уже отыгранный
  // ask_user.
  const dirs2 = prepareRestart(dirs1, { fullScenario: FULL_SCENARIO, consumedResponses: 2 });

  await withVSCodeSession(dirs2, testInfo, 'session-2', async (agent) => {
    // SecretStorage в свежем user-data-dir пустой — ставим ключ заново,
    // как сделал бы пользователь после переустановки VS Code.
    await agent.setApiKey();

    // Поднимаем UI и выбираем тот самый ран. store webview достаёт
    // pendingAsk через `runs.get` (findPendingAsk читает tools.jsonl).
    await agent.openSidebar();
    await agent.selectRun('any');
    await agent.waitForAskUserForm(QUESTION);

    // Отвечаем. resolvePendingAsk не найдёт promise в памяти (другой
    // процесс) — extension вызовет `resumeRun`, тот через
    // `registerProductResumer` пересоберёт продакта и продолжит цикл.
    await agent.answerAsk(USER_ANSWER);
    await agent.waitForBrief();

    const run = agent.lastRun();

    // ask_user-вызов от модели зафиксирован ещё в session 1 — это
    // главный артефакт «точки останова». Сам tool_result для ask_user
    // в `tools.jsonl` НЕ пишется при resume (он только в in-memory
    // истории модели), так что просто проверяем сам tool_call.
    expectToolCalled(run, 'ask_user');

    // Resume-маркер — критерий, что вторая сессия реально подняла
    // существующий ран, а не запустила новый.
    expectResumeMarker(run);

    // kb.write в session 2: успешен и файл реально появился под
    // правильным путём (sandbox продакта работает и в resume-режиме).
    expectToolCalled(run, 'kb.write');
    expectToolSucceeded(run, 'kb.write');
    const writeCall = run.toolEvents
      .flatMap((event) => event.tool_calls ?? [])
      .find((call) => call.name === 'kb.write');
    expect(writeCall, 'kb.write tool_call в tools.jsonl').toBeTruthy();
    const args = JSON.parse(writeCall!.arguments) as { path: string };
    // Модель пишет относительный путь, обёртка добавляет product/.
    expect(args.path).toBe(KB_DECISION_PATH);

    // brief.md, статус, финал.
    expectFinalAssistantText(run);
    expect(run.brief).toBe(BRIEF);
    expectBriefHasRequiredSections(run);
    expectRunStatus(run, 'awaiting_human');

    // Лента: исходный prompt пользователя на месте, финальный ответ
    // продакта тоже. (Превью брифа короткий — < 600 символов, поэтому
    // в чате он целиком, не обрезан.)
    expectChatHasUserPrompt(run, PROMPT);
    expectChatHasAgentReply(run);
  });
});
