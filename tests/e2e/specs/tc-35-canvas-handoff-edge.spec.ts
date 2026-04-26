import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-35. Канвас — handoff продакт→архитектор рисует ребро (US-24, #0023).
 *
 * Расширяет TC-34: после handoff'а на канвасе должны появиться два
 * кубика (`product`, `architect`) и ровно одно handoff-ребро
 * `product->architect` с подписью «бриф». Юзер-ребра нет — пользователь
 * в bridge не вмешивался.
 *
 * TC ловит регрессии:
 *  - если `SessionSummary.participants` перестанет уезжать в webview —
 *    исчезнет архитектор;
 *  - если `layoutCanvas` сломается на вычислении приёмника handoff'а —
 *    ребро либо не появится, либо пойдёт в обратную сторону;
 *  - если потеряется `briefPath` на bridge-сессии — на ребре не будет
 *    подписи «бриф».
 */

test.use({ extraEnv: { AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '1' } });

const PROMPT =
  'Хочу добавить тёмную тему в настройки профиля. Acceptance: переключатель в /profile/settings, тема сохраняется в localStorage.';

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

const PLAN = `# План

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

test('TC-35: после handoff на канвасе два кубика и ребро product→architect c подписью «бриф»', async ({
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

  // Дефолтная вкладка — «Карта».
  const canvasRoot = ui.locator('[data-canvas-root]');
  await canvasRoot.waitFor({ state: 'visible', timeout: 15_000 });

  // 1. Два кубика — product и architect.
  await expect(canvasRoot.locator('[data-canvas-role="product"]')).toHaveCount(1);
  await expect(canvasRoot.locator('[data-canvas-role="architect"]')).toHaveCount(1);
  // Юзера на канвасе быть не должно — bridge без user-вмешательства.
  await expect(canvasRoot.locator('[data-canvas-role="user"]')).toHaveCount(0);

  // 2. Ровно одно handoff-ребро product→architect.
  const handoffEdge = canvasRoot.locator(
    '[data-canvas-edge="product->architect"][data-canvas-edge-kind="handoff"]'
  );
  await expect(handoffEdge).toHaveCount(1);

  // 3. Подпись на ребре содержит «бриф» (артефакт продакта).
  await expect(handoffEdge).toContainText('бриф');

  // 4. Ребра user→architect быть не должно.
  await expect(canvasRoot.locator('[data-canvas-edge="user->architect"]')).toHaveCount(0);
});
