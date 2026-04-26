import type { ChatMessage, RunMeta } from '@ext/entities/run/types';
import type { PendingAsk } from '@ext/entities/run/storage';

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
}

/** Открыть input box и сохранить ключ OpenRouter в SecretStorage. */
export interface RunsSetApiKeyRequest {
  type: 'runs.setApiKey';
}

/**
 * Ответ пользователя на pending `ask_user`. Webview шлёт это сообщение,
 * когда пользователь нажал «Ответить» в карточке рана. `askId` — это
 * `tool_call_id` из последнего assistant-сообщения цикла.
 */
export interface RunsUserAnswerRequest {
  type: 'runs.userAnswer';
  runId: string;
  askId: string;
  answer: string;
}

export type WebviewToExtensionMessage =
  | RunsCreateRequest
  | RunsListRequest
  | RunsGetRequest
  | RunsSetApiKeyRequest
  | RunsUserAnswerRequest;

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
  meta?: RunMeta;
  chat?: ChatMessage[];
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
 * ран и, если он сейчас выбран, отрисовывает форму ответа.
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
  message: ChatMessage;
}

export type ExtensionToWebviewMessage =
  | RunsListResult
  | RunsGetResult
  | RunsCreatedEvent
  | RunsErrorEvent
  | RunsUpdatedEvent
  | RunsAskUserEvent
  | RunsMessageAppendedEvent;
