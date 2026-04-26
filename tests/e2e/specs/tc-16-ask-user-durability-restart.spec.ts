import { test } from '@playwright/test';
import { makeIsolatedDirs } from '../fixtures/vscode';
import { withVSCodeSession, prepareRestart } from '../dsl/session';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectKnowledgeFile,
  expectFinalAssistantText,
  expectChatHasAgentReply,
  expectResumeMarker,
} from '../dsl/run-assertions';

/**
 * TC-16. ask_user: durability через перезапуск VS Code.
 *
 * Сценарий стрессует resume-логику: цикл доходит до ask_user, мы
 * убиваем Electron-процесс (имитируем «пользователь закрыл VS Code,
 * не отвечая»), запускаем заново, отдаём ответ — цикл должен
 * возобновиться, дописать файл и финал.
 *
 * Тест не использует фикстуру `agent`, потому что та держит Page
 * одного запуска — после `app.close()` все её локаторы невалидны.
 * Поэтому жизненный цикл VS Code управляется вручную через
 * `withVSCodeSession` + `prepareRestart` из DSL.
 */

const NOTE_PATH = 'smoke/durability.md';
const QUESTION = 'Что записать в файл?';
const USER_ANSWER = 'Hello after restart';
const PROMPT = `Создай ${NOTE_PATH}`;

// Сценарий ровно тот же, что в TC-15: ask_user → kb.write(answer) → final.
// Между сессиями делим его пополам: session 1 проедает первый ответ,
// session 2 получает оставшиеся два.
const FULL_SCENARIO = scenario(
  fakeToolCall('ask_user', { question: QUESTION }, 'call_ask'),
  fakeToolCall('kb.write', { path: NOTE_PATH, content: USER_ANSWER }, 'call_write'),
  fakeFinalAnswer(`Записал ${NOTE_PATH}.`)
);

// eslint-disable-next-line no-empty-pattern -- Playwright API требует destructuring-параметр; фикстуры здесь не нужны.
test('TC-16: ask_user переживает перезапуск VS Code, цикл возобновляется', async ({}, testInfo) => {
  const dirs1 = makeIsolatedDirs();

  // Сессия 1: дойти до ask_user и закрыться, не отвечая.
  await withVSCodeSession(dirs1, testInfo, 'session-1', async (agent) => {
    agent.openRouter.respondWith(FULL_SCENARIO);
    await agent.setApiKey();
    await agent.runSmoke(PROMPT);

    // Дожидаемся, что цикл реально дошёл до точки приостановки. Без
    // этого риск закрыть VS Code раньше, чем fake-fetch отдаст ask_user.
    await agent.waitForAssistantToolCall('ask_user');

    // Дополнительно убеждаемся, что webview видит вопрос — это часть
    // user story TC-16. Строгих ассертов на эту фазу не делаем:
    // главный инвариант проверяется по артефактам на диске.
    await agent.openSidebar();
    await agent.selectRun('any');
    await agent.waitForAskUserForm(QUESTION);
  });

  // Сессия 2: свежие launcher-папки (минуют Electron singleton-локи),
  // тот же workspace + сценарий без уже отыгранного ответа.
  const dirs2 = prepareRestart(dirs1, { fullScenario: FULL_SCENARIO, consumedResponses: 1 });

  await withVSCodeSession(dirs2, testInfo, 'session-2', async (agent) => {
    // Свежий user-data-dir → SecretStorage может быть пустым. Это не
    // нарушает суть TC-16: durability проверяется по `.agents/runs/`,
    // не по ключу. Просто ставим ключ заново, как сделал бы пользователь.
    await agent.setApiKey();

    // Поднимаем UI, выбираем тот самый ран — store webview достаёт
    // pendingAsk через `runs.get` (findPendingAsk читает tools.jsonl).
    await agent.openSidebar();
    await agent.selectRun('any');
    await agent.waitForAskUserForm(QUESTION);

    // Отвечаем. resolvePendingAsk не найдёт promise в памяти (другой
    // процесс) — extension вызовет resumeRun, тот соберёт initialHistory
    // из tools.jsonl и продолжит цикл.
    await agent.answerAsk(USER_ANSWER);
    await agent.waitForCompletion();

    const run = agent.lastRun();

    // Запрос ask_user от модели зафиксирован ещё в session 1 — это
    // главный артефакт «точки останова». Самого `tool_result` для
    // ask_user в tools.jsonl нет и не должно быть: при resume ответ
    // подкладывается только в in-memory историю модели, не в лог.
    expectToolCalled(run, 'ask_user');

    // resume-маркер — критерий, что вторая сессия реально подняла
    // существующий ран, а не запустила новый.
    expectResumeMarker(run);

    // kb.write успех + файл с правильным содержимым: модель получила
    // именно тот ответ, что пользователь ввёл во второй сессии.
    expectToolCalled(run, 'kb.write');
    expectToolSucceeded(run, 'kb.write');
    expectKnowledgeFile(run, NOTE_PATH, USER_ANSWER);

    // Финал и пользовательская лента — на месте.
    expectFinalAssistantText(run);
    expectChatHasAgentReply(run);
  });
});
