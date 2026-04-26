/**
 * Глобальные декларации для unit-тестов.
 *
 * `__TEST_WORKSPACE__` создаётся `tests/setup-vscode.ts` при инициализации
 * vitest и используется в тестах для прямой проверки файлов на диске
 * (минуя storage). Декларируем тип здесь, чтобы любой test-файл видел
 * его без явного импорта setup-модуля.
 */
declare global {
  var __TEST_WORKSPACE__: string;
}

export {};
