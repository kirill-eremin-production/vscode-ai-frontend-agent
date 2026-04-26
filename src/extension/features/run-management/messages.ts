import type { ChatMessage, RunMeta } from '@ext/entities/run/types';
import type { PendingAsk, ToolEvent } from '@ext/entities/run/storage';

/**
 * Контракт сообщений между webview и extension host для работы с ранами.
 *
 * Решено держать всё в виде union-ов с обязательным полем `type`:
 *  - дискриминируемые юнионы — родной для TypeScript способ описывать
 *    «протокол», без необходимости тащить runtime-валидаторы;
 *  - один общий тип сразу для обеих сторон гарантирует, что webview
 *    и extension не разъедутся в форматах сообщений.
 *
 * Стиль `runs.<verb>` для имён выбран намеренно: позволяет в будущем
 * добавить, например, `roles.list` и `tools.run` без коллизии имён.
 */

/* ── Webview → Extension ─────────────────────────────────────────── */

/** Создать новый ран по тексту запроса пользователя. */
export interface RunsCreateRequest {
  type: 'runs.create';
  prompt: string;
}

/** Запросить актуальный список всех ранов (отрисовка сайдбара). */
export interface RunsListRequest {
  type: 'runs.list';
}

/** Запросить полные детали одного рана (открытие карточки). */
export interface RunsGetRequest {
  type: 'runs.get';
  id: string;
  /**
   * Какую сессию читать. По умолчанию (undefined) — активную из RunMeta.
   * UI передаёт явный id при клике по табу неактивной сессии (#0012):
   * пользователь хочет посмотреть её историю, не переключая активную.
   */
  sessionId?: string;
}

/** Открыть input box и сохранить ключ OpenRouter в SecretStorage. */
export interface RunsSetApiKeyRequest {
  type: 'runs.setApiKey';
}

/**
 * Сообщение пользователя в чат рана. Единая точка входа: webview шлёт
 * сюда и ответ на pending `ask_user`, и продолжение диалога после
 * `awaiting_human`/`failed`.
 *
 * Маршрутизация — на стороне extension (см. wire.ts):
 *  - `awaiting_user_input` → ответ на текущий ask_user (резолвим pending
 *    in-memory; если процесс перезапускался — поднимаем resumer с
 *    intent='answer').
 *  - `awaiting_human` / `failed` → новая итерация цикла: пишем сообщение
 *    в `chat.jsonl` и поднимаем resumer с intent='continue'.
 *  - `running` / `draft` → отбрасываем (UI должен дизейблить кнопку,
 *    но extension защищается на случай гонок).
 *
 * `askId` намеренно не передаём: он живёт только в `tools.jsonl`, и
 * извлечение делает extension через `findPendingAsk`. Это убирает
 * целый класс багов «UI прислал устаревший askId».
 */
export interface RunsUserMessageRequest {
  type: 'runs.user.message';
  runId: string;
  text: string;
  /**
   * Сигнал «достаточно вопросов, оформляй» (US-13). Кнопка в UI шлёт
   * `finalize: true` вместо обычного ответа на pending `ask_user`.
   *
   * На стороне extension это разворачивается так:
   *  - в chat.jsonl пишется короткое user-сообщение (видимый след
   *    действия пользователя, см. PRODUCT_FINALIZE_USER_TEXT);
   *  - в pending `ask_user` подкладывается дословный маркер
   *    `PRODUCT_FINALIZE_MARKER` как tool_result — модель распознаёт
   *    его по системному промпту и финализирует brief, фиксируя
   *    оставшиеся допущения в `decisions/...md` с frontmatter
   *    `assumption: true, confirmed_by_user: false`.
   *
   * Допустимо только в `awaiting_user_input`. Поле `text` при finalize
   * игнорируется — кнопка одна, текст известен заранее.
   */
  finalize?: boolean;
}

/**
 * Открыть файл в редакторе VS Code новой вкладкой. Используется при
 * клике по ссылке в карточке рана (например, на путь, созданный
 * `kb.write`).
 *
 * Путь — относительный от workspace root. Extension резолвит абсолютный
 * через `vscode.workspace.workspaceFolders[0].uri.fsPath`. Передавать
 * абсолютные пути из webview сознательно не разрешаем — это лишняя
 * поверхность атаки и источник кросс-платформенных багов (web ⇄ desktop).
 */
export interface EditorOpenRequest {
  type: 'editor.open';
  path: string;
}

/**
 * Сохранить значение UI-префа в `globalState` extension'а. Тонкий
 * generic канал: ключ — произвольная строка, значение — JSON-сериализуемое.
 *
 * Введён под #0017 (collapsed-состояние сайдбаров). Намеренно generic,
 * чтобы #0024 (per-run last-viewed tab) и #0026 (canvas zoom) могли
 * пользоваться тем же транспортом без новых message-типов.
 */
export interface StateSetUiPrefRequest {
  type: 'state.setUiPref';
  key: string;
  value: unknown;
}

/**
 * Запросить мапу всех сохранённых UI-префов. Webview шлёт это при
 * старте, extension отвечает `state.uiPrefs.result`. До прихода ответа
 * webview работает с дефолтами — это безопасно: первый рендер всё равно
 * нужен мгновенно, а пользователь свои сохранённые значения увидит
 * через ~миллисекунды.
 */
export interface StateGetUiPrefsRequest {
  type: 'state.getUiPrefs';
}

