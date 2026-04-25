import type { ChatMessage, RunMeta } from '@ext/entities/run/types';

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

export type WebviewToExtensionMessage =
  | RunsCreateRequest
  | RunsListRequest
  | RunsGetRequest
  | RunsSetApiKeyRequest;

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

export type ExtensionToWebviewMessage =
  | RunsListResult
  | RunsGetResult
  | RunsCreatedEvent
  | RunsErrorEvent;
