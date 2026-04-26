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
const SRC_DIR = path.resolve(REPO_ROOT, 'src');
const BUILD_OUTPUTS = [
  path.join(REPO_ROOT, 'out', 'extension', 'index.js'),
  path.join(REPO_ROOT, 'out', 'webview', 'main.js'),
  path.join(REPO_ROOT, 'out', 'webview', 'app.css'),
];

/**
 * Нужна ли пересборка. Раньше была проверка «существует ли
 * `out/extension/index.js`» — этого мало: после первой сборки бандл
 * никогда не обновлялся, и тесты гоняли стейл-код пока кто-то вручную
 * не дёрнет `npm run build`. Сейчас сравниваем mtime каждого bundle с
 * самым свежим файлом под `src/`: если хоть один исходник новее самого
 * старого выхода — собираем. Esbuild/tailwind делают всю работу за
 * ~200мс, так что лишний прогон при пустых изменениях дёшев, но
 * избежать его всё равно стоит на CI.
 */
function needsRebuild(): boolean {
  if (!BUILD_OUTPUTS.every(fs.existsSync)) return true;
  const oldestOutput = Math.min(...BUILD_OUTPUTS.map((p) => fs.statSync(p).mtimeMs));
  return newestMtimeUnder(SRC_DIR) > oldestOutput;
}

function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeUnder(full);
      if (sub > newest) newest = sub;
    } else if (entry.isFile()) {
      const m = fs.statSync(full).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  return newest;
}

export default async function globalSetup() {
  // 1) Сборка. Не запускаем `npm run build` через npm (npm ci добавляет
  //    лишние ~5 сек) — зовём tsc/esbuild через корневой скрипт.
  if (needsRebuild()) {
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
