import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectRunStatus,
  expectBriefHasRequiredSections,
  expectPlanHasRequiredSections,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-31. Архитектор: happy path после продакта (#0004, расширяет US-2/US-4).
 *
 * Что проверяем (end-to-end):
 *  1. Продакт стартует, делает kb.list и пишет brief.md
 *     (как в TC-17 — это фундамент, без него архитектор не запустится).
 *  2. По success-ветке `runProduct.finalizeRun` extension автоматически
 *     дёргает `runArchitect` (см. issue #0004 acceptance: «архитектор
 *     стартует автоматически после успеха продакта»).
 *  3. Архитектор делает свой kb.list, читает kb (она пустая на свежем
 *     workspace) и пишет финальный plan.md.
 *  4. plan.md ложится в kb по новому пути (`.agents/knowledge/architect/
 *     plans/<runId>-<slug>.md`), `meta.planPath` обновляется.
 *  5. В `chat.jsonl` появляются последовательно agent:product preview и
 *     agent:architect preview (UI рисует обе секции — Бриф и План).
 *  6. Финальный статус = `awaiting_human` (план готов, ждём
 *     пользователя; кнопок approve/reject между ролями нет на этой
 *     итерации, см. #0004).
 *
 * Зачем нужна `test.use({ extraEnv })`:
 *   фикстура `vscode.ts` по умолчанию выставляет
 *   `AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=0`, чтобы продактовые TC
 *   (TC-17..21) не дёргали архитектора и не падали на отсутствии
 *   ответов в их сценарии. Здесь намеренно включаем handoff обратно.
 */

// `test.use(...)` поднимает `AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=1`
// до того, как фикстура запустит VS Code, — иначе бы продакт
// финализировался без передачи рану архитектору.
test.use({ extraEnv: { AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '1' } });

const PROMPT =
  'Хочу добавить тёмную тему в настройки профиля. Целевая аудитория — фронтенд-разработчики, работающие вечером. Acceptance: переключатель в /profile/settings, тема сохраняется в localStorage и применяется без перезагрузки. Не-цели: системная тема, синхронизация между устройствами.';

const TITLE = 'Тёмная тема настроек профиля';

// Бриф укороченный (< 600 символов): инвариант «превью с многоточием»
// мы уже проверяем в TC-17. Здесь хотим сосредоточиться на handoff'е,
// поэтому короткий текст ускоряет ассерты по чату.
const BRIEF = `# Тёмная тема настроек профиля

## Проблема
Разработчики работают по вечерам и устают от светлой темы.

## Целевой пользователь и сценарий
Фронтенд-разработчик переключает тему в /profile/settings.

## User stories
- Как разработчик, я хочу переключатель темы в настройках, чтобы быстро её сменить.

## Acceptance criteria
1. На странице /profile/settings есть переключатель темы.
2. Выбор сохраняется и применяется без перезагрузки.

## Не-цели
- Авто-подхват системной темы.

## Связанные артефакты kb
—`;

// План тоже укороченный, но содержит все обязательные секции из
// PLAN_SECTIONS — это ключевой инвариант роли (#0004).
const PLAN = `# План

Реализуем переключатель темы и его персистентность по схеме «локальный store + SSR-friendly применение классов».

## Цели
- Модуль настроек профиля экспортирует контролируемый компонент «Тема».
- Слой персистентности сохраняет выбор и читает его при инициализации.

## Подзадачи
### 1. Компонент-переключатель темы
Описание: добавить контролируемый компонент в страницу настроек профиля.
Затрагиваемые модули: \`src/profile/settings/...\`.
Зависимости: —.

### 2. Слой персистентности
Описание: сохранять выбор пользователя и применять его при загрузке.
Затрагиваемые модули: \`src/profile/theme/...\`.
Зависимости: 1.

## Архитектурные решения
- Тема применяется через CSS-классы корневого элемента — без перезагрузки и без FOUC при гидратации.

## Риски и граничные случаи
- [средний] Persistence может конфликтовать с приватным режимом браузера; падать назад на дефолт.

## Связанные артефакты kb
—`;

test('TC-31: продакт → архитектор автоматически, plan.md ложится в kb', async ({ agent }) => {
  // 1. Сценарий ответов модели. callIndex в fake-fetch строго
  //    последовательный, поэтому порядок важен:
  //      [0] title-генерация (cheap-model в src/extension/entities/run/title.ts)
  //      [1] продакт: kb.list по пустой kb
  //      [2] продакт: финальный brief
  //      [3] архитектор: kb.list по пустой kb (architect/ ещё не существует
  //          — kb.list возвращает { entries: [] }, не ошибку, см. tools/kb.ts)
  //      [4] архитектор: финальный plan
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.list', { path: '' }, 'product_list'),
      fakeFinalAnswer(BRIEF),
      fakeToolCall('kb.list', { path: '' }, 'architect_list'),
      fakeFinalAnswer(PLAN)
    )
  );

  // 2. Ключ + создание рана через тот же UI-путь, что у пользователя
  //    (палитра/команда + textarea + Start run).
  await agent.setApiKey();
  await agent.createRun(PROMPT);

  // 3a. Сначала ждём brief — это сигнал «продакт довёл свой цикл
  //     до конца». Без него архитектор не должен был стартовать.
  await agent.waitForBrief();

  // 3b. А затем — plan. Это и есть основное наблюдение TC-31:
  //     handoff произошёл, архитектор отработал и записал артефакт.
  await agent.waitForPlan();

  const run = agent.lastRun();

  // 4a. Промежуточные kb.list оба отработали успешно. Это косвенно
  //     подтверждает sandbox: если бы архитектору приехал product/-путь,
  //     он бы дёрнул kb.list по чужой папке, но сценарий передаёт
  //     `path: ''` → role-scoped wrapper подставляет `architect`,
  //     и kb.list читает свою папку (пустую → entries: []).
  expectToolCalled(run, 'kb.list');
  expectToolSucceeded(run, 'kb.list');
  // Должно быть РОВНО два tool_call'а с именем kb.list (продакт + архитектор).
  const kbListCalls = run.toolEvents.filter(
    (event) =>
      event.kind === 'assistant' &&
      Array.isArray(event.tool_calls) &&
      event.tool_calls.some((call) => call.name === 'kb.list')
  );
  expect(kbListCalls.length, 'Ожидали два kb.list (продакт + архитектор)').toBe(2);

  // 4b. Финальный assistant без tool_calls — критерий завершения цикла
  //     архитектора (то же определение, что и у продакта).
  expectFinalAssistantText(run);

  // 4c. Артефакты на диске и их содержимое.
  expect(run.brief, 'brief.md = последний ответ продакта').toBe(BRIEF);
  expect(run.plan, 'plan.md = последний ответ архитектора').toBe(PLAN);
  expectBriefHasRequiredSections(run);
  expectPlanHasRequiredSections(run);

  // 4d. Ссылки в meta — workspace-relative и указывают в общую kb
  //     (а не в `.agents/runs/<id>/`). Это инвариант #0011 для брифа
  //     и его расширение для плана в #0004.
  expect(run.meta?.briefPath, 'briefPath должен лежать в общей kb (#0011)').toMatch(
    /^\.agents\/knowledge\/product\/briefs\//
  );
  expect(run.meta?.planPath, 'planPath должен лежать в общей kb (#0004)').toMatch(
    /^\.agents\/knowledge\/architect\/plans\//
  );

  // 4e. Финальный статус — `awaiting_human`. Архитектор сам выставляет
  //     его в success-ветке (см. features/architect-role/run.ts).
  expectRunStatus(run, 'awaiting_human');

  // 4f. chat.jsonl: prompt пользователя + сообщение продакта + сообщение
  //     архитектора. Тулы НЕ должны просачиваться в чат (это уже
  //     проверено в TC-17 — здесь смотрим только последовательность
  //     ролевых сообщений).
  expectChatHasUserPrompt(run, PROMPT);
  const productMessages = run.chat.filter((entry) => entry.from === 'agent:product');
  const architectMessages = run.chat.filter((entry) => entry.from === 'agent:architect');
  expect(productMessages.length, 'Ожидали ровно одно сообщение от agent:product').toBe(1);
  expect(architectMessages.length, 'Ожидали ровно одно сообщение от agent:architect').toBe(1);

  // 4g. Архитектор пишет ПОСЛЕ продакта — критично для UI-секции
  //     «Бриф/План» в RunDetails. Сравниваем by `at` (ISO-таймштамп
  //     лексикографически = хронологически).
  expect(
    architectMessages[0].at >= productMessages[0].at,
    'Сообщение архитектора должно быть позже сообщения продакта'
  ).toBe(true);

  // 4h. Заголовок рана — тот, что отдала title-модель. Это страховка,
  //     что callIndex действительно начинается с титульного ответа,
  //     а не с продактового шага.
  expect(run.meta?.title).toBe(TITLE);

  // 4i. Sandbox cross-role не проверяем отдельным циклом: инвариант
  //     обеспечивает role-scoped wrapper (`buildRoleScopedKbTools`),
  //     а здесь мы уже подтвердили, что план лежит ровно в
  //     `architect/plans/...`, а не где попало (см. 4d). Полноценный
  //     sandbox-тест архитектора (попытка модели уйти из своей kb) —
  //     отдельный TC, по образу TC-19 для продакта.
});