export type WebviewToExtensionMessage =
  | RunsCreateRequest
  | RunsListRequest
  | RunsGetRequest
  | RunsSetApiKeyRequest
  | RunsUserMessageRequest
  | EditorOpenRequest
  | StateSetUiPrefRequest
  | StateGetUiPrefsRequest;

/* ── Extension → Webview ─────────────────────────────────────────── */

/** Ответ на `runs.list` — полный текущий список метаданных. */
export interface RunsListResult {
  type: 'runs.list.result';
  runs: RunMeta[];
}

/** Ответ на `runs.get` — детали одного рана либо признак отсутствия. */
export interface RunsGetResult {
  type: 'runs.get.result';
  id: string;
  /**
   * Id сессии, чьи chat/tools отданы. Эхо запроса (или активной сессии
   * в RunMeta, если запрос был без sessionId). UI использует это, чтобы
   * подсветить нужный таб и проигнорировать ответ, если пользователь
   * успел кликнуть по другому табу.
   */
  sessionId?: string;
  meta?: RunMeta;
  chat?: ChatMessage[];
  /**
   * Полный лог tool-событий рана из `tools.jsonl`. Webview мерджит его
   * с `chat` по timestamp и рисует единую ленту: assistant/tool_calls/
   * tool_results/system. Без этого пользователь не видит, что именно
   * делал агент (см. US-11).
   */
  tools?: ToolEvent[];
  /**
   * Если ран висит в статусе `awaiting_user_input` — здесь приходит
   * описание вопроса, который надо отрисовать в карточке. Webview
   * получает его сразу при выборе рана, без отдельного round-trip'а.
   */
  pendingAsk?: PendingAsk;
  /**
   * Содержимое `brief.md`, если файл уже есть на диске. Шлём именно
   * текст, а не флаг «бриф готов» — у webview нет fs-доступа, ему
   * нужно само содержимое для рендера. Undefined — брифа нет (роль
   * ещё не закончила или ран failed до записи).
   */
  brief?: string;
  /**
   * Содержимое `plan.md`, если файл уже на диске. Архитекторская роль
   * (#0004) пишет его после успеха продакта; до этого момента undefined.
   * Логика отправки идентична `brief` — текст, а не флаг.
   */
  plan?: string;
}

/**
 * Уведомление о только что созданном ране. Webview может (а) добавить
 * его в список без ожидания `runs.list.result`, (б) сразу выбрать как
 * активный.
 */
export interface RunsCreatedEvent {
  type: 'runs.created';
  meta: RunMeta;
}

/** Транспорт ошибок: показываем пользователю как уведомление. */
export interface RunsErrorEvent {
  type: 'runs.error';
  message: string;
}

/**
 * Уведомление об изменении статуса/метаданных рана. Шлётся при каждом
 * `updateRunStatus` (старт цикла, остановка на ask_user, финал).
 * Webview апдейтит и список, и карточку, если открыт этот ран.
 */
export interface RunsUpdatedEvent {
  type: 'runs.updated';
  meta: RunMeta;
}

/**
 * Сообщение «появился новый pending-вопрос для пользователя». Шлётся,
 * когда модель в активном цикле вызвала `ask_user`. Webview подсвечивает
 * ран и, если он сейчас выбран, отрисовывает баннер с вопросом.
 *
 * Параллельно с этим extension меняет статус рана на `awaiting_user_input`
 * и шлёт `runs.updated` — UI показывает корректный статус.
 */
export interface RunsAskUserEvent {
  type: 'runs.askUser';
  runId: string;
  ask: PendingAsk;
}

/**
 * Дописали сообщение в `chat.jsonl` рана — webview добавляет его в
 * ленту, если этот ран сейчас открыт.
 */
export interface RunsMessageAppendedEvent {
  type: 'runs.message.appended';
  runId: string;
  /**
   * В какую сессию рана дописали сообщение. После #0012 ран — это
   * несколько сессий (продакт, bridge, в будущем — больше); webview
   * фильтрует live-приращения по `selectedSessionId`, чтобы не
   * подмешивать чужие сообщения в текущую ленту.
   */
  sessionId: string;
  message: ChatMessage;
}

/**
 * Дописали запись в `tools.jsonl` рана — webview добавляет её в ленту
 * (мердж с chat по timestamp). Шлётся каждым шагом agent-loop'а:
 * assistant-ответ, tool_result, system-диагностика.
 *
 * Поток отдельный от `runs.message.appended`, потому что tools.jsonl
 * пишется чаще и содержит технические детали (имя тула, аргументы,
 * результат), которые в chat.jsonl не дублируются.
 */
export interface RunsToolAppendedEvent {
  type: 'runs.tool.appended';
  runId: string;
  /** Сессия, в `tools.jsonl` которой добавлена запись. См. RunsMessageAppendedEvent. */
  sessionId: string;
  event: ToolEvent;
}

/**
 * Ответ на `state.getUiPrefs` — текущая мапа всех сохранённых UI-префов.
 * Если ничего ещё не сохраняли — приходит `{}`.
 */
export interface StateUiPrefsResult {
  type: 'state.uiPrefs.result';
  prefs: Record<string, unknown>;
}

export type ExtensionToWebviewMessage =
  | RunsListResult
  | RunsGetResult
  | RunsCreatedEvent
  | RunsErrorEvent
  | RunsUpdatedEvent
  | RunsAskUserEvent
  | RunsMessageAppendedEvent
  | RunsToolAppendedEvent
  | StateUiPrefsResult;
