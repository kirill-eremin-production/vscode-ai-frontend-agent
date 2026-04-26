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

  // 1. Получить sessionId из data-canvas-edge-session handoff-стрелки.
  const handoffEdge = canvasRoot.locator('[data-canvas-edge="product->architect"]');
  await expect(handoffEdge).toHaveCount(1);
  const bridgeSessionId = await handoffEdge.getAttribute('data-canvas-edge-session');
  expect(bridgeSessionId).toBeTruthy();

  // 2. Клик по кубику архитектора → таб «Чат» + выбрана bridge-сессия.
  await canvasRoot.locator('[data-canvas-role="architect"]').click();
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  const architectRow = ui.locator(`button[data-session-id="${bridgeSessionId}"]`);
  await expect(architectRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });

  // 3. Назад на канвас → клик по handoff-стрелке → та же bridge выделена.
  await agent.switchToCanvasTab();
  await canvasRoot.locator('[data-canvas-edge="product->architect"]').click();
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(architectRow).toHaveAttribute('aria-pressed', 'true');

  // 4. Назад на канвас → клик по кубику продакта → root-сессия выделена
  //    (а не bridge). Берём её id из правой панели по aria-pressed=false
  //    у НЕ-bridge ряда — то есть просто ищем активную после клика.
  await agent.switchToCanvasTab();
  await canvasRoot.locator('[data-canvas-role="product"]').click();
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  // Bridge-ряд больше не подсвечен.
  await expect(architectRow).toHaveAttribute('aria-pressed', 'false', { timeout: 5_000 });
  // Подсвечен другой ряд — это и есть продактовая сессия.
  const productRow = ui.locator('button[data-session-id][aria-pressed="true"]');
  await expect(productRow).toHaveCount(1);
  const productSessionId = await productRow.getAttribute('data-session-id');
  expect(productSessionId).not.toBe(bridgeSessionId);

  // 5. Возврат на «Карту», ничего не меняем; снова таб «Чат» —
  //    подсвечена product-сессия (lastViewedSession восстановилась).
  await agent.switchToCanvasTab();
  await agent.switchToChatTab();
  await expect(ui.locator(`button[data-session-id="${productSessionId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 5_000 }
  );
});
