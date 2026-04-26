import { test } from '../fixtures/agent';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { expect } from '@playwright/test';

/**
 * TC-32. Мульти-агент: user-intervention превращает agent-agent в hybrid (#0012).
 *
 * Что проверяем (end-to-end):
 *  1. Цепочка продакт → handoff → архитектор отрабатывает (как в TC-31).
 *  2. Bridge-сессия после handoff'а имеет `participants` ровно из двух
 *     агентов, без пользователя.
 *  3. Пользователь шлёт сообщение в активную (= bridge) сессию через
 *     общий composer (статус `awaiting_human` после плана).
 *  4. Архитектор получает continue-цикл, отрабатывает повторно и пишет
 *     обновлённый plan_v2.
 *  5. После этого bridge-сессия — hybrid: `participants` дополнен
 *     `{kind:'user'}`, в её `chat.jsonl` лежит сообщение пользователя
 *     (мы проверяем именно сессию-мост, а не активную в общем смысле,
 *     чтобы убедиться, что user-ввод не утёк в продактовую).
 *
 * Зачем нужен `extraEnv`:
 *   фикстура vscode.ts по умолчанию выставляет
 *   `AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=0` для продактовых TC.
 *   Здесь handoff обязателен — переопределяем на '1'.
 */

test.use({ extraEnv: { AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '1' } });

const PROMPT =
  'Хочу добавить тёмную тему в настройки профиля. Целевая аудитория — фронтенд-разработчики, работающие вечером. Acceptance: переключатель в /profile/settings, тема сохраняется в localStorage и применяется без перезагрузки. Не-цели: системная тема, синхронизация между устройствами.';

const TITLE = 'Тёмная тема настроек профиля';

const BRIEF = `# Тёмная тема настроек профиля

## Проблема
Разработчики работают по вечерам и устают от светлой темы.

## Целевой пользователь и сценарий
Фронтенд-разработчик переключает тему в /profile/settings.

## User stories
- Как разработчик, я хочу переключатель темы.

## Acceptance criteria
1. Переключатель темы в настройках.

## Не-цели
- Авто-подхват системной темы.

## Связанные артефакты kb
—`;

const PLAN_V1 = `# План

Базовый план: переключатель + persistence.

## Цели
- Переключатель темы.

## Подзадачи
### 1. Переключатель
Описание: контролируемый компонент.
Затрагиваемые модули: \`src/profile/settings/...\`.
Зависимости: —.

## Архитектурные решения
- Тема через CSS-классы.

## Риски и граничные случаи
- [низкий] Конфликт с приватным режимом.

## Связанные артефакты kb
—`;

const PLAN_V2 = `# План

Уточнённый план с учётом доп. ввода пользователя.

## Цели
- Переключатель темы.
- Применение без FOUC при гидратации.

## Подзадачи
### 1. Переключатель
Описание: контролируемый компонент.
Затрагиваемые модули: \`src/profile/settings/...\`.
Зависимости: —.

### 2. SSR-применение
Описание: класс корня ставится до гидратации.
Затрагиваемые модули: \`src/profile/theme/...\`.
Зависимости: 1.

## Архитектурные решения
- Тема через CSS-классы (без перезагрузки и без FOUC).

## Риски и граничные случаи
- [низкий] Конфликт с приватным режимом.

## Связанные артефакты kb
—`;

const USER_FOLLOWUP = 'А ещё убедись, что нет FOUC при гидратации.';

test('TC-32: user-intervention в bridge превращает её в hybrid', async ({ agent }) => {
  // Сценарий: title, продактовый kb.list, brief, архитекторский kb.list,
  // первый plan, архитекторский kb.list при resume, plan_v2.
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.list', { path: '' }, 'product_list'),
      fakeFinalAnswer(BRIEF),
      fakeToolCall('kb.list', { path: '' }, 'architect_list_v1'),
      fakeFinalAnswer(PLAN_V1),
      fakeToolCall('kb.list', { path: '' }, 'architect_list_v2'),
      fakeFinalAnswer(PLAN_V2)
    )
  );

  await agent.setApiKey();
  await agent.createRun(PROMPT);
  await agent.waitForBrief();
  await agent.waitForPlan();
  await agent.waitForRunStatus('awaiting_human');

  // 1. До интервенции: bridge — agent-agent, participants без user.
  const runBefore = agent.lastRun();
  const bridgeBefore = runBefore.meta?.sessions[1];
  expect(bridgeBefore?.kind, 'Вторая сессия — bridge').toBe('agent-agent');
  const bridgeMetaBefore = runBefore.sessionMetaForSession(bridgeBefore!.id);
  expect(bridgeMetaBefore?.participants).toEqual([
    { kind: 'agent', role: 'product' },
    { kind: 'agent', role: 'architect' },
  ]);

  // 2. Открываем рана в UI (composer без selectedRun не появится),
  //    отправляем follow-up. Активная сессия = bridge → сообщение туда.
  await agent.openSidebar();
  await agent.selectRun(runBefore.runId);
  await agent.sendUserMessage(USER_FOLLOWUP);

  // 3. Ждём plan_v2 — это сигнал, что архитектор прошёл continue-цикл.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (agent.lastRun().plan === PLAN_V2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(agent.lastRun().plan, 'plan.md должен обновиться до v2 после continue').toBe(PLAN_V2);

  const runAfter = agent.lastRun();
  const bridgeAfter = runAfter.meta?.sessions[1];
  const bridgeMetaAfter = runAfter.sessionMetaForSession(bridgeAfter!.id);

  // 4. participants теперь дополнен user'ом — ключевой инвариант hybrid.
  expect(
    bridgeMetaAfter?.participants,
    'Bridge после user-intervention становится hybrid: participants += user'
  ).toEqual([
    { kind: 'agent', role: 'product' },
    { kind: 'agent', role: 'architect' },
    { kind: 'user' },
  ]);
  // kind остаётся agent-agent — hybrid это про participants, не про kind.
  expect(bridgeMetaAfter?.kind).toBe('agent-agent');

  // 5. Сообщение пользователя лежит ровно в bridge'е — не в продактовой.
  const bridgeChat = runAfter.chatForSession(bridgeAfter!.id);
  const userInBridge = bridgeChat.filter(
    (entry) => entry.from === 'user' && entry.text === USER_FOLLOWUP
  );
  expect(userInBridge.length, 'follow-up пользователя — в bridge').toBe(1);

  const productChat = runAfter.chatForSession(runAfter.meta!.sessions[0].id);
  expect(
    productChat.some((entry) => entry.from === 'user' && entry.text === USER_FOLLOWUP),
    'follow-up пользователя НЕ должен утечь в продактовую сессию'
  ).toBe(false);

  // 6. У продактовой сессии participants без изменений — она к hybrid не
  //    превращалась (юзер писал в bridge, не в продакта).
  const productMeta = runAfter.sessionMetaForSession(runAfter.meta!.sessions[0].id);
  expect(productMeta?.participants).toEqual([{ kind: 'user' }, { kind: 'agent', role: 'product' }]);

  // 7. Финальный статус — снова `awaiting_human` (план готов).
  expect(runAfter.meta?.status).toBe('awaiting_human');
});
