import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-39. Канвас — drill-in через клик по кубикам/User-элементу
 * (US-27, #0026, #0028, #0042, #0043, #0045).
 *
 * После #0042 на канвасе нет edge'ей коммуникации (org-chart-иерархия,
 * не flow-граф), поэтому исторический drill-by-edge удалён вместе с
 * самими стрелками. Контракт `data-canvas-drill-session` сохранён —
 * именно через него тест узнаёт, какая сессия откроется по клику,
 * не лезя в runtime-state webview'а.
 *
 * Что покрываем (по AC #0045):
 *  - клик по кубику архитектора (idle после плана) → открывается его
 *    последняя owned-сессия (bridge product↔architect);
 *  - клик по визуальному User-элементу → открывается корневая
 *    user↔product сессия рана (#0043);
 *  - lastViewedSession persistence (#0026): возврат на «Карту» → клик
 *    по «Чату» восстанавливает ту же сессию, в которую только что
 *    провалился drill.
 *
 * Кейс «клик по работающему программисту» вынесен в ручной
 * TC-52 (.md) — программистский цикл сейчас без e2e-инфраструктуры
 * автоматизированного запуска.
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

test('TC-39: drill через кубик архитектора и User-элемент, lastSession восстанавливается', async ({
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
  //    - User-элемент: `data-canvas-drill-session` = id корневой
  //      user-agent сессии (`resolveUserDrillSession`);
  //    - architect cube: `data-canvas-drill-session` = id bridge'а
  //      product↔architect (recipient handoff'а — он же owner;
  //      см. unit-тесты на `resolveCubeDrillSession`).
  //    Edge'ей коммуникации больше нет (#0042), поэтому единственные
  //    источники drill-id — кубики и User-элемент.
  const userElement = canvasRoot.locator('[data-canvas-user]');
  const architectCube = canvasRoot.locator('[data-canvas-role="architect"]');
  await expect(userElement).toHaveAttribute('data-canvas-drill-session', /.+/);
  await expect(architectCube).toHaveAttribute('data-canvas-drill-session', /.+/);
  const userDrillId = await userElement.getAttribute('data-canvas-drill-session');
  const architectDrillId = await architectCube.getAttribute('data-canvas-drill-session');
  expect(userDrillId).toBeTruthy();
  expect(architectDrillId).toBeTruthy();
  // User-элемент ведёт в корневую user-agent сессию, а bridge архитектора
  // — в ОТДЕЛЬНУЮ сессию (recipient handoff'а). Эти id обязаны различаться,
  // иначе мы потеряем разделение «заказчик ↔ продакт» vs. «продакт ↔
  // архитектор», которое и есть ценность отдельных drill-точек.
  expect(architectDrillId).not.toBe(userDrillId);

  const architectRow = ui.locator(`button[data-session-id="${architectDrillId}"]`);
  const userRow = ui.locator(`button[data-session-id="${userDrillId}"]`);

  // 2. Активация architect cube → таб «Чат» + выбрана его bridge-сессия.
  // focus+Enter вместо pointer-click: SVG `<g>` рендерится в zoom/pan
  // viewBox, его CSS-bbox может перекрываться соседними элементами
  // (SessionsPanel) — pointer-hit-test Playwright'а тогда отдаст клик
  // не той ноде. У `<g>` есть `tabIndex=0` и onKeyDown (Enter/Space),
  // вызывающий тот же `onDrillIn`, что и `onClick` — для пользователя
  // это эквивалентная a11y-активация role="button", для теста —
  // стабильный путь без зависимости от геометрии.
  await architectCube.focus();
  await architectCube.press('Enter');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(architectRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });

  // 3. Назад на канвас → активация User-элемента → корневая user↔product
  //    сессия (а не bridge архитектора): это и есть #0043 — заказчик
  //    отделён от участников команды, его кубик ведёт в свою встречу.
  await agent.switchToCanvasTab();
  await userElement.focus();
  await userElement.press('Enter');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(userRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  // Ряд архитектора в `SessionsPanel` снят с выделения — выбранная
  // строка ровно одна, и это user-сессия.
  await expect(architectRow).toHaveAttribute('aria-pressed', 'false');

  // 4. lastViewedSession (#0026): возврат на «Карту», ничего не меняем,
  //    снова таб «Чат» — подсветка снова на user-сессии (последней,
  //    где мы были до перехода на «Карту»). Persist'ится под ключом
  //    `mainArea.lastSession.<runId>` через UI-prefs.
  await agent.switchToCanvasTab();
  await agent.switchToChatTab();
  await expect(userRow).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
});
