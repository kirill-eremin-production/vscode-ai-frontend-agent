import { test, expect } from '../fixtures/agent';
import { openAgentPanel, agentWebviewContent } from '../helpers/webview';

/**
 * TC-33. Трёхпанельный shell — дефолт и расположение «+ Новый ран» (#0017).
 *
 * Этот TC намеренно UI-only: никаких LLM-вызовов, fake-сценарий пустой.
 * Цель — зафиксировать инвариант layout'а:
 *
 *  1. При первом старте на широком окне (>700px) видны три колонки,
 *     обе боковые — раскрыты.
 *  2. Кнопка «+ Новый ран» живёт в шапке списка (IconButton с
 *     aria-label="Новый ран") и НЕ внутри тела списка (никаких
 *     textarea/Start-run-кнопок там быть не должно).
 *  3. Свёрнутая полоса левой панели (32px) показывает ровно две иконки —
 *     «Развернуть» и «Новый ран». Это наш самый ценный инвариант:
 *     быстро создать ран можно даже из свёрнутого состояния, без
 *     лишнего клика «развернуть → потом плюс».
 *  4. Клик «Новый ран» переводит main-area в режим заглушки
 *     `'Форма создания — #0018'` (#0018 заменит её настоящей формой).
 *  5. Правая панель — заглушка #0019 («Sessions panel — TBD #0019»),
 *     сворачивается/разворачивается симметрично.
 *
 * Persistence через `state.setUiPref` и поведение узкого окна (<700px)
 * остаются в markdown-описании — их e2e-проверка требует
 * durability-инфры (TC-16 паттерн) и контроля over размера webview-
 * фрейма; для этого first cut'а достаточно UI-инвариантов.
 */
test('TC-33: default three-panel layout, "+ New run" в шапке и в свёрнутой полосе', async ({
  vscodeWindow,
}) => {
  await openAgentPanel(vscodeWindow);
  const ui = agentWebviewContent(vscodeWindow);

  // 1. Обе боковые панели — в раскрытом состоянии.
  const leftExpanded = ui.locator('aside[aria-label="Список ранов"]');
  const rightExpanded = ui.locator('aside[aria-label="Сессии рана"]');
  await leftExpanded.waitFor({ state: 'visible', timeout: 15_000 });
  await rightExpanded.waitFor({ state: 'visible', timeout: 15_000 });

  // 2. Кнопка «+ Новый ран» — в шапке левой панели (IconButton с
  //    aria-label="Новый ран"), а не в теле списка.
  const newRunInHeader = leftExpanded.locator('header button[aria-label="Новый ран"]');
  await expect(newRunInHeader).toBeVisible();

  // Тело левой панели не содержит ни textarea, ни submit-кнопки старого
  // composer'а — composer уехал из сайдбара (#0017 acceptance).
  await expect(leftExpanded.locator('textarea')).toHaveCount(0);
  await expect(leftExpanded.locator('button[type="submit"]')).toHaveCount(0);

  // 3. Правая панель — заглушка #0019.
  await expect(rightExpanded).toContainText('Sessions panel — TBD #0019');

  // 4. Сворачиваем левую панель.
  await leftExpanded.locator('button[aria-label="Свернуть список ранов"]').click();

  const leftCollapsed = ui.locator('aside[aria-label="Список ранов (свёрнут)"]');
  await leftCollapsed.waitFor({ state: 'visible', timeout: 5_000 });
  // Раскрытый aside исчез — селекторы взаимоисключающие по aria-label.
  await expect(leftExpanded).toHaveCount(0);

  // В свёрнутой полосе обе ключевые иконки доступны без разворота:
  // «Развернуть» и «Новый ран». Это и есть смысл сжатой панели —
  // не терять hot-пути.
  await expect(leftCollapsed.locator('button[aria-label="Развернуть список ранов"]')).toBeVisible();
  await expect(leftCollapsed.locator('button[aria-label="Новый ран"]')).toBeVisible();

  // 5. Клик «Новый ран» (из свёрнутой полосы) переключает main-area
  //    в режим создания рана: появляется форма с textarea и кнопкой
  //    «Start run». #0018 заменит её более полноценным экраном.
  await leftCollapsed.locator('button[aria-label="Новый ран"]').click();
  await expect(ui.locator('main .run-create__input')).toBeVisible();
  await expect(ui.locator('main .run-create button[type="submit"]')).toBeVisible();

  // 6. Возвращаем левую панель — состояние симметрично.
  await leftCollapsed.locator('button[aria-label="Развернуть список ранов"]').click();
  await leftExpanded.waitFor({ state: 'visible', timeout: 5_000 });

  // 7. Сворачиваем/разворачиваем правую панель — стандартный
  //    инвариант симметрии (без «+ Новый ран» — он только слева).
  await rightExpanded.locator('button[aria-label="Свернуть панель сессий"]').click();
  const rightCollapsed = ui.locator('aside[aria-label="Сессии рана (свёрнуто)"]');
  await rightCollapsed.waitFor({ state: 'visible', timeout: 5_000 });
  await expect(
    rightCollapsed.locator('button[aria-label="Развернуть панель сессий"]')
  ).toBeVisible();
  // В свёрнутой полосе справа — ровно одна кнопка (только «Развернуть»),
  // без аналога «+ Новый ран».
  await expect(rightCollapsed.locator('button')).toHaveCount(1);
});
