import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeFinalAnswer, fakeToolCall } from '../dsl/scenario';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-37. Канвас — живые статусы после handoff'а (US-25, #0024).
 *
 * Проверяем, что после того, как продакт сдал бриф и архитектор
 * автоматически отработал план, на канвасе:
 *   - архитектор показывает `awaiting_human` (он владеет активной сессией);
 *   - продакт показывает `idle` с подписью «закончил бриф»
 *     (handoff случился — продакт больше не активен);
 *   - нет «двух одновременно работающих» кубиков
 *     (`thinking`/`tool` не должно быть ни на одном).
 *
 * Live-режим (спиннер во время `running`) не проверяем явно — fake
 * OpenRouter отвечает мгновенно, состояние транзитное и flaky. Финальное
 * состояние post-handoff достаточно полно ловит регрессии
 * `selectActiveSessionForRole` / `ownerRoleOfActiveSession`.
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

test('TC-37: после handoff архитектор «Готово», продакт idle «закончил бриф», нет двух работающих', async ({
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

  // Архитектор владеет активной сессией → awaiting_human.
  await expect(
    canvasRoot.locator('[data-canvas-role="architect"][data-canvas-activity="awaiting_human"]')
  ).toHaveCount(1);

  // Продакт после handoff'а — idle с подписью артефакта.
  const productCube = canvasRoot.locator(
    '[data-canvas-role="product"][data-canvas-activity="idle"]'
  );
  await expect(productCube).toHaveCount(1);
  await expect(productCube.locator('[data-canvas-activity-label]')).toContainText('закончил бриф');

  // Никаких «двух одновременно работающих»: ни thinking, ни tool ни на ком.
  await expect(canvasRoot.locator('[data-canvas-activity="thinking"]')).toHaveCount(0);
  await expect(canvasRoot.locator('[data-canvas-activity="tool"]')).toHaveCount(0);

  // User-кубика нет — bridge без вмешательства (см. также TC-35).
  await expect(canvasRoot.locator('[data-canvas-role="user"]')).toHaveCount(0);
});
