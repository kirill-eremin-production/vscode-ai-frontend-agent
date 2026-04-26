import {
  readLoopConfig,
  readToolEvents,
  type ToolEvent,
  type LoopConfig,
} from '@ext/entities/run/storage';
import { recordToolEvent } from '@ext/features/run-management/broadcast';
import type { ChatMessage } from '@ext/shared/openrouter/client';

/**
 * Намерение пользователя, с которым возобновляется ран. Живёт здесь
 * (а не в `entities/run/resume-registry`), чтобы избежать циклической
 * зависимости: `resume.ts` ⇄ `resume-registry.ts` через type-import,
 * а реестр и роли импортируют этот тип отсюда.
 *
 * Дискриминированный union, потому что для двух кейсов нужны разные
 * данные: для ответа на ask_user — `pendingToolCallId` (привязка
 * `role: tool` к конкретному вызову), для continue — просто текст,
 * который пойдёт в историю как `role: user`.
 */
export type ResumeIntent =
  | {
      kind: 'answer';
      /** id pending tool_call ask_user, на который пришёл ответ. */
      pendingToolCallId: string;
      /** Ответ пользователя — текст из IPC `runs.user.message`. */
      userAnswer: string;
    }
  | {
      kind: 'continue';
      /** Новое сообщение пользователя для продолжения диалога. */
      userMessage: string;
    };

/**
 * Воссоздание состояния цикла из персистентных артефактов
 * (`loop.json` + `tools.jsonl`) для возобновления после перезапуска
 * VS Code либо после нового сообщения пользователя в `awaiting_human`.
 *
 * Зачем: agent-loop живёт в памяти extension host'а, а пользователь
 * может ждать сколько угодно (pending `ask_user` или просто пауза
 * между ответом и доработкой). Если за это время процесс выгрузился
 * (или цикл уже штатно завершился), мы должны восстановить историю
 * сообщений в формате OpenRouter и продолжить — но уже с новым входом
 * пользователя.
 */

/**
 * Восстановить ChatMessage[] для следующего запроса в OpenRouter,
 * подмешав новый ввод пользователя в зависимости от `intent`:
 *  - `answer` — добавляем `role: "tool"` с ответом, привязанный к
 *    pending tool_call (классический ответ на ask_user).
 *  - `continue` — добавляем `role: "user"` с новым сообщением,
 *    которое модель увидит как продолжение диалога после своего
 *    финального ответа.
 *
 * Алгоритм:
 *  1) Кладём system + user (из loop.json) — это «стартовый базис»,
 *     который мы при первом запуске собирали в `runAgentLoop`.
 *  2) Идём по `tools.jsonl` событиям:
 *     - `assistant` → добавляем `role: "assistant"` с tool_calls.
 *     - `tool_result` → добавляем `role: "tool"` с tool_call_id и content
 *       (поле `result` или `error` упаковываем в JSON-строку).
 *     - `system` → пропускаем (это диагностика, модели не нужна).
 *  3) В конец добавляем хвост по `intent`.
 *
 * После этого передаём массив в `runAgentLoop` через `initialHistory` —
 * первый запрос уже включает свежий вход пользователя, цикл продолжается
 * естественно.
 */
export function reconstructHistory(
  config: LoopConfig,
  events: ToolEvent[],
  intent: ResumeIntent
): ChatMessage[] {
  const history: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.userMessage },
  ];

  for (const event of events) {
    if (event.kind === 'assistant') {
      history.push({
        role: 'assistant',
        content: event.content,
        ...(event.tool_calls && event.tool_calls.length > 0
          ? {
              tool_calls: event.tool_calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
    } else if (event.kind === 'tool_result') {
      const payload = event.error !== undefined ? { error: event.error } : { result: event.result };
      history.push({
        role: 'tool',
        tool_call_id: event.tool_call_id,
        content: JSON.stringify(payload),
      });
    }
    // 'system' события не идут в историю — они только в логе для людей.
  }

  if (intent.kind === 'answer') {
    // Хвост: ответ пользователя на pending ask_user в формате `role: tool`
    // (этого ждёт модель: tool_call → tool_result с тем же id).
    history.push({
      role: 'tool',
      tool_call_id: intent.pendingToolCallId,
      content: JSON.stringify({ result: { answer: intent.userAnswer } }),
    });
  } else {
    // Хвост: новое сообщение пользователя в `awaiting_human`/`failed`.
    // Модель видит его ровно как дополнительную user-реплику после своего
    // финального assistant-ответа — и продолжает диалог естественно.
    history.push({
      role: 'user',
      content: intent.userMessage,
    });
  }

  return history;
}

/**
 * Запись о том, что цикл возобновлён — для удобства разбора лога
 * человеком (видно в `tools.jsonl`, что между предыдущим ask_user'ом
 * и следующей assistant-репликой был перезапуск VS Code или новое
 * сообщение пользователя).
 *
 * Пишет через `recordToolEvent`, поэтому событие сразу broadcast'ится
 * в webview — пользователь видит «Resume after VS Code restart …» в
 * ленте, а не только при следующем перечитывании `runs.get`.
 */
export async function logResume(runId: string, marker: string): Promise<void> {
  await recordToolEvent(runId, {
    kind: 'system',
    at: new Date().toISOString(),
    message: marker,
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
