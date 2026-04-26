import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectRunStatus,
  expectBriefHasRequiredSections,
  expectKnowledgeFile,
} from '../dsl/run-assertions';

/**
 * TC-29. Сигнал «достаточно вопросов, оформляй» — US-13.
 *
 * Продакт задаёт вопрос → пользователь жмёт кнопку finalize вместо
 * ответа → extension подкладывает дословный PRODUCT_FINALIZE_MARKER
 * как ответ на pending ask_user → продакт пишет ADR-допущение в
 * `decisions/...md` с frontmatter `assumption: true, confirmed_by_user: false`
 * и финализирует brief.md.
 *
 * Проверяем именно wiring (UI кнопка → IPC → tool_result с маркером →
 * chat.jsonl видит «Достаточно вопросов, оформляй»). Поведение модели
 * (что она реально создаст ADR) сценарий имитирует — реальную модельную
 * дисциплину тестировать здесь смысла нет.
 *
 * Шаги:
 *   1. Сценарий: title → ask_user → kb.write decisions/... → финал.
 *   2. Создать ран, дождаться формы вопроса.
 *   3. Нажать «Достаточно вопросов» вместо ввода ответа.
 *   4. Дождаться brief.md + проверить инварианты.
 */

const PROMPT = 'Сделай форму обратной связи на сайте.';
const TITLE = 'Форма обратной связи';
const QUESTION = 'Какие поля должны быть в форме?';

const ASSUMPTION_PATH = 'decisions/2026-04-26-feedback-form-fields.md';
const ASSUMPTION_BODY = `---
assumption: true
confirmed_by_user: false
---

# Поля формы обратной связи

Предполагаем стандартный набор: имя, email, текст. Обоснование: это
минимальный комплект для большинства внутренних форм; пользователь
не возразил, но и не подтвердил — после ревью можно скорректировать.
`;

const BRIEF = `# ${TITLE}

## Проблема
Пользователи не могут сообщить команде о багах прямо из приложения.

## Целевой пользователь и сценарий
Любой пользователь сайта; открывает форму, заполняет поля, отправляет.

## User stories
- Как пользователь, я хочу отправить отзыв одной формой, чтобы не искать контакты.

## Acceptance criteria
1. Поля формы зафиксированы в decisions/2026-04-26-feedback-form-fields.md (assumption).
2. После отправки показывается подтверждение.

## Не-цели
- Прикрепление файлов.

## Связанные артефакты kb
- ${ASSUMPTION_PATH} (предположение, требует подтверждения)`;

test('TC-29: кнопка «Достаточно вопросов» прерывает ask-цикл и финализирует brief с ADR-допущением', async ({
  agent,
}) => {
  // 1. Сценарий: title → ask_user → kb.write ADR → финал.
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('ask_user', { question: QUESTION }, 'call_ask'),
      fakeToolCall('kb.write', { path: ASSUMPTION_PATH, content: ASSUMPTION_BODY }, 'call_write'),
      fakeFinalAnswer(BRIEF)
    )
  );

  // 2. Ключ + старт через UI.
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3. Дожидаемся именно формы вопроса — иначе finalize-кнопка ещё
  //    не отрисована (она появляется только при pendingAsk).
  await agent.waitForAskUserForm(QUESTION);
  await agent.waitForRunStatus('awaiting_user_input');

  // 4. Нажимаем finalize вместо ответа на вопрос.
  await agent.clickFinalize();

  // 5. Ждём финал по brief.md + статус (как в TC-22, защищаемся от
  //    гонки между writeBrief и updateRunStatus).
  await agent.waitForRunStatus('awaiting_human');

  const run = agent.lastRun();

  // 6a. ask_user → tool_result содержит дословный finalize-маркер.
  //     Это проверяет, что extension не отправил пустой text/обычный
  //     ответ, а распаковал finalize в правильный текст.
  expectToolCalled(run, 'ask_user');
  expectToolSucceeded(run, 'ask_user');
  const askResult = run.toolEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_name === 'ask_user'
  );
  const askAnswer = (askResult?.result as { answer?: string } | undefined)?.answer;
  expect(askAnswer, 'tool_result.answer должен начинаться с finalize-маркера').toMatch(
    /^\[Сигнал пользователя: вопросов достаточно/
  );

  // 6b. ADR-файл в kb создан с правильным frontmatter.
  expectToolSucceeded(run, 'kb.write');
  expectKnowledgeFile(run, `product/${ASSUMPTION_PATH}`, ASSUMPTION_BODY);

  // 6c. Финал и brief по структуре. Проверка `## Связанные артефакты kb`
  //     содержит ссылку на ADR — это пользовательски значимо: иначе
  //     допущение спрятано и человек его не найдёт.
  expectFinalAssistantText(run);
  expect(run.brief).toBe(BRIEF);
  expectBriefHasRequiredSections(run);
  expect(run.brief).toContain(ASSUMPTION_PATH);
  expectRunStatus(run, 'awaiting_human');

  // 6d. В chat.jsonl видна короткая отметка действия пользователя
  //     («Достаточно вопросов, оформляй») — без неё человек, листающий
  //     ленту, не поймёт, как именно ран был сдвинут с awaiting_user_input.
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasUserPrompt(run, 'Достаточно вопросов, оформляй');
});
