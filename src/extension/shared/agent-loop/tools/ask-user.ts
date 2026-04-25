import { updateRunStatus } from '@ext/entities/run/storage';
import { broadcast } from '@ext/features/run-management/broadcast';
import { registerPendingAsk } from '../pending-asks';
import type { ToolDefinition } from '../types';

/**
 * Тул `ask_user` — единственная «асимметричная» вещь в реестре:
 * его handler возвращает Promise, который резолвится **извне** —
 * через IPC от webview, а не локально внутри handler'а.
 *
 * Что происходит при вызове:
 *  1) Меняем статус рана на `awaiting_user_input` (и broadcast'им
 *     `runs.updated`, чтобы webview увидел смену статуса).
 *  2) Broadcast'им `runs.askUser` с вопросом — webview получает,
 *     отрисовывает форму ответа в карточке.
 *  3) Регистрируем Promise в `pending-asks` registry под ключом
 *     `tool_call_id` и await'им его.
 *  4) Когда пользователь отправляет ответ через `runs.userAnswer`,
 *     wire.ts вызывает `resolvePendingAsk(toolCallId, answer)` —
 *     promise резолвится, handler возвращает `{ answer }`.
 *  5) Возвращаем статус в `running` (loop продолжается).
 *
 * Если процесс умер посреди ожидания — promise теряется, но запись
 * в `tools.jsonl` (assistant с tool_call ask_user, без tool_result)
 * остаётся. После перезапуска VS Code resume-логика поднимет цикл
 * заново на основе loop.json + tools.jsonl + ответа пользователя.
 */
export const askUserTool: ToolDefinition<{ question: string; context?: string }> = {
  name: 'ask_user',
  description:
    'Задать пользователю уточняющий вопрос и дождаться ответа. ' +
    'Вызывай только когда без ответа невозможно сформулировать корректный артефакт. ' +
    'Возвращает { answer: string } — ответ пользователя.',
  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: 1,
        description: 'Текст вопроса. Конкретный, без воды; одна мысль на вопрос.',
      },
      context: {
        type: 'string',
        description: 'Опциональный контекст: что уже известно, какие варианты рассматривал.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  handler: async ({ question, context }, { runId, toolCallId }) => {
    // 1) Статус → awaiting_user_input. Делается до broadcast askUser,
    // чтобы UI получил оба события в правильном порядке.
    const updatedMeta = await updateRunStatus(runId, 'awaiting_user_input');
    if (updatedMeta) {
      broadcast({ type: 'runs.updated', meta: updatedMeta });
    }

    // 2) Сообщаем webview про вопрос. `at` берём текущий — для
    // resume-кейса findPendingAsk перезапишет его временем из лога.
    broadcast({
      type: 'runs.askUser',
      runId,
      ask: {
        toolCallId,
        question,
        context,
        at: new Date().toISOString(),
      },
    });

    // 3) Ждём ответ. Может блокироваться сколь угодно долго — это
    // ожидаемо. Если пользователь так и не ответит, а VS Code не
    // закроется, мы будем висеть тут до конца сессии (это допустимо).
    const answer = await registerPendingAsk(toolCallId);

    // 5) Возвращаем статус в running, чтобы UI показал «работает дальше».
    const resumedMeta = await updateRunStatus(runId, 'running');
    if (resumedMeta) {
      broadcast({ type: 'runs.updated', meta: resumedMeta });
    }

    return { answer };
  },
};
