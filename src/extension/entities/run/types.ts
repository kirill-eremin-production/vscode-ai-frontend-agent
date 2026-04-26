/**
 * Типы предметной области «Run» (один прогон команды агентов
 * над одной задачей пользователя).
 *
 * Ран — это обёртка над одной или несколькими **сессиями**. На Phase 1
 * (#0008) сессия всегда одна (initial). После #0013 ручная компактификация
 * создаёт новую сессию из summary, старая остаётся read-only.
 *
 * Что лежит в ране vs в сессии vs в общей kb (после #0011):
 *  - run-level: `meta.json` (id, title, prompt, активная сессия, агрегаты,
 *    `briefPath` — ссылка на артефакт в kb).
 *  - session-level: `chat.jsonl`, `tools.jsonl`, `loop.json`, свой
 *    `meta.json` со статусом и usage этой сессии.
 *  - kb-level: `brief.md` и прочие продукты работы — лежат в
 *    `.agents/knowledge/<role>/...`, их потребляют другие роли.
 *
 * Зачем: подготовка к мульти-агентскому режиму (#0012) и к компактификации
 * (#0013) без последующего ломания storage. Тип SessionMeta уже несёт
 * `participants` и `kind` — обе фичи строятся поверх без миграций.
 */

/**
 * Возможные состояния рана/сессии.
 * - `draft` — создан, но цикл ещё не запускался.
 * - `running` — agent-loop активен.
 * - `awaiting_user_input` — agent-loop остановлен на `ask_user`, ждём ответа.
 * - `awaiting_human` — роль завершила свой шаг, ждёт approve пользователя.
 * - `done` — финальный успех.
 * - `failed` — фатальная ошибка цикла, продолжать нельзя.
 * - `compacted` — сессия закрыта компактификацией (#0013), её содержимое
 *   доступно read-only через табы. На уровне `RunMeta.status` это значение
 *   не используется (ран всегда отражает статус активной сессии).
 */
export type RunStatus =
  | 'draft'
  | 'running'
  | 'awaiting_user_input'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'compacted';

/**
 * Сообщение в общей ленте рана.
 *
 * `from` — строка, потому что роли расширяемы: `user`, `agent:product`,
 * `agent:system`, в будущем `agent:architect` и т.д. Enum'ом сделать —
 * требует править тип при каждой новой роли.
 */
export interface ChatMessage {
  id: string;
  from: string;
  at: string;
  text: string;
}

/**
 * Усреднённый счётчик usage, накопленный за серию assistant-ответов.
 *
 * Поля:
 *  - `inputTokens` / `outputTokens` — суммарные токены за всю историю.
 *  - `costUsd` — суммарная стоимость в USD; `null`, если хотя бы один
 *    шаг был на модели без зафиксированного тарифа (UI показывает «—»,
 *    чтобы не давать пользователю ложные ноли).
 *  - `lastTotalTokens` — totalTokens (input+output) последнего assistant-
 *    ответа. Это лучшая локальная оценка «сколько весит контекст»: при
 *    следующем шаге модель получит на вход примерно столько же.
 *  - `lastModel` — какая модель ответила последней. Нужно UI, чтобы
 *    подтянуть правильный context-limit для индикатора заполненности.
 */
export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastTotalTokens: number;
  lastModel: string | null;
}

/** Стартовое значение для свежей сессии/рана. */
export const EMPTY_USAGE: UsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastTotalTokens: 0,
  lastModel: null,
};

/**
 * Участник сессии. Сейчас комбинации: `[user, agent:product]`. После
 * #0012 появятся `[agent:product, agent:architect]` (agent-agent) и
 * `[user, agent:product, agent:architect]` (hybrid после вмешательства).
 *
 * Хранится в SessionMeta вместо одиночного «role», потому что одна
 * сессия может обслуживать сразу нескольких агентов (мост между ними).
 *
 * **Длина массива.** До #0034 участников всегда было ровно двое (пара),
 * и часть кода неявно полагалась на это. После #0034 формат — массив
 * произвольной длины ≥ 1: одна и та же сессия может стать «комнатой»
 * (#0036, #0038). Никто не должен делать `participants[0]/[1]` или
 * `length === 2` — длина проверяется явно, обход — циклом/`some`/`filter`.
 */
