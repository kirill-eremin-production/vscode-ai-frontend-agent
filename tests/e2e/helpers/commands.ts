import type { Page } from '@playwright/test';

/**
 * Хелперы для драйва VS Code workbench из Playwright.
 *
 * Все локаторы здесь — обращения к стабильным DOM-классам/role'ам
 * VS Code workbench. Если они поменяются в новой версии VS Code —
 * фиксируется здесь, в одном месте, не размазываясь по спекам.
 */

/**
 * Открыть Command Palette и выполнить команду по её точному заголовку.
 *
 * Используем именно полный title (а не command id), потому что DOM
 * палитры в VS Code показывает title — id'ы видны только в JSON keybindings.
 * Берём первый совпавший элемент в списке и кликаем — фильтр Quick Pick
 * по тексту обычно ставит точное совпадение наверх.
 *
 * @param window  главное окно VS Code (Page из фикстуры).
 * @param title   текст команды как он отображается в палитре.
 */
/**
 * Дождаться готовности workbench и поставить ему фокус.
 *
 * Без этого первый keypress часто уходит «в пустоту»: VS Code ещё
 * не дорендерил activitybar или окно не получило focus после launch.
 * Кликаем по `.monaco-workbench` — это контейнер всего UI, безопасное
 * место для клика, ничего побочного не активирует.
 */
async function focusWorkbench(window: Page): Promise<void> {
  const workbench = window.locator('.monaco-workbench').first();
  await workbench.waitFor({ state: 'visible', timeout: 30_000 });
  await workbench.click({ position: { x: 5, y: 5 } });
}

/**
 * Локатор инпута Quick Input Widget. В разных версиях VS Code класс
 * `.input` на самом инпуте то есть, то нет, поэтому фильтруем по
 * родителю `.quick-input-widget` и берём первый видимый input/textarea.
 */
function quickInputLocator(window: Page) {
  // Внутри `.quick-input-widget` есть два разных текстовых инпута:
  //  - инпут палитры команд: `<input role="combobox" class="input">`
  //  - инпут showInputBox: `<input class="input">` внутри `.monaco-inputbox`
  // Кроме того есть скрытый checkbox `.quick-input-check-all`.
  //
  // Целимся именно по `.monaco-inputbox input` — это покрывает оба
  // случая (палитра тоже использует monaco-inputbox), но отсекает
  // checkbox. `:visible` отсекает закрытые виджеты, которые VS Code
  // оставляет в DOM после dismiss.
  return window.locator('.quick-input-widget .monaco-inputbox input:visible').first();
}

export async function runCommand(window: Page, title: string): Promise<void> {
  await focusWorkbench(window);
  // Cmd+Shift+P (Ctrl на Linux/Win) — стандартный keybinding палитры.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await window.keyboard.press(`${modifier}+Shift+P`);

  const input = quickInputLocator(window);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  // Cmd+Shift+P префиксует строку символом `>` (режим команд палитры).
  // `fill` затирает всё содержимое, так что префикс надо вернуть руками,
  // иначе VS Code переключится в quick-open файлов.
  await input.fill(`>${title}`);

  // Дожидаемся, пока в списке появится хотя бы один совпавший ряд —
  // иначе Enter улетит «в пустоту» и палитра тихо закроется без
  // выполнения команды. Это поведение VS Code, защищаемся явно.
  const firstMatch = window.locator('.quick-input-widget .monaco-list-row').first();
  await firstMatch.waitFor({ state: 'visible', timeout: 10_000 });

  // Подтверждаем выбор Enter'ом, а не кликом: клик по `.monaco-list-row`
  // в Monaco-листе иногда только подсвечивает строку (зависит от точки
  // hit-теста), а Enter всегда исполняет активную (первую) запись.
  await window.keyboard.press('Enter');
}

/**
 * Заполнить открытый input box (vscode.window.showInputBox).
 *
 * Логика похожа на palette: то же Quick Input Widget, но без поиска —
 * мы просто пишем значение и подтверждаем Enter'ом.
 */
export async function fillInputBox(window: Page, value: string): Promise<void> {
  const input = quickInputLocator(window);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(value);
  await window.keyboard.press('Enter');
}

/**
 * Дождаться появления notification toast'а с подстрокой в тексте.
 * Возвращает локатор toast'а — тест может проверить точный текст.
 */
export async function waitForNotification(window: Page, substring: string) {
  const toast = window
    .locator('.notifications-toasts .notification-list-item')
    .filter({ hasText: substring })
    .first();
  await toast.waitFor({ state: 'visible', timeout: 30_000 });
  return toast;
}
