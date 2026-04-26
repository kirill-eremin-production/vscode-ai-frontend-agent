import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-39. Канвас — drill-in в чат сессии (US-27, #0026).
 *
 * Клик по кубику архитектора → bridge-сессия в чате; клик по
 * handoff-стрелке → та же bridge; клик по кубику продакта → root-сессия.
 * Возврат на «Карту» и обратно через таб «Чат» восстанавливает последнюю
 * просмотренную сессию (`mainArea.lastSession.<runId>`).
 */

test.use({ extraEnv: { AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '1' } });

const PROMPT = 'Хочу баннер acknowledged-cookies на лендинге.';
const TITLE = 'Баннер cookies';

const BRIEF = `# Баннер cookies

## Проблема
Лендинг не показывает уведомление о cookies.

## Целевой пользователь и сценарий
Любой посетитель сайта при первом заходе.

## User stories
- Как посетитель, я хочу видеть короткое уведомление о cookies.

## Acceptance criteria
1. На лендинге появляется баннер при первом визите.

## Не-цели
- Региональные различия GDPR.

## Связанные артефакты kb
—`;

const PLAN = `# План

Базовый план: баннер + dismiss + persistence.

## Цели
- Показать баннер один раз.

## Подзадачи
### 1. Баннер
Описание: компонент в layout'е лендинга.
Затрагиваемые модули: \`src/landing/...\`.
Зависимости: —.

## Архитектурные решения
- Persistence через localStorage.

## Риски и граничные случаи
- [низкий] Приватный режим.

## Связанные артефакты kb
—`;

test('TC-39: drill-in с канваса — кубик/стрелка открывают свою сессию, lastSession восстанавливается', async ({
  agent,
  vscodeWindow,
}) => {
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.list', { path: '' }, 'product_list'),
      fakeFinalAnswer(BRIEF),
      fakeToolCall('kb.list', { path: '' }, 'architect_list'),
      fakeFinalAnswer(PLAN)
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

  // 1. Зафиксировать ожидаемые drill-таргеты прямо с DOM канваса:
  //    - handoff-стрелка: `data-canvas-edge-session` = id bridge-сессии;
  //    - architect cube: `data-canvas-drill-session` = тоже id bridge'а
  //      (она же owned для архитектора);
  //    - product cube: `data-canvas-drill-session` = id root-сессии
  //      (продакт — owner root user-agent, а НЕ bridge, где он лишь
  //      participant; см. unit-тесты на `resolveCubeDrillSession`).
  //    Ожидаемый drill-id берём из DOM: e2e — это контракт «то, что cube
  //    обещает в атрибуте, ровно туда и провалится по Enter».
  const handoffEdge = canvasRoot.locator('[data-canvas-edge="product->architect"]');
  await expect(handoffEdge).toHaveCount(1);
  const architectCube = canvasRoot.locator('[data-canvas-role="architect"]');
  const productCube = canvasRoot.locator('[data-canvas-role="product"]');
  await expect(architectCube).toHaveAttribute('data-canvas-drill-session', /.+/);
  await expect(productCube).toHaveAttribute('data-canvas-drill-session', /.+/);
  const edgeBridgeId = await handoffEdge.getAttribute('data-canvas-edge-session');
  const architectDrillId = await architectCube.getAttribute('data-canvas-drill-session');
  const productDrillId = await productCube.getAttribute('data-canvas-drill-session');
  expect(edgeBridgeId).toBeTruthy();
  // architect cube и handoff edge должны вести в одну и ту же bridge'у —
  // первое требование контракта drill-in.
  expect(architectDrillId).toBe(edgeBridgeId);
  // product cube НЕ ведёт в bridge: это и есть фикс #0026
  // (selectActiveSessionForRole vs. ownership).
  expect(productDrillId).toBeTruthy();
  expect(productDrillId).not.toBe(edgeBridgeId);

  const architectRow = ui.locator(`button[data-session-id="${architectDrillId}"]`);
  const productRow = ui.locator(`button[data-session-id="${productDrillId}"]`);

  // 2. Активация architect cube → таб Чат + выбрана bridge-сессия.
  // focus+Enter вместо pointer-click: SVG `<g>` рендерится в zoom/pan
  // viewBox; его CSS-bbox может перекрываться соседними элементами
  // (SessionsPanel) — pointer-hit-test Playwright'а тогда откажет или
  // отдаст клик не той ноде. У `<g>` есть `tabIndex=0` и onKeyDown
  // (Enter/Space), вызывающий тот же `onDrillIn`, что и `onClick` —
  // для пользователя это эквивалентная a11y-активация role="button",
  // для теста — стабильный путь без зависимости от геометрии.
  await architectCube.focus();
  await architectCube.press('Enter');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(architectRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });

  // 3. Назад на канвас → активация handoff-стрелки → та же bridge.
  await agent.switchToCanvasTab();
  await handoffEdge.focus();
  await handoffEdge.press('Enter');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(architectRow).toHaveAttribute('aria-pressed', 'true');

  // 4. Назад на канвас → активация product cube → выбран `productDrillId`
  //    (root user-agent сессия), а bridge-ряд снят с выделения.
  await agent.switchToCanvasTab();
  await productCube.focus();
  await productCube.press('Enter');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(productRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  await expect(architectRow).toHaveAttribute('aria-pressed', 'false');

  // 5. Возврат на «Карту», ничего не меняем; снова таб «Чат» —
  //    подсвечена product-сессия (lastViewedSession восстановилась).
  await agent.switchToCanvasTab();
  await agent.switchToChatTab();
  await expect(productRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
});
