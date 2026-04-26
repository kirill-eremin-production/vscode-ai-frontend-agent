import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * Конфиг vitest для unit-тестов ядра расширения.
 *
 * Запускаем только Node-side код (storage, validator, resume, kb-тулы);
 * ничего React/JSDOM сюда не тянем — UI и webview покрываются отдельно
 * (см. issue #0006). Поэтому окружение — `node`.
 *
 * Алиас `@ext/*` повторяет `paths` из `tsconfig.extension.json`, чтобы
 * исходники, импортирующие `@ext/...`, работали в рантайме vitest без
 * правок (vitest сам не читает `tsconfig.paths`).
 *
 * Модуль `vscode` мокается отдельно в `tests/setup-vscode.ts` — он
 * подключается через `setupFiles` и подменяется на лёгкий стаб (см.
 * комментарии в самом файле). Это нужно, потому что `entities/run/storage.ts`
 * импортирует `vscode` для определения корня workspace.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./tests/setup-vscode.ts'],
    // Чтобы тесты были быстрыми и предсказуемыми, гоняем их в одном
    // потоке: между файлами есть общий мок vscode и общая tmp-папка,
    // параллелизм добавил бы flake без выигрыша по времени (вся сюта
    // целевые ≤2с).
    pool: 'forks',
    // В vitest 4 опции пулов поднялись на верхний уровень: один форк на
    // всю сюту достаточен — мокающие модули (vscode) держат единое
    // состояние, а параллелизм для ≤2с-сюты не выигрывает.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@ext': path.resolve(__dirname, 'src/extension'),
    },
  },
});
