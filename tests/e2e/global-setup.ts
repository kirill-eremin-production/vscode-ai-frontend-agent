import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/**
 * Global setup для Playwright e2e: один раз перед всеми спеками.
 *
 * Делает две вещи:
 *  1) Гарантирует, что extension собран (`out/extension/index.js`,
 *     `out/webview/main.js`). Запуск VS Code с `--extensionDevelopmentPath`
 *     требует готовый бандл — без него активация упадёт с module-not-found.
 *  2) Скачивает портативный VS Code в локальный кэш (`.vscode-test/`)
 *     и сохраняет путь к исполняемому файлу в файл, который читает
 *     фикстура. Таким образом скачивание происходит ровно один раз
 *     на CI/локалке, не на каждый тест.
 *
 * Версия VS Code зафиксирована: рандомный latest при каждом запуске
 * сделал бы тесты flaky из-за изменений в DOM палитры/панели.
 */

/**
 * Версия VS Code для тестов. Обновляем её осознанно, проверяя что
 * наши локаторы (палитра, webview iframe) не сломались.
 */
const VSCODE_VERSION = '1.96.4';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_FILE = path.resolve(__dirname, '.vscode-executable-path');

export default async function globalSetup() {
  // 1) Сборка. Не запускаем `npm run build` через npm (npm ci добавляет
  //    лишние ~5 сек) — зовём tsc/esbuild через корневой скрипт.
  if (!fs.existsSync(path.join(REPO_ROOT, 'out', 'extension', 'index.js'))) {
    console.log('[e2e setup] Сборка расширения...');
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }

  // 2) Скачивание VS Code. downloadAndUnzipVSCode кэширует распаковку
  //    в `.vscode-test/` рядом с CWD; повторный вызов почти бесплатный.
  console.log(`[e2e setup] Получаем VS Code ${VSCODE_VERSION}...`);
  const executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  fs.writeFileSync(CACHE_FILE, executablePath, 'utf8');
  console.log(`[e2e setup] VS Code: ${executablePath}`);
}
