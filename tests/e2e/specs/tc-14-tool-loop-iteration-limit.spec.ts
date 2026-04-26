import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, type FakeResponse } from '../dsl/scenario';
import { expectChatHasUserPrompt } from '../dsl/run-assertions';
import { expect } from '@playwright/test';

/**
 * TC-14. Tool-loop: превышение лимита итераций.
 *
 * Жёсткий лимит итераций в `runAgentLoop` (DEFAULT_MAX_ITERATIONS = 20)
 * — единственная защита от модели, которая бесконечно гоняет тулы и не
 * отдаёт финал. Тест моделирует именно такой сценарий: каждая итерация
 * fake-OpenRouter снова просит вызвать kb.read, финального ответа нет.
 *
 * Шаги:
 *   1. Сгенерировать сценарий из 25 ответов «вызови kb.read» — заведомо
 *      больше maxIterations, чтобы tools-extension не вычерпался раньше.
 *   2. Запустить smoke.
 *
 * Ожидание:
 *   - На 21-й итерации цикл выходит как `failed` с reason
 *     «Превышен лимит итераций (20)».
 *   - В `tools.jsonl` финальная system-запись с этим текстом.
 *   - В `chat.jsonl` сообщение от `agent:system` с тем же текстом —
 *     понятная диагностика для пользователя.
 *   - Smoke показывает нотификацию «Smoke failed: …».
 */

// 25 > maxIterations=20 — гарантируем, что цикл сам уткнётся в лимит,
// а не выйдет из-за «закончились ответы у fake-сценария» (на этот
// случай fake-fetch отдаёт 500 — тоже тест бы упал, но по другой
// причине). Повторяем kb.read с разными путями — kb.read возвращает
// `{exists:false}` для отсутствующих файлов, не падает, не пишет ничего.
const ITERATIONS_TO_FEED = 25;

function buildLoopingScenario(): FakeResponse[] {
  const responses: FakeResponse[] = [];
  for (let i = 0; i < ITERATIONS_TO_FEED; i += 1) {
    // Каждый раз новый путь, чтобы tools.jsonl читался осмысленно при разборе.
    responses.push(fakeToolCall('kb.read', { path: `loop/probe-${i}.md` }, `call_loop_${i}`));
  }
  return responses;
}

const PROMPT = 'Бесконечно проверяй файлы в kb (для теста лимита)';

test('TC-14: tool-loop падает по лимиту итераций и пишет диагностику в chat.jsonl', async ({
  agent,
}) => {
  // 1. Сценарий: 25 раз подряд «вызови kb.read», финала нет.
  agent.openRouter.respondWith(scenario(...buildLoopingScenario()));

  // 2. Ключ + запуск smoke-цикла.
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);

  // 3. Ждём именно «Smoke failed»-нотификацию: цикл должен закончиться
  //    отказом, а не успехом. Если успех — тест валится здесь.
  //    Таймаут увеличиваем, потому что 20 итераций fake-fetch'а всё-таки
  //    делают видимую паузу (каждый запрос проходит через Node fetch
  //    интерсептор и agent-loop писатель в файл).
  await agent.waitForFailure();

  const run = agent.lastRun();

  // 4a. В tools.jsonl должна быть финальная system-запись с причиной.
  //     Текст формируется в loop.ts: `Превышен лимит итераций (N)`.
  const systemEvents = run.toolEvents.filter((event) => event.kind === 'system');
  const limitEvent = systemEvents.find(
    (event) => typeof event.message === 'string' && event.message.includes('лимит итераций')
  );
  expect(
    limitEvent,
    'Ожидали system-событие в tools.jsonl с текстом про лимит итераций'
  ).toBeTruthy();

  // 4b. Никакого финального assistant-ответа без tool_calls в логе
  //     быть не должно: модель так и не отдала «всё». Проверяем
  //     инверсию инварианта успеха.
  const lastAssistant = run.toolEvents.findLast((event) => event.kind === 'assistant');
  expect(
    lastAssistant?.tool_calls,
    'Финальный assistant в failed-ране ОБЯЗАН содержать tool_calls (мы упёрлись в лимит на tool-call-е)'
  ).toBeTruthy();

  // 4c. Должно быть ровно maxIterations=20 assistant-событий —
  //     ни больше, ни меньше: 20 итераций цикла, на каждой один запрос.
  const assistantEvents = run.toolEvents.filter((event) => event.kind === 'assistant');
  expect(assistantEvents.length).toBe(20);

  // 4d. В chat.jsonl остался исходный prompt пользователя — он туда
  //     пишется ДО запуска цикла, до любых tool-вызовов.
  expectChatHasUserPrompt(run, PROMPT);

  // 4e. И сообщение об ошибке от `agent:system` — финализатор
  //     записывает «Smoke failed: …» именно туда.
  const failureMessage = run.chat.find(
    (entry) => entry.from === 'agent:system' && entry.text.includes('Smoke failed')
  );
  expect(
    failureMessage,
    'Ожидали запись agent:system в chat.jsonl с текстом про Smoke failed'
  ).toBeTruthy();
});
