/**
 * Тонкая обёртка над глобальной функцией `acquireVsCodeApi`, которую
 * VS Code инжектит в webview-окружение ровно один раз за жизнь страницы.
 * Повторный вызов `acquireVsCodeApi` бросает исключение, поэтому мы
 * вызываем её на уровне модуля и экспортируем единственный инстанс.
 *
 * Почему это лежит в `shared/api`, а не в `features/*`:
 * по FSD знание о внешнем транспорте (webview <-> extension host) —
 * это инфраструктура, общая для всех фич. Фичи должны импортировать
 * `vscode` только отсюда, чтобы не плодить прямые зависимости от
 * глобалов и упростить будущую замену транспорта (например, на mock
 * в Storybook/тестах).
 */

/**
 * Публичный контракт VS Code webview API — минимальное подмножество,
 * которым мы реально пользуемся. Расширяем по мере появления нужды,
 * чтобы случайные поля не утекали в фичи.
 */
export interface VSCodeApi {
  /** Отправить сообщение в extension host (наружу из webview). */
  postMessage(message: unknown): void;
  /** Прочитать персистентное состояние webview (переживает скрытие панели). */
  getState<T = unknown>(): T | undefined;
  /** Записать персистентное состояние webview. */
  setState<T>(state: T): void;
}

// Глобальная функция, объявленная VS Code в runtime webview-а.
// Описываем её через `declare`, чтобы TS знал сигнатуру, но не пытался
// импортировать как обычный модуль — её просто нет в бандле.
declare function acquireVsCodeApi(): VSCodeApi;

/**
 * Единственный инстанс VS Code API на всё приложение.
 * ВАЖНО: не вызывать `acquireVsCodeApi()` где-то ещё — второй вызов упадёт
 * с ошибкой «An instance of the VS Code API has already been acquired».
 */
export const vscode: VSCodeApi = acquireVsCodeApi();
