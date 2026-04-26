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
 *   - В DOM ленты есть `.tool-card[data-status="error"]` для kb.read с текстом ошибки.
 *   - Карточка автоматически развёрнута (последняя error-карточка #0021).
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
  //    После #0021 одна tool-карточка соответствует одному tool_call'у:
  //    call+result склеены в пару, статус `error` поставлен из
  //    `tool_result.error`. Карточка помечена `data-status="error"` и
  //    автоматически развёрнута (auto-expand для последней error-карточки).
  //    Текст ошибки рендерится внутри развёрнутого тела.
  const ui = agentWebviewContent(vscodeWindow);
  const errorCard = ui.locator('.tool-card[data-tool="kb.read"][data-status="error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('sandbox');
  await expect(errorCard).toContainText('error');
});
