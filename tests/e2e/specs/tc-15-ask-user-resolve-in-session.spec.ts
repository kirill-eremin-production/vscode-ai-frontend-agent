import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectKnowledgeFile,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-15. ask_user: вопрос → ответ через webview → продолжение цикла в
 * текущей сессии.
 *
 * Полный «человеческий» flow: модель просит ввести текст файла, цикл
 * приостанавливается на ask_user, пользователь отвечает в карточке
 * сайдбара, цикл возобновляется, файл записывается.
 *
 * Шаги:
 *   1. Сценарий: ask_user('Какой текст?') → kb.write(answer) → final.
 *   2. Запуск smoke без указания текста (специально, чтобы spec
 *      не зависел от того, что smoke prompt будет «толкать» к ask_user;
 *      сценарий мокает за нас).
 *   3. Открыть sidebar, выбрать ран, дождаться формы вопроса.
 *   4. Ввести ответ, нажать «Ответить».
 *
 * Ожидание:
 *   - В `tools.jsonl` есть assistant с tool_call ask_user, tool_result
 *     с `answer === USER_ANSWER`, потом kb.write успех, потом финал.
 *   - Файл создан с содержимым USER_ANSWER.
 *   - В chat.jsonl — исходный prompt и финальный ответ агента.
 */

const NOTE_PATH = 'smoke/ask-user.md';
const QUESTION = 'Какой текст записать в файл?';
const USER_ANSWER = 'Hello from TC-15';
const PROMPT = `Создай ${NOTE_PATH}`;

test('TC-15: ask_user через webview-форму, цикл продолжается и пишет файл', async ({ agent }) => {
  // 1. Сценарий из трёх ответов модели:
  //    - сначала просим ask_user;
  //    - после получения ответа — пишем kb.write c этим ответом
  //      (мы знаем, что answer будет именно `USER_ANSWER`, потому что
  //      его сами вводим в форму);
  //    - финальный текст для остановки цикла.
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('ask_user', { question: QUESTION }, 'call_ask'),
      fakeToolCall('kb.write', { path: NOTE_PATH, content: USER_ANSWER }, 'call_write'),
      fakeFinalAnswer(`Записал ${NOTE_PATH}.`)
    )
  );

  // 2. Ключ + запуск smoke. После Enter цикл стартует и сразу
  //    упирается в ask_user — статус рана уйдёт в awaiting_user_input.
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);

  // 3. Открываем сайдбар и выбираем единственный ран. До этого момента
  //    webview просто не отрисован — VS Code лениво активирует view.
  await agent.openSidebar();
  await agent.selectRun('any');

  // 4. Ждём именно нашу форму с заданным вопросом — это означает, что
  //    `runs.askUser` broadcast долетел и store его сохранил.
  await agent.waitForAskUserForm(QUESTION);

  // 4b. До отправки ответа: меты статус должен быть awaiting_user_input.
  //     Чтение через диск, чтобы не зависеть от текущего рендеринга.
  const runBefore = agent.lastRun();
  expect(
    runBefore.toolEvents.some(
      (event) => event.kind === 'assistant' && event.tool_calls?.some((c) => c.name === 'ask_user')
    )
  ).toBe(true);

  // 5. Вводим ответ и жмём «Ответить». store шлёт `runs.userAnswer`,
  //    extension резолвит pending Promise, цикл идёт дальше.
  await agent.answerAsk(USER_ANSWER);

  // 6. Дожидаемся «Smoke OK» — финал цикла. Между ответом и финалом
  //    fake-fetch отдаёт ещё два ответа модели (kb.write + final).
  await agent.waitForCompletion();

  const run = agent.lastRun();

  // 7a. ask_user успешно отработал — есть tool_result с нашим answer'ом.
  expectToolCalled(run, 'ask_user');
  expectToolSucceeded(run, 'ask_user');
  const askResult = run.toolEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_name === 'ask_user'
  );
  expect((askResult?.result as { answer?: string } | undefined)?.answer).toBe(USER_ANSWER);

  // 7b. Дальше модель сделала kb.write с тем же текстом — и он успешен.
  expectToolCalled(run, 'kb.write');
  expectToolSucceeded(run, 'kb.write');

  // 7c. Файл реально записан с правильным содержимым.
  expectKnowledgeFile(run, NOTE_PATH, USER_ANSWER);

  // 7d. Финал и chat — на месте.
  expectFinalAssistantText(run);
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasAgentReply(run);
});
