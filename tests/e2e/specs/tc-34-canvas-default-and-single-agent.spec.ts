import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-34. Канвас — дефолтная вкладка и одиночный продакт (US-24, #0023).
 *
 * Ловим самые дешёвые регрессии canvas foundation:
 *  1. После выбора рана main-area открывается на «Карте», а не на чате.
 *  2. На single-agent ране (продакт без handoff'а) канвас показывает
 *     ровно один кубик `product`. Никаких архитекторов или user-узлов.
 *  3. Переключатель «Карта/Чат» работает в обе стороны: на чате
 *     появляются tool-карточки, кубики канваса исчезают; обратно — наоборот.
 *
 * Сценарий — продактовый smoke без handoff'а: title → kb.list → краткий
 * brief. Финал = `awaiting_human`. Архитектор отключён через
 * `AUTOSTART_ARCHITECT=0` (дефолт фикстуры).
 */

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

test('TC-34: canvas — дефолтная вкладка, единственный кубик продакта, переключение Карта⇆Чат', async ({
  agent,
  vscodeWindow,
}) => {
  agent.openRouter.respondWith(
    scenario(
      fakeFinalAnswer(TITLE),
      fakeToolCall('kb.list', { path: '' }, 'product_list'),
      fakeFinalAnswer(BRIEF)
    )
  );

  await agent.setApiKey();
  await agent.createRun(PROMPT);
  await agent.waitForBrief();
  await agent.waitForRunStatus('awaiting_human');

  // Открываем UI и выбираем ран. После #0023 main-area автоматически
  // встаёт на вкладку «Карта» — никаких ручных переключений.
  await agent.openSidebar();
  await agent.selectRun(agent.lastRun().runId);

  const ui = agentWebviewContent(vscodeWindow);

  // 1. Дефолтная вкладка — «Карта»: кнопка имеет aria-selected=true.
  const canvasTab = ui.locator('button[data-run-tab="canvas"]');
  await canvasTab.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(canvasTab).toHaveAttribute('aria-selected', 'true');
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'false');

  // 2. На канвасе ровно один продакт. Архитектор/user-кубики отсутствуют.
  const canvasRoot = ui.locator('[data-canvas-root]');
  await expect(canvasRoot).toBeVisible();
  await expect(canvasRoot.locator('[data-canvas-role="product"]')).toHaveCount(1);
  await expect(canvasRoot.locator('[data-canvas-role="architect"]')).toHaveCount(0);
  await expect(canvasRoot.locator('[data-canvas-role="user"]')).toHaveCount(0);
  // Никаких рёбер handoff'а на single-agent ране.
  await expect(canvasRoot.locator('[data-canvas-edge]')).toHaveCount(0);

  // 3. Переключение на «Чат» рендерит ленту с tool-карточкой kb.list.
  await agent.switchToChatTab();
  await expect(ui.locator('button[data-run-tab="chat"]')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.locator('.tool-card[data-tool="kb.list"]').first()).toBeVisible();
  // Канвас должен исчезнуть из DOM (условный рендер по tab'у).
  await expect(ui.locator('[data-canvas-root]')).toHaveCount(0);

  // 4. Возврат на «Карту» — кубик продакта снова виден, tool-карточек нет.
  await agent.switchToCanvasTab();
  await expect(ui.locator('[data-canvas-role="product"]')).toBeVisible();
  await expect(ui.locator('.tool-card')).toHaveCount(0);
});