export type Participant = { kind: 'user' } | { kind: 'agent'; role: string };

/** Тип сессии. На Phase 1 всегда `'user-agent'`. */
export type SessionKind = 'user-agent' | 'agent-agent';

/**
 * Метаданные сессии — лежат в `sessions/<sessionId>/meta.json`.
 *
 * `status` здесь — каноническое значение для этой сессии. В RunMeta.status
 * хранится копия активной сессии — это денормализация для скорости рендера
 * списка ранов (UI не должен лезть в N session-meta ради статусов).
 *
 * `participants` всегда длины ≥ 1 после чтения через `readSessionMeta`/
 * `readMeta`: для старых файлов без массива (#0034) хранилище нормализует
 * legacy-поля (`agentRole` + `kind`) в массив длины 2 на лету, на диск
 * не переписывая. Новые сессии пишутся в новом формате сразу.
 */
export interface SessionMeta {
  id: string;
  runId: string;
  kind: SessionKind;
  participants: Participant[];
  /** Родительская сессия — заполняется только после компактификации (#0013). */
  parentSessionId?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  usage: UsageAggregate;
}

/**
 * Лёгкое описание сессии для шапки RunMeta. Достаточно для отрисовки
 * табов сессий: id, статус, времена, usage; полный SessionMeta UI
 * запрашивает уже отдельно при выборе таба.
 */
export interface SessionSummary {
  id: string;
  kind: SessionKind;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  usage: UsageAggregate;
  /**
   * Участники сессии. Зеркало `SessionMeta.participants`, дублируется
   * в summary, чтобы канвас (#0023) и шапка рана могли определить
   * роль(и) каждой сессии без чтения N session-meta файлов.
   *
   * После #0034 — обязательное поле длины ≥ 1. Для legacy meta.json без
   * массива хранилище восстанавливает участников через нормализацию при
   * `readMeta`/`readSessionMeta`, в результате чего summary всегда несёт
   * корректный массив (длиной 2 для старых ранов, произвольной — для
   * комнат после #0036).
   */
  participants: Participant[];
}

/**
 * Метаданные рана — `meta.json` в корне `runs/<id>/`.
 *
 * `activeSessionId` — id «текущей» сессии. На Phase 1 = id единственной
 * созданной при init; после #0013 — id новейшей сессии после compact.
 *
 * `sessions[]` — лёгкий список для UI-табов; полный SessionMeta живёт
 * рядом в `sessions/<sid>/meta.json`. Дублирование сознательное:
 * читать N файлов ради списка табов — слишком много I/O.
 *
 * `usage` — суммарный usage по всем сессиям. Удобно показывать в шапке
 * рана независимо от того, какая сессия сейчас выбрана в UI.
 */
export interface RunMeta {
  id: string;
  title: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  activeSessionId: string;
  sessions: SessionSummary[];
  usage: UsageAggregate;
  /**
   * Путь к финальному артефакту рана (`brief.md` для продакта),
   * относительно корня workspace. Заполняется ровно одним вызовом
   * `writeBrief` при финализации; до этого момента — undefined.
   *
   * Артефакт лежит в общей kb (`.agents/knowledge/product/briefs/...`),
   * а не в папке рана: продукт работы — общий ресурс проекта, его
   * читают будущие роли (архитектор, программист) и сам пользователь
   * как обычный файл репозитория. Полный мотив — в issue #0011.
   */
  briefPath?: string;
  /**
   * Путь к артефакту архитектора (`plan.md`), относительно корня
   * workspace. Заполняется `writePlan` при финализации архитекторской
   * роли (issue #0004). Лежит в `.agents/knowledge/architect/plans/...`
   * по той же логике, что и `briefPath`.
   */
  planPath?: string;
  /**
   * Путь к артефакту программиста (`summary.md`), относительно корня
   * workspace. Заполняется `writeSummary` при финализации программиста
   * (issue #0027). Лежит в `.agents/knowledge/programmer/summaries/...`
   * по той же логике, что `briefPath`/`planPath`. Уникальное отличие —
   * summary всегда писается тем же runId, никаких внешних апдейтов после
   * финализации не предполагается.
   */
  summaryPath?: string;
}
