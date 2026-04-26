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
 * Заголовок system-блока «контекст до твоего прихода» (#0040). Пишется
 * один раз в начале блока, далее идёт сериализованная история событий,
 * случившихся до момента `participant_joined` для данной роли.
 */
const PRE_JOIN_CONTEXT_HEADING =
  'Контекст до твоего прихода (история чата сессии до момента, когда тебя пригласили):';

/**
 * System-маркер, который модели объясняет, что выше — история «до тебя»,
 * а ниже — реплики, на которые ей надо отвечать как полноправному
 * участнику. Формулировка из issue #0040 — на русском, прямо и коротко,
 * чтобы не смешивалось с системным промптом роли.
 */
const PARTICIPANT_JOIN_MARKER =
  'Тебя только что добавили в эту сессию. Выше — история чата до твоего прихода. Отвечай по последнему сообщению.';

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
 *  2) Если в журнале есть `participant_joined` для `config.role` (#0040 —
 *     роль была добавлена в комнату по ходу сессии через `pullIntoRoom`),
 *     режем события по timestamp'у: «до тебя» → один system-блок с
 *     текстовым дампом, далее system-маркер, далее «c момента входа» —
 *     обычной чередой ChatMessage'ей. Если события `participant_joined`
 *     для роли нет (роль была участником с создания сессии) — события
 *     идут одной общей историей без блока и маркера.
 *  3) Внутри одной из секций (или общей истории) идём по событиям:
 *     - `assistant` → `role: "assistant"` с tool_calls.
 *     - `tool_result` → `role: "tool"` с tool_call_id и content
 *       (поле `result` или `error` упаковываем в JSON-строку).
 *     - `participant_joined` → короткое system-сообщение «в сессию
 *       вошла роль X» (видно роли как событие комнаты; для своей же
 *       роли событие отображается так же — оно дублирует маркер,
 *       но это безвредно, а UI/журнал встреч полагается на одну и
 *       ту же запись из `tools.jsonl`).
 *     - `system` → пропускаем (диагностика для людей, не для модели).
 *  4) В конец добавляем хвост по `intent`.
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

  const joinedAt = findParticipantJoinedAt(events, config.role);
  if (joinedAt !== undefined) {
    // Используем строгое неравенство: события с at < joinedAt — это
    // прошлое, всё с at >= joinedAt — настоящее с момента входа роли.
    // Сама запись `participant_joined` имеет at === joinedAt, поэтому
    // попадает в post-секцию (как реальная пометка о моменте входа).
    const preEvents = events.filter((event) => event.at < joinedAt);
    const postEvents = events.filter((event) => event.at >= joinedAt);

    const preBlock = renderPreJoinBlock(preEvents);
    if (preBlock !== undefined) {
      history.push({ role: 'system', content: preBlock });
    }
    history.push({ role: 'system', content: PARTICIPANT_JOIN_MARKER });

    for (const event of postEvents) {
      appendEventAsMessage(history, event);
    }
  } else {
    for (const event of events) {
      appendEventAsMessage(history, event);
    }
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
 * Найти момент входа роли в сессию (#0040). Возвращает `at` первой
 * записи `participant_joined` с этой ролью или `undefined`, если такой
 * записи нет (роль была среди `participants` с создания сессии).
 *
 * Идём с начала: `pullIntoRoom` (#0036) гарантирует идемпотентность —
 * повторных записей `participant_joined` для одной роли быть не должно.
 * Но даже если по какой-то причине запись окажется задвоена, нам нужен
 * первый момент, чтобы корректно сформировать «контекст до твоего
 * прихода».
 */
function findParticipantJoinedAt(events: ToolEvent[], role: string): string | undefined {
  for (const event of events) {
    if (event.kind === 'participant_joined' && event.role === role) {
      return event.at;
    }
  }
  return undefined;
}

/**
 * Собрать system-блок «контекст до твоего прихода» (#0040): заголовок +
 * текстовое представление каждого события. Возвращает `undefined`, если
 * рисовать нечего (например, до момента входа в сессии были только
 * `system`-записи, не релевантные модели) — в этом случае пустой блок
 * вообще не добавляем в историю, оставляя только маркер.
 *
 * Зачем текстом, а не настоящими ChatMessage'ями: с точки зрения роли
 * это не её диалог, а «справка для понимания контекста». Если бы мы
 * подавали prior assistant/tool как `role: assistant`/`role: tool`,
 * модель могла бы решить, что это её собственные шаги, и продолжать
 * стиль/форму. Более того, OpenRouter требует строгого соответствия
 * `tool_call` ↔ `tool` (id), а здесь pre-калы относятся к чужой ленте,
 * и формальная привязка id'шек могла бы развалиться.
 */
function renderPreJoinBlock(preEvents: ToolEvent[]): string | undefined {
  const lines: string[] = [];
  for (const event of preEvents) {
    const line = renderEventAsTextLine(event);
    if (line !== undefined) lines.push(line);
  }
  if (lines.length === 0) return undefined;
  return [PRE_JOIN_CONTEXT_HEADING, '', ...lines].join('\n');
}

/**
 * Текстовое представление одного события для system-блока (#0040).
 *
 * `system`-события (диагностика людям) пропускаем — модели они только
 * сбивают сигнал. Остальные оборачиваем в короткие пометки в скобках,
 * чтобы блок легко читался и моделью, и человеком при разборе дампа
 * сессии.
 */
function renderEventAsTextLine(event: ToolEvent): string | undefined {
  if (event.kind === 'assistant') {
    const parts: string[] = [];
    if (event.content !== null && event.content.length > 0) {
      parts.push(`[ассистент]: ${event.content}`);
    }
    if (event.tool_calls && event.tool_calls.length > 0) {
      for (const call of event.tool_calls) {
        parts.push(`[ассистент → ${call.name}(${call.arguments})]`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (event.kind === 'tool_result') {
    const payload = event.error !== undefined ? { error: event.error } : { result: event.result };
    return `[результат ${event.tool_name} #${event.tool_call_id}]: ${JSON.stringify(payload)}`;
  }
  if (event.kind === 'participant_joined') {
    return `[в сессию вошла роль: ${event.role}]`;
  }
  return undefined;
}

/**
 * Добавить событие в историю как полноценное ChatMessage (общий путь
 * без слайсинга и пост-секция при слайсинге).
 *
 * `participant_joined` рендерим как короткое `system`-сообщение: модели
 * полезно знать, что состав комнаты менялся (для product, который был
 * с создания, эта запись — единственный источник информации о том,
 * что к нему пришёл программист). Своё собственное событие входа
 * пишется так же — это безвредное дублирование маркера, упрощающее
 * единообразную обработку post-событий.
 */
function appendEventAsMessage(history: ChatMessage[], event: ToolEvent): void {
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
    return;
  }
  if (event.kind === 'tool_result') {
    const payload = event.error !== undefined ? { error: event.error } : { result: event.result };
    history.push({
      role: 'tool',
      tool_call_id: event.tool_call_id,
      content: JSON.stringify(payload),
    });
    return;
  }
  if (event.kind === 'participant_joined') {
    history.push({
      role: 'system',
      content: `В сессию вошла роль: ${event.role}.`,
    });
    return;
  }
  // 'system' — диагностика для людей, в историю модели не уходит.
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
