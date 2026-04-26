import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-38. Канвас — флэш стрелки при user-вмешательстве (US-26, #0025).
 *
 * Hybrid-сценарий по образцу TC-32: после первичного handoff'а пользователь
 * пишет в bridge → bridge получает `{kind:'user'}` в participants →
 * `layoutCanvas` рисует новое user-ребро → `useArrowFlashes` ловит его
 * как «появление» и навешивает `data-arrow-flashing="true"` на ~3 секунды.
 *
 * Историческая глухота ловится отдельно: ДО действия пользователя на
 * канвасе не должно быть ни одного `data-arrow-flashing="true"` —
 * существующее handoff-ребро уже было в meta при mount'е, флэш на него
 * не запускается.
 */

test.use({ extraEnv: { AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '1' } });

const PROMPT =
  'Хочу добавить тёмную тему в настройки профиля. Acceptance: переключатель в /profile/settings.';
const TITLE = 'Тёмная тема настроек профиля';

const BRIEF = `# Тёмная тема настроек профиля

## Проблема
Разработчики устают от светлой темы.

## Целевой пользователь и сценарий
Фронтенд-разработчик переключает тему.

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
- Тема через CSS-классы (без FOUC).

## Риски и граничные случаи
- [низкий] Конфликт с приватным режимом.

## Связанные артефакты kb
—`;

const USER_FOLLOWUP = 'А ещё убедись, что нет FOUC при гидратации.';

test('TC-38: user-followup триггерит data-arrow-flashing на user-стрелке, через 3+ сек атрибут снимается', async ({
  agent,
  vscodeWindow,
}) => {
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

  await agent.openSidebar();
  await agent.selectRun(agent.lastRun().runId);

  const ui = agentWebviewContent(vscodeWindow);
  const canvasRoot = ui.locator('[data-canvas-root]');
  await canvasRoot.waitFor({ state: 'visible', timeout: 15_000 });

  // Историческая глухота: при первом монтировании канваса для уже
  // готового handoff'а флэшей быть не должно.
  await expect(canvasRoot.locator('[data-arrow-flashing="true"]')).toHaveCount(0);

  // Пользователь шлёт follow-up — bridge становится hybrid, появляется
  // user-ребро. Это новое ребро = флэш 'appear' (~3 сек).
  await agent.sendUserMessage(USER_FOLLOWUP);

  const userEdgeFlashing = canvasRoot.locator(
    '[data-canvas-edge="user->architect"][data-arrow-flashing="true"]'
  );
  await expect(userEdgeFlashing).toHaveCount(1, { timeout: 10_000 });

  // Дождёмся, пока архитектор отработает continue-цикл, — это
  // подтверждает, что в течение анимации UI не блокировался.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (agent.lastRun().plan === PLAN_V2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(agent.lastRun().plan).toBe(PLAN_V2);

  // Через ~3 сек анимация должна сняться (FLASH_DURATIONS_MS.appear = 3000).
  await expect(canvasRoot.locator('[data-arrow-flashing="true"]')).toHaveCount(0, {
    timeout: 5_000,
  });
  // Сама стрелка остаётся в DOM (ребро живёт после анимации).
  await expect(canvasRoot.locator('[data-canvas-edge="user->architect"]')).toHaveCount(1);
});
