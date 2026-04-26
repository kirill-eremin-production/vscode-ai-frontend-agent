/**
 * DSL для построения сценариев fake-OpenRouter.
 *
 * Контракт сценария (см. tests/e2e/test-extension/extension.js):
 * `{ responses: FakeResponse[] }`. Тут просто декларативные конструкторы,
 * чтобы тест не писал руками `choices: [{ message: { role: 'assistant', ... } }]`.
 */

/** Один tool_call в формате OpenRouter. */
export interface FakeToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Один ответ модели в сценарии. */
export interface FakeResponse {
  model?: string;
  choices: Array<{
    message: { role: 'assistant'; content: string | null; tool_calls?: FakeToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface FakeScenario {
  responses: FakeResponse[];
}

/**
 * Ответ модели — assistant просит вызвать тулы и сразу останавливается.
 *
 * Для удобства принимает массив пар `[name, args]`: модель может
 * запросить несколько тулов в одной итерации, и наш agent-loop их
 * исполняет по очереди.
 */
export function fakeToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>
): FakeResponse {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call, index) => ({
            id: call.id ?? `call_${index + 1}`,
            type: 'function',
            function: {
              name: call.name,
              // arguments в OpenRouter — JSON-строка, не объект.
              arguments: JSON.stringify(call.args),
            },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

/** Сахарок: один tool_call вместо массива из одного. */
export function fakeToolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string
): FakeResponse {
  return fakeToolCalls([{ name, args, id }]);
}

/**
 * Финальный assistant-ответ — обычный текст, без tool_calls.
 * Этот ответ говорит agent-loop'у «всё, цикл завершён».
 */
export function fakeFinalAnswer(text: string): FakeResponse {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
  };
}

/** Собрать готовый сценарий из последовательности ответов. */
export function scenario(...responses: FakeResponse[]): FakeScenario {
  return { responses };
}
