import { test } from '../fixtures/agent';
import { expect } from '@playwright/test';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import { expectToolFailed } from '../dsl/run-assertions';
import { agentWebviewContent } from '../helpers/webview';

/**
 * TC-24. Tool с ошибкой виден в ленте — US-11.
 *
 * После #0007 лента карточки рана показывает не только chat.jsonl, но и
 * tool-события из tools.jsonl. Упавший тул должен быть отчётливо виден
 * пользователю (с классом ошибки и текстом причины), а не молча уходить
 * в `tools.jsonl` без UI-фидбэка.
 *
 * Сценарий: kb.read с путём за sandbox → resolveKnowledgePath бросит
 * RunStorageError, agent-loop поймает её и положит в tool_result.error;
 * затем — финальный текст, чтобы цикл завершился.
 *
 * Шаги:
 *   1. Сценарий из 2 ответов модели (kb.read с `..`, потом финал).
 *   2. Smoke + ожидание финала.
 *   3. Открыть UI, выбрать ран.
 *
 * Ожидание:
 *   - В tools.jsonl tool_result для kb.read содержит `error` со словом «sandbox».
 *   - В DOM ленты есть `.run-details__tool-error-text` с этим же текстом.
 *   - Tool-карточка для упавшего вызова промечена `.run-details__tool-error`.
 */

const BAD_PATH = '../../../etc/passwd';
const PROMPT = 'Прочитай /etc/passwd через kb.read';

test('TC-24: упавший tool_result виден в ленте с классом ошибки', async ({
  agent,
  vscodeWindow,
}) => {
  // 1. Сценарий: модель пробует sandbox-нарушение, потом сдаётся
  //    финальным ответом (для штатного завершения цикла).
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('kb.read', { path: BAD_PATH }),
      fakeFinalAnswer('Не могу прочитать этот путь — sandbox запрещает.')
    )
  );

  // 2. Ключ + smoke + дожидаемся финала. Финал — успех smoke-роли,
  //    несмотря на упавший тул внутри (tool error ≠ failed run).
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);
  await agent.waitForCompletion();

  // 3. Sanity на уровне диска: tool_result.error действительно есть
  //    и содержит «sandbox». Без этого нет смысла проверять DOM —
  //    значит, в ленту тоже ничего не прилетело бы.
  const run = agent.lastRun();
  expectToolFailed(run, 'kb.read', 'sandbox');

  // 4. Открываем карточку рана. Лента мерджит chat.jsonl + tools.jsonl
  //    и подписывается на новые события — содержимое подгрузится из
  //    runs.get.result + всех ранее долетевших runs.tool.appended.
  await agent.openSidebar();
  await agent.selectRun('any');
  await agent.waitForToolEntry('kb.read');

  // 5. Ищем именно упавшую tool-карточку.
  //
  //    Подвох: в ленте на одно failed-обращение приходится ДВА
  //    `.run-details__entry--tool`-элемента — assistant-карточка с
  //    tool_call (`🛠 модель вызывает тулы …kb.read…`) и tool_result-
  //    карточка (`↪ kb.read … ошибка`). Оба содержат текст «kb.read»,
  //    поэтому фильтр `hasText: 'kb.read'` ловит обе и Playwright
  //    падает в strict mode.
  //
  //    Различаем по уникальному классу `.run-details__tool-error-text` —
  //    он рендерится ТОЛЬКО в ветке tool_result.error. Это и есть
  //    наш якорь к нужной карточке.
  const ui = agentWebviewContent(vscodeWindow);
  const errorText = ui.locator('.run-details__tool-error-text');
  await expect(errorText).toBeVisible();
  await expect(errorText).toContainText('sandbox');

  const errorEntry = ui
    .locator('.run-details__entry--tool')
    .filter({ has: ui.locator('.run-details__tool-error-text') });
  await expect(errorEntry).toContainText('kb.read');
  await expect(errorEntry).toContainText('ошибка');
});
