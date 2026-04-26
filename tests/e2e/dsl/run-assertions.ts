import { expect } from '@playwright/test';
import type { RunArtifacts } from './run-artifacts';

/**
 * Декларативные проверки артефактов рана.
 *
 * Не оборачиваем в `expect.extend(...)`, потому что custom matchers
 * Playwright требуют returning { pass, message } и хуже отлаживаются —
 * простые функции с хорошими именами читаются так же, а stack trace
 * указывает прямо в место падения.
 */

/** В `tools.jsonl` есть assistant-событие с tool_call'ом нужного тула. */
export function expectToolCalled(run: RunArtifacts, toolName: string): void {
  const found = run.toolEvents.find(
    (event) =>
      event.kind === 'assistant' &&
      Array.isArray(event.tool_calls) &&
      event.tool_calls.some((call) => call.name === toolName)
  );
  expect(found, `Ожидали assistant-событие с tool_call ${toolName} в tools.jsonl`).toBeTruthy();
}

/** В `tools.jsonl` есть успешный tool_result для нужного тула (без error). */
export function expectToolSucceeded(run: RunArtifacts, toolName: string): void {
  const result = run.toolEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_name === toolName && !event.error
  );
  expect(result, `Ожидали успешный tool_result для ${toolName} в tools.jsonl`).toBeTruthy();
}

/** В `tools.jsonl` есть tool_result с ошибкой (для негативных кейсов). */
export function expectToolFailed(
  run: RunArtifacts,
  toolName: string,
  errorSubstring?: string
): void {
  const result = run.toolEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_name === toolName && event.error
  );
  expect(result, `Ожидали tool_result с ошибкой для ${toolName}`).toBeTruthy();
  if (errorSubstring && result?.error) {
    expect(result.error).toContain(errorSubstring);
  }
}

/**
 * Финальное assistant-событие в `tools.jsonl` — без tool_calls.
 * Это инвариант успешного завершения цикла: модель сказала «всё».
 */
export function expectFinalAssistantText(run: RunArtifacts): void {
  const events = run.toolEvents;
  const lastAssistant = events.findLast((event) => event.kind === 'assistant');
  expect(lastAssistant, 'Ожидали финальное assistant-событие в tools.jsonl').toBeTruthy();
  expect(
    lastAssistant?.tool_calls,
    'Финальный assistant НЕ должен содержать tool_calls (это означает завершение цикла)'
  ).toBeUndefined();
}

/** В `chat.jsonl` есть user-сообщение с заданным prompt'ом. */
export function expectChatHasUserPrompt(run: RunArtifacts, prompt: string): void {
  const found = run.chat.find((entry) => entry.from === 'user' && entry.text === prompt);
  expect(found, `Ожидали user-сообщение "${prompt}" в chat.jsonl`).toBeTruthy();
}

/** В `chat.jsonl` есть финальный agent-ответ (любой `from: 'agent:*'`). */
export function expectChatHasAgentReply(run: RunArtifacts): void {
  const found = run.chat.find((entry) => entry.from.startsWith('agent:'));
  expect(found, 'Ожидали хотя бы один agent-ответ в chat.jsonl').toBeTruthy();
}

/**
 * tool_calls модели НЕ дублируются в chat.jsonl (там только высокоуровневая
 * лента для пользователя). Это инвариант, который держит наш agent-loop.
 */
export function expectChatHasNoToolCalls(run: RunArtifacts): void {
  const leaks = run.chat.filter((entry) => entry.text.includes('tool_call'));
  expect(leaks, 'tool_calls не должны просачиваться в chat.jsonl').toEqual([]);
}

/**
 * В `tools.jsonl` есть system-событие с упоминанием «resume».
 *
 * Это маркер, который пишет `logResume` (см. shared/agent-loop) при
 * восстановлении цикла после перезапуска VS Code. Используется как
 * критерий «вторая сессия реально подняла существующий ран, а не
 * запустила новый» в durability-тестах.
 */
export function expectResumeMarker(run: RunArtifacts): void {
  const marker = run.toolEvents.find(
    (event) =>
      event.kind === 'system' && typeof event.message === 'string' && /resume/i.test(event.message)
  );
  expect(marker, 'Ожидали system-событие про resume в tools.jsonl').toBeTruthy();
}

/** В knowledge-песочнице лежит файл с заданным содержимым. */
export function expectKnowledgeFile(
  run: RunArtifacts,
  relativePath: string,
  expectedContent: string
): void {
  expect(run.hasKnowledgeFile(relativePath), `Ожидали файл .agents/knowledge/${relativePath}`).toBe(
    true
  );
  expect(run.knowledgeFile(relativePath)).toBe(expectedContent);
}
