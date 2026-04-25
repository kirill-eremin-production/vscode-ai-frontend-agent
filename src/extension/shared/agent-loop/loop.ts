import { chat, type ChatMessage, type ToolDefinitionWire } from '@ext/shared/openrouter/client';
import { appendToolEvent } from '@ext/entities/run/storage';
import { validateToolArgs } from './validator';
import type { ToolDefinition, ToolRegistry } from './types';

/**
 * Цикл «модель → tool-call → выполнение → tool-result → модель».
 *
 * Что делает (и чего не делает):
 *  - Подаёт модели system + user + (tool_results) → получает assistant.
 *  - Если assistant.tool_calls пустой / finish_reason='stop' → возвращает финальный ответ.
 *  - Если есть tool_calls → валидирует входы, вызывает handler'ы, формирует
 *    `role: "tool"` сообщения, кладёт их в историю, идёт на следующую итерацию.
 *  - Каждый шаг (assistant message, tool result) записывается в `tools.jsonl`.
 *  - Лимит итераций — жёсткая защита от зацикливания. При превышении —
 *    `failed`-возврат с понятной причиной (ничего не throw'ится — agent-loop
 *    не должен валить вызывающий сервисный слой случайным исключением).
 *
 * Чего НЕ делает:
 *  - Не управляет статусом рана — это дело сервисного слоя, который
 *    знает про FSM `RunMeta`. Loop возвращает результат, сервис трактует.
 *  - Не дублирует ничего в `chat.jsonl`. Дублирование «человекочитаемых»
 *    сообщений — ответственность роли, которая знает, что показывать
 *    пользователю (например, финальный assistant.content или ask_user).
 */

/** Жёсткий лимит итераций — чтобы случайный цикл не уехал в бесконечность. */
const DEFAULT_MAX_ITERATIONS = 20;

/** Параметры запуска цикла. */
export interface AgentLoopParams {
  /** runId — нужен для записи в `.agents/runs/<runId>/tools.jsonl`. */
  runId: string;
  /** Ключ OpenRouter, уже прочитанный из SecretStorage. */
  apiKey: string;
  /** Имя модели (slug OpenRouter). */
  model: string;
  /** Полный system prompt роли. */
  systemPrompt: string;
  /** Начальное user-message — обычно prompt пользователя (или brief.md и т.п.). */
  userMessage: string;
  /** Реестр доступных тулов для этой роли. */
  tools: ToolRegistry;
  /** Опционально — переопределить лимит итераций. */
  maxIterations?: number;
  /** Опционально — температура. */
  temperature?: number;
}

/** Результат работы цикла. Дискриминированный union по `kind`. */
export type AgentLoopResult =
  | {
      kind: 'completed';
      /** Финальный текст ответа модели (assistant без tool_calls). */
      finalContent: string;
      /** Сколько итераций реально потрачено. */
      iterations: number;
    }
  | {
      kind: 'failed';
      /** Человекочитаемая причина — для chat.jsonl и UI. */
      reason: string;
      /** Сколько итераций успело пройти до фейла. */
      iterations: number;
    };

/**
 * Преобразовать реестр в формат `tools[]` для OpenRouter-запроса.
 * Делается один раз перед циклом — список тулов не меняется по ходу.
 */
function buildToolsWire(registry: ToolRegistry): ToolDefinitionWire[] {
  const wire: ToolDefinitionWire[] = [];
  for (const tool of registry.values()) {
    wire.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    });
  }
  return wire;
}

/**
 * Выполнить один tool-call: валидировать аргументы, вызвать handler,
 * упаковать результат в строку для `role: "tool"` сообщения.
 *
 * Возвращает контентную строку (JSON) — её и кладём в сообщение,
 * и в tool_result-событие лога. Дублирование намеренное: модели
 * нужен JSON-text, нам в логе — структурированный объект (в `result`
 * или `error` поле события).
 */
async function executeToolCall(
  tool: ToolDefinition,
  rawArgs: string
): Promise<{ contentForModel: string; resultForLog: unknown; errorForLog?: string }> {
  const validation = validateToolArgs(tool, rawArgs);
  if (!validation.ok) {
    return {
      contentForModel: JSON.stringify({ error: validation.error }),
      resultForLog: undefined,
      errorForLog: validation.error,
    };
  }

  try {
    const result = await tool.handler(validation.args);
    return {
      contentForModel: JSON.stringify({ result }),
      resultForLog: result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      contentForModel: JSON.stringify({ error: message }),
      resultForLog: undefined,
      errorForLog: message,
    };
  }
}

/**
 * Главная функция модуля: крутит цикл до финального ответа модели
 * либо до ошибки/лимита.
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolsWire = buildToolsWire(params.tools);

  // История сообщений, которую растим по ходу цикла. Формат — ровно тот,
  // который OpenRouter ожидает в `messages`, никаких внутренних типов.
  const history: ChatMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userMessage },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let response;
    try {
      response = await chat(params.apiKey, {
        model: params.model,
        messages: history,
        tools: toolsWire,
        temperature: params.temperature,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      await appendToolEvent(params.runId, {
        kind: 'system',
        at: new Date().toISOString(),
        message: `OpenRouter ошибка на итерации ${iteration}: ${reason}`,
      });
      return { kind: 'failed', reason, iterations: iteration - 1 };
    }

    const assistant = response.message;
    history.push(assistant);

    // Лог: одна запись на каждый assistant-ответ, со всеми tool_calls.
    await appendToolEvent(params.runId, {
      kind: 'assistant',
      at: new Date().toISOString(),
      content: assistant.content,
      ...(assistant.tool_calls
        ? {
            tool_calls: assistant.tool_calls.map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: c.function.arguments,
            })),
          }
        : {}),
    });

    const toolCalls = assistant.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Финал: модель ответила текстом без вызовов. content гарантированно
      // не пустой — это проверено внутри chat() (там бросается ошибка
      // на полностью пустой ответ).
      return {
        kind: 'completed',
        finalContent: assistant.content ?? '',
        iterations: iteration,
      };
    }

    // Выполняем каждый tool_call по очереди. Параллелизм пока не делаем —
    // это упрощает отладку и ничего не ломает (большинство наших тулов
    // дешёвые и быстрые). Параллелизм добавим, если станет узким местом.
    for (const call of toolCalls) {
      const tool = params.tools.get(call.function.name);
      if (!tool) {
        const errorMsg = `Тул "${call.function.name}" не зарегистрирован для этой роли`;
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errorMsg }),
        });
        await appendToolEvent(params.runId, {
          kind: 'tool_result',
          at: new Date().toISOString(),
          tool_call_id: call.id,
          tool_name: call.function.name,
          error: errorMsg,
        });
        continue;
      }

      const exec = await executeToolCall(tool, call.function.arguments);
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: exec.contentForModel,
      });
      await appendToolEvent(params.runId, {
        kind: 'tool_result',
        at: new Date().toISOString(),
        tool_call_id: call.id,
        tool_name: call.function.name,
        ...(exec.errorForLog !== undefined
          ? { error: exec.errorForLog }
          : { result: exec.resultForLog }),
      });
    }
  }

  // Сюда попадаем, если за `maxIterations` модель так и не дала финал.
  const reason = `Превышен лимит итераций (${maxIterations})`;
  await appendToolEvent(params.runId, {
    kind: 'system',
    at: new Date().toISOString(),
    message: reason,
  });
  return { kind: 'failed', reason, iterations: maxIterations };
}
