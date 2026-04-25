/**
 * Реестр pending-вопросов от `ask_user`.
 *
 * Когда модель в активном цикле вызывает `ask_user`, его handler
 * создаёт Promise и регистрирует его resolver в этом реестре, ключ —
 * `tool_call_id`. Дальше handler ждёт `await promise`. UI получает
 * вопрос через broadcast, пользователь отвечает → wire.ts вызывает
 * `resolvePendingAsk(toolCallId, answer)` → resolver резолвит promise
 * → handler возвращает ответ → loop продолжается.
 *
 * Если процесс умер (закрытие VS Code) — promise теряется вместе с
 * памятью, но тот факт, что вопрос был задан, остаётся в `tools.jsonl`,
 * и `ResumeRun` поднимет цикл заново после ответа пользователя.
 *
 * Реестр живёт на уровне модуля — он singleton по факту: один
 * extension host = одно состояние ожидающих вопросов.
 */

interface Pending {
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, Pending>();

/**
 * Зарегистрировать ожидание ответа. Возвращает Promise, который
 * резолвится при `resolvePendingAsk` или реджектится при
 * `rejectPendingAsk` (например, при cancel'е рана).
 *
 * Если для этого `toolCallId` уже есть pending — это бага вызывающего
 * кода (модель не должна повторно использовать id), мы реджектим
 * предыдущий и заводим новый. Таскать тонкое состояние не хочется.
 */
export function registerPendingAsk(toolCallId: string): Promise<string> {
  const existing = pending.get(toolCallId);
  if (existing) {
    existing.reject(new Error('Pending ask заменён новым с тем же tool_call_id'));
    pending.delete(toolCallId);
  }
  return new Promise<string>((resolve, reject) => {
    pending.set(toolCallId, { resolve, reject });
  });
}

/**
 * Вызывается из IPC-обработчика `runs.userAnswer`. Возвращает true,
 * если pending был найден и разрезолвен — false означает «нет такой
 * pending-записи в памяти», что есть валидный сигнал для resume-логики:
 * процесс был перезапущен, цикл нужно поднять с диска.
 */
export function resolvePendingAsk(toolCallId: string, answer: string): boolean {
  const entry = pending.get(toolCallId);
  if (!entry) return false;
  entry.resolve(answer);
  pending.delete(toolCallId);
  return true;
}

/**
 * Реджектнуть pending. Используется, когда ран отменён (cancel),
 * и нужно сломать ожидание handler'а с понятной ошибкой, чтобы
 * loop корректно завершился `failed`-веткой.
 */
export function rejectPendingAsk(toolCallId: string, reason: string): boolean {
  const entry = pending.get(toolCallId);
  if (!entry) return false;
  entry.reject(new Error(reason));
  pending.delete(toolCallId);
  return true;
}

/** Только для отладки/тестов: проверить, есть ли активный pending. */
export function hasPendingAsk(toolCallId: string): boolean {
  return pending.has(toolCallId);
}
