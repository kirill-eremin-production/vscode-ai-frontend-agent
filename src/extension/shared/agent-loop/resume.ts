import {
  appendToolEvent,
  readLoopConfig,
  readToolEvents,
  type ToolEvent,
  type LoopConfig,
} from '@ext/entities/run/storage';
import type { ChatMessage } from '@ext/shared/openrouter/client';

/**
 * Воссоздание состояния цикла из персистентных артефактов
 * (`loop.json` + `tools.jsonl`) для возобновления после перезапуска
 * VS Code.
 *
 * Зачем: agent-loop живёт в памяти extension host'а, а pending
 * `ask_user` может ждать ответа пользователя сколько угодно. Если за
 * это время процесс выгрузился, при следующем старте мы должны
 * восстановить историю сообщений в формате OpenRouter и продолжить
 * цикл с момента, где остановились — но уже с ответом пользователя.
 */

/**
 * Восстановить ChatMessage[] для следующего запроса в OpenRouter,
 * подмешав свежий ответ пользователя как `role: "tool"` к ожидающему
 * tool_call'у.
 *
 * Алгоритм:
 *  1) Кладём system + user (из loop.json) — это «стартовый базис»,
 *     который мы при первом запуске собирали в `runAgentLoop`.
 *  2) Идём по `tools.jsonl` событиям:
 *     - `assistant` → добавляем `role: "assistant"` с tool_calls.
 *     - `tool_result` → добавляем `role: "tool"` с tool_call_id и content
 *       (поле `result` или `error` упаковываем в JSON-строку).
 *     - `system` → пропускаем (это диагностика, модели не нужна).
 *  3) В конец добавляем новый `role: "tool"` с ответом пользователя
 *     (`{ answer }` в content), привязанный к `pendingToolCallId`.
 *
 * После этого передаём массив в `runAgentLoop` через `initialHistory` —
 * первый запрос уже включает ответ, цикл продолжается естественно.
 */
export function reconstructHistory(
  config: LoopConfig,
  events: ToolEvent[],
  pendingToolCallId: string,
  userAnswer: string
): ChatMessage[] {
  const history: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.userMessage },
  ];

  for (const ev of events) {
    if (ev.kind === 'assistant') {
      history.push({
        role: 'assistant',
        content: ev.content,
        ...(ev.tool_calls && ev.tool_calls.length > 0
          ? {
              tool_calls: ev.tool_calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      });
    } else if (ev.kind === 'tool_result') {
      const payload = ev.error !== undefined ? { error: ev.error } : { result: ev.result };
      history.push({
        role: 'tool',
        tool_call_id: ev.tool_call_id,
        content: JSON.stringify(payload),
      });
    }
    // 'system' события не идут в историю — они только в логе для людей.
  }

  // Хвост: ответ пользователя на pending ask_user.
  history.push({
    role: 'tool',
    tool_call_id: pendingToolCallId,
    content: JSON.stringify({ result: { answer: userAnswer } }),
  });

  return history;
}

/**
 * Запись о том, что цикл возобновлён — для удобства разбора лога
 * человеком (видно в `tools.jsonl`, что между предыдущим ask_user'ом
 * и следующей assistant-репликой был перезапуск VS Code).
 */
export async function logResume(runId: string, pendingToolCallId: string): Promise<void> {
  await appendToolEvent(runId, {
    kind: 'system',
    at: new Date().toISOString(),
    message: `Resume after VS Code restart, answering tool_call ${pendingToolCallId}`,
  });
}

/**
 * Прочитать всё, что нужно для resume рана. Возвращает undefined, если
 * чего-то не хватает (нет loop.json, нет tools.jsonl) — вызывающий код
 * должен трактовать это как «возобновление невозможно, помечаем рана
 * failed».
 */
export async function loadResumeContext(runId: string): Promise<
  | {
      config: LoopConfig;
      events: ToolEvent[];
    }
  | undefined
> {
  const config = await readLoopConfig(runId);
  if (!config) return undefined;
  const events = await readToolEvents(runId);
  if (events.length === 0) return undefined;
  return { config, events };
}
