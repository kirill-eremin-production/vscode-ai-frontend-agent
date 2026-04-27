import { chat, type ChatMessage, type ToolDefinitionWire } from '@ext/shared/openrouter/client';
import { recordToolEvent, broadcast } from '@ext/features/run-management/broadcast';
import { addUsageToActiveSession } from '@ext/entities/run/storage';
import { costFor } from '@ext/shared/pricing/registry';
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
  /**
   * Опциональная стартовая история для resume-режима. Если задана —
   * НЕ собираем `[system, user]` заново, а используем как есть. Это
   * нужно для возобновления цикла после перезапуска VS Code: история
   * восстанавливается из `tools.jsonl` + ответа пользователя.
   *
   * При resume в истории ДОЛЖЕН уже лежать последний `role: "tool"`
   * с ответом на pending ask_user — тогда первый запрос модели уже
   * увидит результат и сможет продолжить.
   */
  initialHistory?: ChatMessage[];
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
    }
  | {
      kind: 'paused';
      /**
       * Причина паузы — на этой итерации единственная: тул вернул
       * `{kind: 'queued'}` (см. `team.invite` / `team.escalate` из
       * #0051). Поле оставлено отдельно, чтобы вызывающий код мог
       * показать пользователю «ждём ответа от <X>», а не парсить
       * meeting-request id.
       */
      reason: string;
      /**
       * id meeting-request'а, на ответ которого ждёт инициатор. Нужен
       * resumer'у роли при пробуждении (#0051): по нему можно отличить
       * resume «после ответа на ask_user» от «после резолва встречи»
       * и собрать правильный хвост истории.
       */
      meetingRequestId: string;
      /** Сколько итераций реально потрачено до паузы. */
      iterations: number;
    };

/**
 * Маркер паузы в результате тула: если handler вернул объект формы
 * `{kind: 'queued', meetingRequestId: '...'}`, agent-loop ловит его
 * после выполнения tool_call'ов и завершает цикл `paused`-веткой.
 *
 * Контракт нарочно построен на уровне agent-loop'а, а не «специальным
 * исключением» из тула: тул должен корректно записаться в `tool_result`
 * (модель видит, что её вызов выполнился), а уже loop наблюдает форму
 * результата и принимает решение остановиться. Так пауза остаётся
 * прозрачной и для resume-трассировки в `tools.jsonl`.
 */
function extractQueuedMeetingRequestId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const candidate = result as { kind?: unknown; meetingRequestId?: unknown };
  if (candidate.kind !== 'queued' || typeof candidate.meetingRequestId !== 'string') {
    return undefined;
  }
  return candidate.meetingRequestId;
}

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
  rawArgs: string,
  runId: string,
  toolCallId: string
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
    const result = await tool.handler(validation.args, { runId, toolCallId });
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
  // В resume-режиме берём готовую историю целиком; иначе собираем
  // первые два сообщения сами.
  const history: ChatMessage[] = params.initialHistory
    ? [...params.initialHistory]
    : [
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
      await recordToolEvent(params.runId, {
        kind: 'system',
        at: new Date().toISOString(),
        message: `OpenRouter ошибка на итерации ${iteration}: ${reason}`,
      });
      return { kind: 'failed', reason, iterations: iteration - 1 };
    }

    const assistant = response.message;
    history.push(assistant);

    // Usage этого шага: рассчитываем стоимость и эмбеддим в assistant-
    // событие, чтобы UI мог показать per-step cost в ленте без отдельного
    // join'а с агрегатами. Параллельно — обновляем session/run aggregate
    // (для шапки рана, total cost и индикатора заполненности контекста).
    // Если OpenRouter не вернул usage — событие пишем без поля, агрегат
    // не трогаем; ран не ломаем (это сознательный выбор: usage — данные
    // observability, отсутствие не должно валить работу модели).
    const usagePayload = response.usage
      ? {
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          costUsd: costFor(response.model, response.usage),
        }
      : undefined;

    if (usagePayload) {
      const updated = await addUsageToActiveSession(params.runId, usagePayload);
      // Broadcast обновлённой меты сразу — UI видит новые агрегаты в той
      // же тиковой пачке, что и tool.appended ниже. Без этого индикатор
      // контекста и total cost обновлялись бы только при следующем
      // явном `runs.get` от webview.
      if (updated.run) broadcast({ type: 'runs.updated', meta: updated.run });
    }

    // Лог: одна запись на каждый assistant-ответ, со всеми tool_calls
    // и usage'ем (если был).
    await recordToolEvent(params.runId, {
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
      ...(usagePayload ? { usage: usagePayload } : {}),
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
    //
    // Если хоть один тул вернул `{kind: 'queued'}` (#0051) — фиксируем
    // первый такой meetingRequestId и ВСЁ РАВНО доводим текущий пакет
    // tool_call'ов до конца: модели нужно увидеть результаты всех её
    // вызовов в этом шаге (иначе на resume tool_call/tool_result
    // распарилось бы). А вот следующую итерацию уже не делаем — выходим
    // в `paused`-ветку.
    let pausedRequestId: string | undefined;
    for (const call of toolCalls) {
      const tool = params.tools.get(call.function.name);
      if (!tool) {
        const errorMsg = `Тул "${call.function.name}" не зарегистрирован для этой роли`;
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errorMsg }),
        });
        await recordToolEvent(params.runId, {
          kind: 'tool_result',
          at: new Date().toISOString(),
          tool_call_id: call.id,
          tool_name: call.function.name,
          error: errorMsg,
        });
        continue;
      }

      const exec = await executeToolCall(tool, call.function.arguments, params.runId, call.id);
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: exec.contentForModel,
      });
      await recordToolEvent(params.runId, {
        kind: 'tool_result',
        at: new Date().toISOString(),
        tool_call_id: call.id,
        tool_name: call.function.name,
        ...(exec.errorForLog !== undefined
          ? { error: exec.errorForLog }
          : { result: exec.resultForLog }),
      });

      // Берём id первого queued-результата и больше не перезаписываем —
      // модель в одном шаге обычно вызывает один team.invite/escalate.
      // Если по какой-то причине вызвала несколько — пробуждать будем
      // ровно одну заявку (резолвер сам разберётся с очередью).
      if (pausedRequestId === undefined && exec.errorForLog === undefined) {
        const requestId = extractQueuedMeetingRequestId(exec.resultForLog);
        if (requestId !== undefined) {
          pausedRequestId = requestId;
        }
      }
    }

    if (pausedRequestId !== undefined) {
      const reason = `meeting-request ${pausedRequestId} pending — agent-loop paused`;
      await recordToolEvent(params.runId, {
        kind: 'system',
        at: new Date().toISOString(),
        message: reason,
      });
      return {
        kind: 'paused',
        reason,
        meetingRequestId: pausedRequestId,
        iterations: iteration,
      };
    }
  }

  // Сюда попадаем, если за `maxIterations` модель так и не дала финал.
  const reason = `Превышен лимит итераций (${maxIterations})`;
  await recordToolEvent(params.runId, {
    kind: 'system',
    at: new Date().toISOString(),
    message: reason,
  });
  return { kind: 'failed', reason, iterations: maxIterations };
}
