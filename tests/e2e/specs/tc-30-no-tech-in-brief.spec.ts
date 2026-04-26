import { test } from '../fixtures/agent';
import { scenario, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectBriefHasRequiredSections,
  expectBriefHasNoTechnologies,
  expectRunStatus,
} from '../dsl/run-assertions';

/**
 * TC-30. brief.md не содержит технологий — US-14 / smoke.
 *
 * Лёгкий контрактный тест на новый assertion `expectBriefHasNoTechnologies`:
 * сценарий имитирует продакта, который в ответ на «выбери фреймворк»
 * остаётся в продуктовом русле и отдаёт чистый бриф без упоминаний
 * технологий. Реальную дисциплину модели проверять через мок не имеет
 * смысла (мы сами решаем, что она «отвечает»), поэтому ценность TC —
 * в том, что:
 *   а) assertion завязан, и любая будущая регрессия (продакт начнёт
 *      протаскивать «React» в шаблонах brief.md) сразу упадёт здесь;
 *   б) wiring сценария «модель сразу финал, без kb/ask_user» не
 *      ломает финализацию — это полезно само по себе как самый узкий
 *      путь продакта.
 */

const PROMPT = 'Сделай нам приложение для заметок. Какой фреймворк выбрать — React или Vue?';
const TITLE = 'Приложение для заметок';

const BRIEF = `# ${TITLE}

## Проблема
Пользователю негде быстро записать короткую мысль так, чтобы она потом нашлась.

## Целевой пользователь и сценарий
Любой пользователь, который ловит идею «на бегу». Открывает приложение, пишет, через неделю ищет.

## User stories
- Как пользователь, я хочу одной кнопкой создать заметку, чтобы не отвлекаться на интерфейс.
- Как пользователь, я хочу искать по тексту заметки, чтобы найти идею через неделю.

## Acceptance criteria
1. Создание заметки — одно действие из главного экрана.
2. Поиск по полному тексту работает на коллекциях до 1000 заметок.
3. Заметки сохраняются между сессиями.

## Не-цели
- Совместный доступ к заметкам.
- Технологический стек — это решение архитектора, не продактовый bound.

## Связанные артефакты kb
—`;

test('TC-30: brief.md не содержит конкретных технологий (US-14)', async ({ agent }) => {
  // Простейший сценарий: title + сразу финал. Никакого kb-recall'а
  // и ask_user — продакт «решил», что вопрос про фреймворк не его и
  // выдал чистый продуктовый бриф.
  agent.openRouter.respondWith(scenario(fakeFinalAnswer(TITLE), fakeFinalAnswer(BRIEF)));

  await agent.setApiKey();
  await agent.createRun(PROMPT);
  await agent.waitForRunStatus('awaiting_human');

  const run = agent.lastRun();
  expectRunStatus(run, 'awaiting_human');
  expectBriefHasRequiredSections(run);
  expectBriefHasNoTechnologies(run);
});
