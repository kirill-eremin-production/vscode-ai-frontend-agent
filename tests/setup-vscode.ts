import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { vi } from 'vitest';

/**
 * Глобальный setup для vitest: подменяем модуль `vscode` лёгким стабом.
 *
 * Зачем: модуль `vscode` существует только в рантайме VS Code extension
 * host'а. В Node-окружении его требуют `entities/run/storage.ts` и
 * транзитивно почти всё ядро. Мы тестируем только детерминированную
 * часть, поэтому достаточно подменить минимальный кусок API:
 * `workspace.workspaceFolders` (на одну временную директорию).
 *
 * Все unit-тесты, опирающиеся на storage, работают на этом общем
 * temp-workspace'е. Тесты, которые гоняют fs-операции, изолируются
 * **внутри** этой папки через свои уникальные подкаталоги — так мы
 * не пересоздаём workspace на каждый тест и не дёргаем мок.
 */

/**
 * Корень общего temp-workspace для всей unit-сюты.
 * Уникальный по UUID — параллельные прогоны (CI и локальный) не схлестнутся.
 */
const tmpWorkspace = path.join(os.tmpdir(), `aiagent-vitest-${crypto.randomUUID()}`);
fs.mkdirSync(tmpWorkspace, { recursive: true });

/**
 * Минимальный стаб модуля `vscode`. Поля, не используемые в ядре,
 * не реализуем — TypeScript-проверки идут через `tsc -p tsconfig.extension.json`,
 * а vitest читает исходники напрямую и видит только то, что фактически
 * вызывается.
 */
vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [
        {
          uri: { fsPath: tmpWorkspace },
          name: 'aiagent-vitest',
          index: 0,
        },
      ],
    },
  };
});

/**
 * Экспорт пути для тестов: storage.ts резолвит `.agents/` относительно
 * `tmpWorkspace`, а тесты могут хотеть проверить файлы напрямую.
 *
 * Вынесено в `globalThis`, потому что vitest пере-импортирует setup-файл
 * для каждого пула, и обычный `export` не пробросится в тестовые модули
 * без явного импорта (а явный импорт setup'а — антипаттерн).
 */
declare global {
  var __TEST_WORKSPACE__: string;
}
globalThis.__TEST_WORKSPACE__ = tmpWorkspace;
