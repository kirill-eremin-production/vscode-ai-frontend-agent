import { test } from '../fixtures/agent';
import { scenario, fakeToolCall, fakeFinalAnswer } from '../dsl/scenario';
import {
  expectToolCalled,
  expectToolFailed,
  expectFinalAssistantText,
  expectChatHasUserPrompt,
  expectChatHasAgentReply,
} from '../dsl/run-assertions';
import { expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TC-13. Tool-loop: невалидные входы тула.
 *
 * Проверяем, что Ajv-валидатор отбивает плохие аргументы ДО того, как
 * хендлер успеет что-либо сделать. Для kb.write обязательно поле
 * `content`; если модель пришлёт вызов без него — должна прилететь
 * ошибка валидации, а файл не создаваться.
 *
 * Шаги:
 *   1. Запрограммировать модель: первая итерация — kb.write без `content`;
 *      вторая — финальный текст.
 *   2. Запустить smoke.
 *
 * Ожидание:
 *   - assistant-событие с tool_call kb.write — есть.
 *   - tool_result kb.write содержит error (от Ajv).
 *   - Файл по запрошенному пути в `.agents/knowledge/` НЕ создан
 *     (handler не успел отработать — валидация раньше).
 *   - Цикл штатно завершается финальным ответом.
 */

// Путь, который модель «попросила» создать. Файла по нему быть не должно.
const NOTE_PATH = 'smoke/should-not-exist.md';
const PROMPT = 'Создай smoke/should-not-exist.md (без указания текста)';

test('TC-13: kb.write без обязательного content даёт tool_result.error и файл не создаётся', async ({
  agent,
  workspacePath,
}) => {
  // 1. Сценарий: tool_call с дыркой в аргументах + финальный ответ.
  //    Поле `content` намеренно опущено — Ajv обязан отбить вход.
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('kb.write', { path: NOTE_PATH }),
      fakeFinalAnswer('Не получилось — попробую с текстом в следующий раз.')
    )
  );

  // 2. Ключ и старт smoke-цикла.
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);

  // 3. Цикл должен корректно завершиться — модель видит ошибку и
  //    отдаёт финальный текст. Smoke считает это успехом.
  await agent.waitForCompletion();

  const run = agent.lastRun();

  // 4a. Модель действительно дёргала kb.write.
  expectToolCalled(run, 'kb.write');

  // 4b. Вызов завершился ошибкой валидации — Ajv упомянет
  //     отсутствующее required-поле `content`.
  expectToolFailed(run, 'kb.write', 'content');

  // 4c. Финальный ответ есть, цикл остановился.
  expectFinalAssistantText(run);

  // 4d. Пользовательский prompt и финальный ответ — на месте.
  expectChatHasUserPrompt(run, PROMPT);
  expectChatHasAgentReply(run);

  // 4e. Главный инвариант кейса: handler НЕ запускался, файл по
  //     запрошенному пути не появился. Проверяем явно через fs:
  //     если бы handler отработал — файл бы лежал в knowledge.
  const targetFile = path.join(workspacePath, '.agents', 'knowledge', NOTE_PATH);
  expect(
    fs.existsSync(targetFile),
    'kb.write не должен был создать файл при невалидных входах'
  ).toBe(false);
});
