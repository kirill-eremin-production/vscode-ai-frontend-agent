import { test } from '../fixtures/agent';
import { scenario, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectRunStatus,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-22. Continue dialog после awaiting_human — US-10 / #0007.
 *
 * Базовый кейс продолжения диалога: продакт выдал первый brief.md
 * (статус → awaiting_human), пользователь дописывает в composer
 * «доработай раздел про метрики», ран снова идёт в running, продакт
 * перезаписывает brief.md новой версией → снова awaiting_human.
 *
 * Шаги:
 *   1. Сценарий: title → первый бриф → второй бриф (после continue).
 *   2. Создать ран через UI, дождаться brief.md.
 *   3. Открыть карточку рана и через композер отправить follow-up.
 *   4. Дождаться, пока на диске появится новый brief.md (отличный от первого).
 *
 * Ожидание:
 *   - meta.json: status снова `awaiting_human` после второй итерации.
 *   - chat.jsonl: исходный prompt + первое превью продакта + новое
 *     user-сообщение + второе превью продакта (4 записи минимум).
 *   - tools.jsonl: есть system-маркер «Resume by user follow-up message»
 *     и второй финальный assistant без tool_calls.
 *   - brief.md: содержит новую версию (FOLLOWUP_BRIEF), а не первую.
 */

const PROMPT = 'Хочу простую внутреннюю страницу с одним полем поиска и списком результатов.';
const TITLE = 'Внутренний поиск';

const FIRST_BRIEF = `# ${TITLE}

## Проблема
Сотрудники тратят время на поиск нужных документов вручную.

## Целевой пользователь и сценарий
Внутренний пользователь открывает страницу, вводит запрос, видит список совпадений.

## User stories
- Как сотрудник, я хочу одной строкой искать документы, чтобы не лазить по папкам.

## Acceptance criteria
1. Одно поле ввода и кнопка «Найти».
2. Список результатов под полем.

## Не-цели
- Внешний доступ.

## Связанные артефакты kb
—`;

// Вторая версия — добавлен раздел про метрики, как «попросил пользователь».
const FOLLOWUP_USER_TEXT = 'Добавь раздел про метрики успеха: какие числа смотрим.';

const FOLLOWUP_BRIEF = `# ${TITLE}

## Проблема
Сотрудники тратят время на поиск нужных документов вручную.

## Целевой пользователь и сценарий
Внутренний пользователь открывает страницу, вводит запрос, видит список совпадений.

## User stories
- Как сотрудник, я хочу одной строкой искать документы, чтобы не лазить по папкам.

## Acceptance criteria
1. Одно поле ввода и кнопка «Найти».
2. Список результатов под полем.
3. Метрики использования собираются (см. секцию «Метрики успеха»).

## Не-цели
- Внешний доступ.

## Метрики успеха
- DAU использующих поиск ≥ 30% от общего DAU через 4 недели.
- Среднее время до первого клика по результату ≤ 3 секунды.

## Связанные артефакты kb
—`;

test('TC-22: composer после awaiting_human → продакт перезаписывает brief.md', async ({
  agent,
}) => {
  // 1. Сценарий: первый ответ — title (cheap-модель), второй — первый бриф,
  //    третий — обновлённый бриф после follow-up. callIndex в fake-fetch
  //    последовательный, продакт делает по одному запросу к OpenRouter
  //    в этом простейшем сценарии.
  agent.openRouter.respondWith(
    scenario(fakeFinalAnswer(TITLE), fakeFinalAnswer(FIRST_BRIEF), fakeFinalAnswer(FOLLOWUP_BRIEF))
  );

  // 2. Ключ + создание рана через UI (тот же путь, что у пользователя).
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3. Дожидаемся именно `awaiting_human` (а не просто появления brief.md):
  //    finalizeRun делает writeBrief → appendProductChatMessage →
  //    updateRunStatus(awaiting_human). Если опросить раньше времени,
  //    brief уже на диске, а status ещё `running` — будет гонка.
  //    waitForRunStatus гарантирует, что мы видим конец первого цикла.
  await agent.waitForRunStatus('awaiting_human');

  const firstSnapshot = agent.lastRun();
  expect(firstSnapshot.brief).toBe(FIRST_BRIEF);
  expectRunStatus(firstSnapshot, 'awaiting_human');

  // 4. Открываем карточку рана и шлём follow-up через composer. Composer
  //    теперь — постоянное поле ввода в любом не-draft статусе (US-10).
  //    selectRun перед send нужен, чтобы карточка рендерилась с composer'ом.
  await agent.openSidebar();
  await agent.selectRun('any');
  await agent.sendUserMessage(FOLLOWUP_USER_TEXT);

  // 5. Дожидаемся завершения второго цикла. Условие должно быть составным:
  //    `brief === FOLLOWUP_BRIEF` доказывает, что cycle-2 реально записал
  //    новый файл (а не остался на FIRST_BRIEF), а `status === awaiting_human`
  //    отрезает гонку между writeBrief и updateRunStatus в finalizeRun
  //    второго цикла. До второго цикла статус успеет проскочить:
  //    awaiting_human (cycle-1) → running (resumer) → awaiting_human (cycle-2),
  //    и без проверки brief мы могли бы ложно «увидеть» finish ещё на cycle-1.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = agent.lastRun();
    if (current.brief === FOLLOWUP_BRIEF && current.meta?.status === 'awaiting_human') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const run = agent.lastRun();

  // 6a. brief.md содержит именно вторую версию — не первую.
  expect(run.brief, 'brief.md перезаписан второй версией').toBe(FOLLOWUP_BRIEF);

  // 6b. Статус снова `awaiting_human` — цикл завершился штатно после continue.
  expectRunStatus(run, 'awaiting_human');

  // 6c. В chat.jsonl видна вся хронология: prompt пользователя →
  //     превью первого брифа → follow-up пользователя → превью второго брифа.
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasUserPrompt(run, FOLLOWUP_USER_TEXT);
  const productMessages = run.chat.filter((entry) => entry.from === 'agent:product');
  expect(productMessages.length, 'два превью продакта в chat.jsonl').toBeGreaterThanOrEqual(2);

  // 6d. В tools.jsonl стоит resume-маркер про follow-up. Это критерий
  //     «вторая итерация продакта пошла именно через continue-resumer,
  //     а не через какой-то параллельный путь».
  const followupMarker = run.toolEvents.find(
    (event) =>
      event.kind === 'system' &&
      typeof event.message === 'string' &&
      event.message.includes('user follow-up')
  );
  expect(followupMarker, 'system-событие про user follow-up resume').toBeTruthy();

  // 6e. В tools.jsonl два финальных assistant'а без tool_calls — по одному
  //     на каждую итерацию продакта. Проверяем именно количество, а не
  //     просто «есть финальный»: иначе не отличим первый цикл от второго.
  const finalAssistants = run.toolEvents.filter(
    (event) => event.kind === 'assistant' && !event.tool_calls
  );
  expect(finalAssistants.length, 'два финальных assistant за два цикла').toBe(2);

  // 6f. Универсальная проверка инварианта «цикл завершён» для последнего
  //     шага (последний assistant — без tool_calls, контент непустой).
  expectFinalAssistantText(run);
});
