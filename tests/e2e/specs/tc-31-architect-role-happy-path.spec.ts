import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolSucceeded,
  expectFinalAssistantText,
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

  // 4a. Структура сессий после #0012 Phase A: продактовая user↔agent
  //     (initial) + bridge agent↔agent (создаётся при handoff). Это
  //     ключевой инвариант мульти-агентского режима: каждая роль —
  //     отдельный канал общения, handoff материализуется новой сессией.
  const sessions = run.meta?.sessions ?? [];
  expect(sessions.length, 'После handoff должно быть 2 сессии: продакт + bridge').toBe(2);
  const productSessionSummary = sessions[0];
  const bridgeSessionSummary = sessions[1];
  expect(productSessionSummary.kind, 'Первая сессия — user-agent (продакт)').toBe('user-agent');
  expect(bridgeSessionSummary.kind, 'Вторая сессия — bridge agent-agent').toBe('agent-agent');
  expect(
    bridgeSessionSummary.parentSessionId,
    'Bridge должна указывать на продактовую как родителя'
  ).toBe(productSessionSummary.id);
  expect(
    run.meta?.activeSessionId,
    'Активная сессия после handoff = bridge (туда пишет архитектор)'
  ).toBe(bridgeSessionSummary.id);

  // SessionMeta bridge'а: participants = два агента (без user'а).
  const bridgeMeta = run.sessionMetaForSession(bridgeSessionSummary.id);
  expect(bridgeMeta?.participants).toEqual([
    { kind: 'agent', role: 'product' },
    { kind: 'agent', role: 'architect' },
  ]);

  // 4b. Промежуточные kb.list оба отработали успешно. Это косвенно
  //     подтверждает sandbox: если бы архитектору приехал product/-путь,
  //     он бы дёрнул kb.list по чужой папке, но сценарий передаёт
  //     `path: ''` → role-scoped wrapper подставляет `architect`,
  //     и kb.list читает свою папку (пустую → entries: []).
  //
  //     Tool-события теперь живут в разных сессиях: продактовый kb.list —
  //     в sessions[0], архитекторский — в bridge. Считаем суммарно,
  //     чтобы проверить общий инвариант (по одному kb.list на роль).
  const productTools = run.toolEventsForSession(productSessionSummary.id);
  const bridgeTools = run.toolEventsForSession(bridgeSessionSummary.id);
  const kbListInProduct = productTools.filter(
    (event) =>
      event.kind === 'assistant' &&
      Array.isArray(event.tool_calls) &&
      event.tool_calls.some((call) => call.name === 'kb.list')
  );
  const kbListInBridge = bridgeTools.filter(
    (event) =>
      event.kind === 'assistant' &&
      Array.isArray(event.tool_calls) &&
      event.tool_calls.some((call) => call.name === 'kb.list')
  );
  expect(kbListInProduct.length, 'Один kb.list — в продактовой сессии').toBe(1);
  expect(kbListInBridge.length, 'Один kb.list — в bridge-сессии (архитектор)').toBe(1);
  // expectToolCalled/expectToolSucceeded по умолчанию читают активную
  // сессию (= bridge) — там должен быть архитекторский kb.list.
  expectToolCalled(run, 'kb.list');
  expectToolSucceeded(run, 'kb.list');

  // 4c. Финальный assistant без tool_calls — критерий завершения цикла.
  //     Проверяем в активной (bridge) сессии — это финал архитектора.
  expectFinalAssistantText(run);

  // 4d. Артефакты на диске и их содержимое.
  expect(run.brief, 'brief.md = последний ответ продакта').toBe(BRIEF);
  expect(run.plan, 'plan.md = последний ответ архитектора').toBe(PLAN);
  expectBriefHasRequiredSections(run);
  expectPlanHasRequiredSections(run);

  // 4e. Ссылки в meta — workspace-relative и указывают в общую kb
  //     (а не в `.agents/runs/<id>/`). Это инвариант #0011 для брифа
  //     и его расширение для плана в #0004.
  expect(run.meta?.briefPath, 'briefPath должен лежать в общей kb (#0011)').toMatch(
    /^\.agents\/knowledge\/product\/briefs\//
  );
  expect(run.meta?.planPath, 'planPath должен лежать в общей kb (#0004)').toMatch(
    /^\.agents\/knowledge\/architect\/plans\//
  );

  // 4f. Финальный статус — `awaiting_human`. Архитектор сам выставляет
  //     его в success-ветке (см. features/architect-role/run.ts).
  expectRunStatus(run, 'awaiting_human');

  // 4g. chat.jsonl продактовой сессии: prompt пользователя + превью
  //     продакта. Архитекторских сообщений здесь быть не должно —
  //     они ушли в bridge (это и есть смысл Phase A #0012).
  const productChat = run.chatForSession(productSessionSummary.id);
  expect(
    productChat.find((entry) => entry.from === 'user' && entry.text === PROMPT),
    'В продактовой сессии должен быть исходный prompt пользователя'
  ).toBeTruthy();
  const productOwnMessages = productChat.filter((entry) => entry.from === 'agent:product');
  expect(productOwnMessages.length, 'Один agent:product preview в продактовой сессии').toBe(1);
  expect(
    productChat.some((entry) => entry.from === 'agent:architect'),
    'Архитектор НЕ должен писать в продактовую сессию (#0012 Phase A)'
  ).toBe(false);

  // 4h. chat.jsonl bridge-сессии: handoff-сид от продакта (превью брифа)
  //     + финальный preview архитектора. Это первое сообщение, которое
  //     пользователь увидит, открыв таб «Передача».
  const bridgeChat = run.chatForSession(bridgeSessionSummary.id);
  const bridgeProductSeed = bridgeChat.filter((entry) => entry.from === 'agent:product');
  const bridgeArchitectMessages = bridgeChat.filter((entry) => entry.from === 'agent:architect');
  expect(bridgeProductSeed.length, 'Bridge стартует с handoff-сида от agent:product').toBe(1);
  expect(
    bridgeArchitectMessages.length,
    'Архитектор отвечает в bridge ровно одним сообщением'
  ).toBe(1);
  expect(
    bridgeArchitectMessages[0].at >= bridgeProductSeed[0].at,
    'Сообщение архитектора в bridge должно быть позже handoff-сида продакта'
  ).toBe(true);

  // 4i. Заголовок рана — тот, что отдала title-модель. Это страховка,
  //     что callIndex действительно начинается с титульного ответа,
  //     а не с продактового шага.
  expect(run.meta?.title).toBe(TITLE);

  // 4j. Sandbox cross-role не проверяем отдельным циклом: инвариант
  //     обеспечивает role-scoped wrapper (`buildRoleScopedKbTools`),
  //     а здесь мы уже подтвердили, что план лежит ровно в
  //     `architect/plans/...`, а не где попало (см. 4e). Полноценный
  //     sandbox-тест архитектора (попытка модели уйти из своей kb) —
  //     отдельный TC, по образу TC-19 для продакта.
});
