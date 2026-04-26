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
 * TC-12. Tool-loop: sandbox-нарушение в kb.read.
 *
 * Проверяем, что попытка модели прочитать файл за пределами
 * `.agents/knowledge/` (типичный path-traversal через `..`) перехватывается
 * sandbox-проверкой в `resolveKnowledgePath` и НЕ доходит до диска.
 *
 * Шаги:
 *   1. Запрограммировать модель так, чтобы она:
 *      - сперва вызвала kb.read с путём `../../../etc/passwd`,
 *      - получив ошибку, ответила финальным текстом и остановилась.
 *   2. Запустить smoke-команду.
 *
 * Ожидание:
 *   - В `tools.jsonl` есть assistant-событие с tool_call kb.read.
 *   - В `tools.jsonl` есть tool_result для kb.read с error, в тексте
 *     ошибки фигурирует слово «sandbox».
 *   - Файл за пределами knowledge-песочницы (`/etc/passwd`) НЕ создан
 *     в knowledge-папке (мы не можем гарантировать, что он не прочитан
 *     системой, но можем — что не записан как «прочитанный артефакт»).
 *   - Цикл штатно завершается финальным ответом.
 */

// Путь, который явно вылазит за knowledge-песочницу. Любой `..` после
// resolveKnowledgePath даст ошибку, но `/etc/passwd` — классика
// path-traversal, читать его агенту точно нечего.
const BAD_PATH = '../../../etc/passwd';

const PROMPT = 'Прочитай содержимое корневого /etc/passwd через kb.read';

test('TC-12: kb.read с путём за sandbox даёт tool_result.error и не падает', async ({
  agent,
  workspacePath,
}) => {
  // 1. Сценарий: первая итерация — модель просит kb.read за пределы;
  //    вторая — финальный ответ, чтобы цикл корректно остановился.
  agent.openRouter.respondWith(
    scenario(
      fakeToolCall('kb.read', { path: BAD_PATH }),
      fakeFinalAnswer('Не могу прочитать этот путь — sandbox запрещает.')
    )
  );

  // 2. Кладём ключ и запускаем smoke-цикл с провокационным prompt'ом.
  await agent.setApiKey();
  await agent.runSmoke(PROMPT);

  // 3. Цикл должен завершиться штатно: модель прочитала ошибку и
  //    отдала финальный текст. Smoke считает это успехом.
  await agent.waitForCompletion();

  const run = agent.lastRun();

  // 4a. Модель действительно попросила вызвать kb.read.
  expectToolCalled(run, 'kb.read');

  // 4b. И этот вызов завершился ошибкой sandbox — резолвер пути
  //     отверг попытку выйти за `.agents/knowledge/`.
  expectToolFailed(run, 'kb.read', 'sandbox');

  // 4c. Финальный assistant без tool_calls — цикл реально остановился.
  expectFinalAssistantText(run);

  // 4d. В chat.jsonl сохранён исходный prompt пользователя.
  expectChatHasUserPrompt(run, PROMPT);

  // 4e. И финальный ответ агента тоже в чате.
  expectChatHasAgentReply(run);

  // 4f. В knowledge-песочнице ничего не появилось — sandbox не пустил
  //     никаких сайд-эффектов. Папка либо отсутствует, либо пустая.
  const knowledgeRoot = path.join(workspacePath, '.agents', 'knowledge');
  if (fs.existsSync(knowledgeRoot)) {
    const entries = fs.readdirSync(knowledgeRoot);
    expect(entries, 'knowledge-папка не должна содержать артефактов').toEqual([]);
  }
});
