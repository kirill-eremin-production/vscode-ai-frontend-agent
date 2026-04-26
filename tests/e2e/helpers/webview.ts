import type { FrameLocator, Page } from '@playwright/test';
import { runCommand } from './commands';

/**
 * Хелперы для работы с webview-панелью расширения, открытой как
 * полноценная вкладка редактора (`AgentPanel`, команда
 * `AI Frontend Agent: Open in Tab`).
 *
 * Почему панель, а не sidebar:
 *  - больше свободного места — видео тестов читается заметно лучше;
 *  - открывается одной командой через палитру, без клика по
 *    Activity Bar (тот склонен переключать состояния и вообще
 *    лежит в `.part.activitybar`, чьи селекторы дрейфуют между
 *    версиями VS Code).
 *
 * VS Code рендерит webview как **двойной** iframe:
 *   1. Внешний — `<iframe class="webview ready">`. ВАЖНО: он лежит НЕ
 *      внутри `.part.editor`, а в overlay-слое workbench'а (VS Code
 *      переиспользует webview между разными местами и поднимает их
 *      абсолютным позиционированием), поэтому селектор по родителю
 *      вроде `.part.editor iframe.webview` не работает.
 *   2. Внутренний — `<iframe id="active-frame">` внутри первого; уже
 *      он показывает наш `index.html` с React-приложением.
 *
 * Стратегия выбора нужного iframe — `iframe.webview:visible` + `.first()`.
 * VS Code держит несколько `iframe.webview` одновременно (по одному на
 * каждый view container, плюс «бэкапы» свёрнутых view'ов), но на любой
 * момент видим обычно ровно один — текущий активный. Если в окне реально
 * открыты сразу несколько webview расширения, эту эвристику придётся
 * уточнять (например, через title панели в title-bar редактора).
 */

const VISIBLE_WEBVIEW = 'iframe.webview:visible';

/**
 * Открыть панель агента отдельной вкладкой через палитру команд.
 * Singleton'ность панели обеспечивает сам extension: повторный вызов
 * команды просто сфокусирует уже открытую вкладку.
 */
export async function openAgentPanel(window: Page): Promise<void> {
  await runCommand(window, 'AI Frontend Agent: Open in Tab');
  const panelFrame = window.locator(VISIBLE_WEBVIEW).first();
  await panelFrame.waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Вернуть FrameLocator на «контент» панели — на тот самый внутренний
 * iframe, в котором живёт React-приложение.
 *
 * Используем `Locator.contentFrame()`: он берёт уже разрешённый Locator
 * и спускается в его iframe. В отличие от `Page.frameLocator(selector)`,
 * это даёт нам контроль над тем, какой именно iframe выбрать
 * (через `:visible` + `.first()`).
 */
export function agentWebviewContent(window: Page): FrameLocator {
  return window.locator(VISIBLE_WEBVIEW).first().contentFrame().frameLocator('iframe#active-frame');
}
