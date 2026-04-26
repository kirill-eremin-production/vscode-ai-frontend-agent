import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
  expectChatHasNoToolCalls,
  expectRunStatus,
  expectBriefHasRequiredSections,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-17. Продакт: happy path — US-7.
 *
 * Достаточно полный prompt → продакт делает один обзорный `kb.list`,
 * убеждается, что в kb пусто (мокаем пустую directory), и сразу выдаёт
 * финальный бриф. Без `ask_user`, без `kb.write`.
 *
 * Зачем такой минимальный сценарий: цель кейса — проверить «склейку»
 * createRun → title-generation → runProduct → writeBrief → UI.
 * Сложные сценарии с kb-записью и вопросами — отдельные TC-18/19.
 *
 * Структура сценария ответов модели:
 *  - response[0] — генерация заголовка (cheap-модель в `title.ts`).
 *  - response[1] — продакт в первой итерации делает `kb.list`.
 *  - response[2] — продакт в финальной итерации отдаёт текст брифа.
 */

const PROMPT =
  'Хочу добавить тёмную тему в настройки профиля. Целевая аудитория — фронтенд-разработчики, работающие вечером. Acceptance: переключатель в /profile/settings, тема сохраняется в localStorage и применяется без перезагрузки. Не-цели: системная тема, синхронизация между устройствами.';

const TITLE = 'Тёмная тема настроек профиля';

// Бриф намеренно длинный (> 600 символов), чтобы заодно проверить
// инвариант «в чат идёт превью с многоточием, в файле — полный текст».
const BRIEF = `# Тёмная тема настроек профиля

## Проблема
Пользователи (фронтенд-разработчики) работают по вечерам в светлой теме и быстро устают глазами. Сейчас в продукте нет способа переключить интерфейс на тёмное оформление; разработчики обходятся системными утилитами или просто терпят.

## Целевой пользователь и сценарий
Фронтенд-разработчик открывает приложение вечером, идёт в \`/profile/settings\`, переключает тему на тёмную и продолжает работу без напряжения для глаз. Параметр сохраняется и при следующем входе тема применяется автоматически.

## User stories
- Как разработчик, я хочу видеть переключатель темы в настройках профиля, чтобы быстро переключаться без поиска по интерфейсу.
- Как разработчик, я хочу, чтобы выбранная тема сохранялась между сессиями, чтобы не выбирать её каждый раз заново.

## Acceptance criteria
1. На странице \`/profile/settings\` есть управляющий элемент «Тема» с двумя значениями: «Светлая», «Тёмная».
2. Выбор сохраняется в \`localStorage\` под отдельным ключом и читается при старте приложения.
3. Переключение применяется без перезагрузки страницы (CSS-классы корня обновляются мгновенно).
4. Тёмная палитра соответствует токенам дизайн-системы; контрастность текста не ниже WCAG AA.

## Не-цели
- Автоматическое подхватывание системной темы (\`prefers-color-scheme\`).
- Синхронизация выбранной темы между устройствами одного пользователя.

## Связанные артефакты kb
—`;

test('TC-17: продакт авто-стартует, делает kb.list и пишет brief.md без ask_user', async ({
  agent,
}) => {
  // 1. Сценарий: title + один kb.list-вызов + финальный бриф.
  //    callIndex в fake-fetch строго последовательный, поэтому порядок
  //    важен — модель делает 3 round-trip'а к OpenRouter в этом тесте.
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.list', { path: '' }, 'call_list'),
      fakeFinalAnswer(BRIEF)
    )
  );

  // 2. Ключ + создание рана через webview-форму. Это тот же UI-путь,
  //    которым пользуется человек: открывается панель, заполняется
  //    textarea, нажимается «Start run».
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3. Ждём появления brief.md на диске — сигнал «продакт довёл цикл
  //    до финала и записал артефакт». Поллинг по fs выбран, потому что
  //    notification'а о завершении продакт не шлёт (это отличие от smoke).
  await agent.waitForBrief();

  const run = agent.lastRun();

  // 4a. Промежуточный шаг — `kb.list` — реально дёрнут и успешен. Это
  //     проверяет, что system prompt'овая инструкция «всегда сначала
  //     посмотри kb» соблюдается циклом, а не игнорируется.
  expectToolCalled(run, 'kb.list');
  expectToolSucceeded(run, 'kb.list');

  // 4b. Финальный assistant без tool_calls (бриф сам по себе) — критерий
  //     завершения цикла, см. resume.test.ts/loop.ts.
  expectFinalAssistantText(run);

  // 4c. brief.md соответствует ровно тому, что отдал модель.
  expect(run.brief, 'brief.md = последний assistant.content').toBe(BRIEF);
  expectBriefHasRequiredSections(run);

  // 4d. Статус FSM — финальный для продакта = awaiting_human (бриф
  //     ждёт человека-аппрувера; кнопок approve пока нет, см. #0003
  //     acceptance criteria).
  expectRunStatus(run, 'awaiting_human');

  // 4e. chat.jsonl: prompt пользователя + сообщение продакта.
  //     Превью в чате обрезано до 600 символов с `…`, поэтому на
  //     равенство с BRIEF не сравниваем — просто проверяем наличие.
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasAgentReply(run);
  expectChatHasNoToolCalls(run);

  // 4f. Заголовок рана — тот, что отдала title-модель (а не fallback
  //     с обрезанием prompt'а). Это косвенно подтверждает порядок
  //     ответов в сценарии: response[0] действительно достался title.
  expect(run.meta?.title).toBe(TITLE);

  // 4g. Превью в чате содержит начало брифа и заканчивается «…», т.к.
  //     длина BRIEF > 600 символов (см. finalize-логику продакта).
  const productMsg = run.chat.find((entry) => entry.from === 'agent:product');
  expect(productMsg, 'Ожидали сообщение agent:product в chat.jsonl').toBeTruthy();
  expect(productMsg!.text.startsWith('# Тёмная тема настроек профиля')).toBe(true);
  expect(productMsg!.text.endsWith('…')).toBe(true);
});
