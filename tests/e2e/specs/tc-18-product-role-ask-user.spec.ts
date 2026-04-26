import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
  expectRunStatus,
  expectBriefHasRequiredSections,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-18. Продакт: уточняющий вопрос через ask_user — US-8.
 *
 * Неполный prompt → продакт зовёт `ask_user`, ран уходит в
 * `awaiting_user_input`, в карточке появляется форма. Пользователь
 * отвечает через webview, цикл возобновляется, пишется бриф.
 *
 * Сценарий ответов модели:
 *  - response[0] — заголовок рана.
 *  - response[1] — первая итерация продакта: вызов `ask_user` с вопросом.
 *  - response[2] — после получения ответа продакт сразу выдаёт бриф
 *    (kb.write пропускаем, чтобы не раздувать сценарий — это TC-19).
 */

const PROMPT = 'Сделай форму обратной связи на сайте.';
const TITLE = 'Форма обратной связи на сайте';
const QUESTION = 'Какие поля должны быть в форме обратной связи и куда отправлять данные?';
const USER_ANSWER =
  'Поля: имя, email, текст сообщения. Отправлять на /api/feedback (POST), показывать toast с подтверждением.';

const BRIEF = `# Форма обратной связи

## Проблема
Пользователи не могут сообщить команде о багах и пожеланиях прямо из приложения; обходные каналы (email, чат поддержки) увеличивают трение.

## Целевой пользователь и сценарий
Любой пользователь сайта; открывает форму, заполняет поля, отправляет, получает подтверждение.

## User stories
- Как пользователь, я хочу отправить отзыв в одну форму, чтобы не искать контакты команды.

## Acceptance criteria
1. Поля формы: имя, email, текст сообщения.
2. Отправка POST на /api/feedback.
3. После успешной отправки показывается toast-подтверждение.

## Не-цели
- Прикрепление файлов.

## Связанные артефакты kb
—`;

test('TC-18: продакт задаёт ask_user, получает ответ через UI и пишет brief.md', async ({
  agent,
}) => {
  // 1. Сценарий: title → ask_user → бриф. Между response[1] и
  //    response[2] продакт ждёт ответа пользователя — на этой паузе
  //    мы и заполним форму ответа.
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('ask_user', { question: QUESTION }, 'call_ask'),
      fakeFinalAnswer(BRIEF)
    )
  );

  // 2. Ключ + старт рана через UI.
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3. Ран автоматически выбирается в стор'е после `runs.created`,
  //    поэтому `selectRun` не нужен. Дожидаемся формы вопроса —
  //    `runs.askUser`-broadcast долетел и UI отрисовал AskUserForm.
  await agent.waitForAskUserForm(QUESTION);

  // 3b. До отправки ответа: статус рана должен быть awaiting_user_input
  //     (это отдельный пользовательский признак того, что ран «висит
  //     на вопросе»).
  await agent.waitForRunStatus('awaiting_user_input');

  // 4. Заполняем textarea и жмём «Ответить» — то же действие, что
  //    делает человек в TC-15. Resolves pending ask, цикл идёт дальше.
  await agent.answerAsk(USER_ANSWER);

  // 5. Ждём финал по brief.md.
  await agent.waitForBrief();

  const run = agent.lastRun();

  // 6a. ask_user: tool_call зафиксирован, успешный tool_result содержит
  //     именно тот ответ, что ввёл пользователь (а не выдуманный моделью).
  expectToolCalled(run, 'ask_user');
  expectToolSucceeded(run, 'ask_user');
  const askResult = run.toolEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_name === 'ask_user'
  );
  expect((askResult?.result as { answer?: string } | undefined)?.answer).toBe(USER_ANSWER);

  // 6b. Финал и брифа в положенном виде.
  expectFinalAssistantText(run);
  expect(run.brief).toBe(BRIEF);
  expectBriefHasRequiredSections(run);
  expectRunStatus(run, 'awaiting_human');

  // 6c. chat.jsonl содержит исходный prompt пользователя и финальный
  //     ответ продакта (превью брифа). Промежуточные ask_user-сообщения
  //     в chat.jsonl на этой итерации не пишутся — это намеренное
  //     решение: лента остаётся короткой и финал-ориентированной;
  //     полный лог вопросов и ответов всегда в `tools.jsonl`.
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasAgentReply(run);
});
