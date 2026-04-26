import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-36. Канвас — hybrid: появляется кубик user и ребро user→architect (US-24, #0023, #0012).
 *
 * Расширяет TC-32: после того, как пользователь вмешивается в bridge,
 * `participants` дополняется `{kind:'user'}` → канвас должен это
 * отразить отдельным кубиком и dashed-ребром.
 *
 * TC ловит регрессии:
 *  - если `layoutCanvas` перестанет добавлять user-узел при
 *    `hasUserParticipant` — пропадёт кубик и ребро;
 *  - если перестанет различаться `kind: 'handoff' | 'user'` — UI не
 *    сможет нарисовать пунктир/подпись правильно;
 *  - если participants bridge'а не обновляется на extension-стороне
 *    после user-message в `awaiting_human` — невозможно отличить чисто
 *    agent-agent ран от hybrid'а.
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

test('TC-36: hybrid — user-intervention добавляет user-кубик и dashed-ребро user→architect', async ({
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

  // 1. До интервенции — нет user-кубика, нет user-ребра. Handoff на месте.
  await expect(canvasRoot.locator('[data-canvas-role="product"]')).toHaveCount(1);
  await expect(canvasRoot.locator('[data-canvas-role="architect"]')).toHaveCount(1);
  await expect(canvasRoot.locator('[data-canvas-role="user"]')).toHaveCount(0);
  await expect(
    canvasRoot.locator('[data-canvas-edge="product->architect"][data-canvas-edge-kind="handoff"]')
  ).toHaveCount(1);
  await expect(canvasRoot.locator('[data-canvas-edge="user->architect"]')).toHaveCount(0);

  // 2. Composer работает поверх обеих вкладок — отправляем follow-up
  //    не покидая канвас.
  await agent.sendUserMessage(USER_FOLLOWUP);

  // 3. Ждём plan_v2 — сигнал, что bridge стала hybrid и continue прошёл.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (agent.lastRun().plan === PLAN_V2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(agent.lastRun().plan, 'plan.md должен обновиться до v2 после continue').toBe(PLAN_V2);

  // 4. Канвас в hybrid-виде:
  //    - появляется user-кубик;
  //    - появляется dashed-ребро user→architect;
  //    - handoff-ребро product→architect остаётся на месте.
  await expect(canvasRoot.locator('[data-canvas-role="user"]')).toHaveCount(1);
  await expect(
    canvasRoot.locator('[data-canvas-edge="user->architect"][data-canvas-edge-kind="user"]')
  ).toHaveCount(1);
  await expect(
    canvasRoot.locator('[data-canvas-edge="product->architect"][data-canvas-edge-kind="handoff"]')
  ).toHaveCount(1);
});
