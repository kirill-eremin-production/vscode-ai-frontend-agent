import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import { expectToolSucceeded } from '../dsl/run-assertions';

/**
 * TC-23. Клик по ссылке на файл из tool_result открывает его в редакторе — US-11.
 *
 * После того как agent-loop вызвал `kb.write` и в `tools.jsonl` появился
 * tool_result с `result.path`, в карточке рана отрисовывается кнопка-ссылка
 * с относительным путём от kb-корня. Клик отправляет в extension
 * `editor.open { path }`, тот резолвит абсолютный путь и зовёт
 * `vscode.commands.executeCommand('vscode.open', ...)`.
 *
 * Шаги:
 *   1. Сценарий: kb.write → финал. Smoke-роль и UI-панель.
 *   2. Открыть карточку, дождаться «лен»ту с tool-карточкой kb.write.
 *   3. Кликнуть по ссылке.
 *
 * Ожидание:
 *   - VS Code открывает таб редактора с этим файлом — title таба
 *     содержит имя файла (`note-link.md`).
 */

const PROMPT = 'Создай smoke/note-link.md с текстом "open me"';
const NOTE_PATH = 'smoke/note-link.md';
const NOTE_CONTENT = 'open me';

test('TC-23: ссылка на созданный kb.write файл открывает его в редакторе', async ({
  agent,
  vscodeWindow,
}) => {
  // 1. Сценарий: первая итерация — kb.write, вторая — финал. Цикл
  //    штатно завершается, а в tools.jsonl остаётся tool_result.path,
  //    которому в UI соответствует кликабельная ссылка.
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('kb.write', { path: NOTE_PATH, content: NOTE_CONTENT }),
      fakeFinalAnswer(`Создал ${NOTE_PATH}.`)
    )
  );

  // 2. Ключ + smoke + ожидание финала. Smoke-роль показывает notification
  //    «Smoke OK …» по успешному завершению — это наш сигнал.
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);
  await agent.waitForCompletion();

  // 3. Открываем UI и выбираем единственный ран. До этого React-карточка
  //    рана не смонтирована — кликать будет не по чему.
  await agent.openSidebar();
  await agent.selectRun('any');

  // 4. Sanity-check: kb.write реально попал в успешные tool_result —
  //    иначе ссылки не появилось бы в ленте.
  expectToolSucceeded(agent.lastRun(), 'kb.write');

  // 5. Ждём появления tool-карточки kb.write в ленте — она прилетает
  //    через `runs.tool.appended` broadcast'ы (US-11). Без этого ожидания
  //    клик может прийти раньше, чем DOM смержит chat + tools.
  await agent.waitForToolEntry('kb.write');

  // 6. Кликаем по ссылке. Имя в кнопке — относительный путь от kb-корня
  //    (например, `smoke/note-link.md`), без префикса `.agents/knowledge/`.
  await agent.openFileFromToolEntry(NOTE_PATH);

  // 7. Дожидаемся, пока VS Code откроет вкладку с нужным файлом. Tab'ы
  //    workbench'а лежат в `.tabs-container` с `[role="tab"]`; нам
  //    достаточно убедиться, что появился таб, чей aria-label содержит
  //    имя файла. К URI workspace-папки не привязываемся: тестовая
  //    workspace-папка временная, её путь длинный и нестабильный.
  const tab = vscodeWindow.locator('[role="tab"]', { hasText: 'note-link.md' });
  await tab.first().waitFor({ state: 'visible', timeout: 10_000 });

  // 8. Sanity: таб действительно «активный» (selected). Если бы клик
  //    не сработал, мы бы могли увидеть таб от прошлого открытия в
  //    другом тесте — но изоляция через workspacePath это исключает,
  //    а проверка `aria-selected` страхует от кэширования DOM.
  await expect(tab.first()).toHaveAttribute('aria-selected', 'true');
});
