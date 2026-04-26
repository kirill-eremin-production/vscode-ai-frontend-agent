import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Фикстура запуска настоящего VS Code из Playwright.
 *
 * Используем `_electron.launch()` — официальный способ драйвить
 * Electron-приложения из Playwright. На вход — путь к исполняемому
 * файлу VS Code (его кладёт global-setup) и набор аргументов, которые
 * делают сессию изолированной и предсказуемой:
 *
 *  - `--extensionDevelopmentPath` указывает на корень нашего репо
 *    и на test-extension; оба активируются как dev-расширения.
 *  - `--user-data-dir` и `--extensions-dir` — уникальные временные
 *    папки на каждый тест: ни секреты, ни installed extensions
 *    предыдущего прогона не утекут в текущий.
 *  - workspace — отдельная пустая temp-папка, чтобы `.agents/runs/`
 *    каждого теста жил изолированно.
 *  - Флаги `--disable-*` отключают всё, что обычно мешает в
 *    автотестах: telemetry, обновления, workspace trust, welcome page.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_EXTENSION_PATH = path.resolve(__dirname, '..', 'test-extension');
const VSCODE_EXECUTABLE_CACHE = path.resolve(__dirname, '..', '.vscode-executable-path');

/** Расширения базовой `test`-фабрики собственными фикстурами. */
export interface VSCodeFixtures {
  /** Запущенное Electron-приложение VS Code. */
  electronApp: ElectronApplication;
  /** Главное окно VS Code (workbench). */
  vscodeWindow: Page;
  /** Корень workspace — `.agents/runs/` тестов лежит здесь. */
  workspacePath: string;
  /** Путь к JSON-файлу со сценарием для fake-fetch (создаётся тестом). */
  scenarioPath: string;
  /**
   * Доп. env-переменные для `--extensionDevelopmentHost`. Опция
   * (`{ option: true }`) — переопределяется per-test через
   * `test.use({ extraEnv: { ... } })`. Используется, например, в TC-31:
   * там нужно включить авто-передачу рана архитектору
   * (`AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT=1`), которая по умолчанию
   * выключена в фикстуре.
   */
  extraEnv: Record<string, string>;
}

/**
 * Уникальные временные папки одной тестовой сессии. Этот тип общий
 * для базовой фикстуры и для durability-тестов (TC-16), которым нужно
 * перезапустить VS Code на тех же путях.
 */
export interface IsolatedDirs {
  userDataDir: string;
  extensionsDir: string;
  workspacePath: string;
  scenarioPath: string;
}

/**
 * Сгенерировать набор уникальных temp-папок для одной тестовой сессии.
 * Возвращаем все три, чтобы тест мог заглянуть в workspace для
 * проверки `.agents/runs/`.
 */
export function makeIsolatedDirs(): IsolatedDirs {
  const id = crypto.randomUUID();
  const root = path.join(os.tmpdir(), `aiagent-e2e-${id}`);
  const userDataDir = path.join(root, 'user-data');
  const extensionsDir = path.join(root, 'extensions');
  const workspacePath = path.join(root, 'workspace');
  for (const dir of [userDataDir, extensionsDir, workspacePath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Файл сценария тест перезапишет перед действием; создаём пустой,
  // чтобы fs.readFileSync не падал при ранней активации test-extension.
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ responses: [] }), 'utf8');
  return { userDataDir, extensionsDir, workspacePath, scenarioPath };
}

/**
 * Прочитать путь к скачанному VS Code, оставленный global-setup'ом.
 * Кидаем понятную ошибку, если запуск идёт мимо официального скрипта.
 */
function readVSCodeExecutablePath(): string {
  if (!fs.existsSync(VSCODE_EXECUTABLE_CACHE)) {
    throw new Error(
      `[e2e] Не найден ${VSCODE_EXECUTABLE_CACHE}. Сначала отработает global-setup; запускай тесты через npm run test:e2e:full.`
    );
  }
  return fs.readFileSync(VSCODE_EXECUTABLE_CACHE, 'utf8').trim();
}

/**
 * Один запуск VS Code на заданных временных папках.
 *
 * Вынесен наружу из фикстуры, чтобы durability-тесты (TC-16) могли
 * перезапустить приложение на тех же `--user-data-dir`/workspace —
 * это и есть «перезапуск» с точки зрения VS Code: SecretStorage и
 * `.agents/runs/` сохраняются.
 *
 * `videoSubdir` нужен, чтобы при двух запусках в одном тесте видео не
 * перезаписывали друг друга (Playwright кладёт по имени папки).
 */
export async function launchVSCodeApp(
  dirs: IsolatedDirs,
  testInfo: import('@playwright/test').TestInfo,
  videoSubdir = 'video',
  extraEnv: Record<string, string> = {}
): Promise<ElectronApplication> {
  const executablePath = readVSCodeExecutablePath();
  const videoDir = path.join(testInfo.outputDir, videoSubdir);
  fs.mkdirSync(videoDir, { recursive: true });

  const app = await _electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      `--extensionDevelopmentPath=${TEST_EXTENSION_PATH}`,
      `--user-data-dir=${dirs.userDataDir}`,
      `--extensions-dir=${dirs.extensionsDir}`,
      '--disable-workspace-trust',
      '--disable-telemetry',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      dirs.workspacePath,
    ],
    env: {
      ...process.env,
      AI_FRONTEND_AGENT_FAKE_OPENROUTER_SCENARIO: dirs.scenarioPath,
      // По умолчанию выключаем авто-передачу рана архитектору (#0004),
      // чтобы существующие продактовые TC не ломались об архитекторский
      // step без сценарных ответов на его модель. Архитекторские TC
      // (TC-31) выставляют '1' через `test.use({ extraEnv: ... })`.
      AI_FRONTEND_AGENT_AUTOSTART_ARCHITECT: '0',
      // Per-test override (после дефолтов, чтобы тест мог переопределить
      // любую переменную выше).
      ...extraEnv,
    },
    recordVideo: {
      dir: videoDir,
      size: { width: 1366, height: 768 },
    },
    timeout: 30_000,
  });

  // Фиксированный размер окна для воспроизводимости e2e: layout
  // (видимость SessionsPanel, перенос табов, размещение кубиков на
  // канвасе) зависит от размера. 1366×768 — распространённый ноутбучный
  // baseline, на котором UI обязан корректно работать.
  //
  // Через Electron API, а не через `--window-size`: VS Code на macOS
  // игнорирует Chromium-флаг (его WindowsMainService восстанавливает
  // окно сам). Дожидаемся первого окна, потом ресайз — это надёжно.
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setSize(1366, 768);
    win.setPosition(0, 0);
  });

  // Сохраняем пути в самой инстанции, чтобы фикстуры workspacePath
  // и scenarioPath могли их забрать.
  (app as unknown as { __dirs?: IsolatedDirs }).__dirs = dirs;
  return app;
}

/**
 * Удалить singleton-лок-файлы Chromium/Electron в `--user-data-dir`.
 *
 * Electron при старте создаёт `SingletonLock`/`SingletonSocket`/
 * `SingletonCookie`, указывающие на PID и сокет главного процесса.
 * При закрытии приложения они почти всегда удаляются — но не всегда:
 * хелпер-процессы могут не успеть, особенно когда `app.close()` срабатывает
 * быстрее обычного (как в наших тестах). Если повторно запустить VS Code
 * на той же `--user-data-dir`, новый процесс попытается достучаться до
 * мёртвого сокета и тихо выходит — Playwright тут же видит «Target ...
 * has been closed» при `firstWindow()`.
 *
 * Чистим лок руками: для durability-тестов это безопасно — мы точно
 * знаем, что предыдущая сессия уже закрыта.
 */
export function clearSingletonLocks(userDataDir: string): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(userDataDir, name), { force: true });
    } catch {
      // Ничего страшного: файла могло и не быть.
    }
  }
}

/**
 * Корректно закрыть Electron-приложение и приложить записанные видео
 * к отчёту. Сделан общим, потому что используется и фикстурой при
 * teardown, и durability-тестами при «промежуточном» закрытии.
 */
export async function closeAndAttachVideos(
  app: ElectronApplication,
  testInfo: import('@playwright/test').TestInfo,
  attachPrefix = 'vscode'
): Promise<void> {
  const videos = app.windows().map((window) => window.video());
  try {
    await app.close();
  } catch {
    // Приложение могло уже быть закрыто (durability-тест мог сделать
    // это вручную). Это нормально, нам важно только аттачить видео.
  }
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    if (!video) continue;
    try {
      const videoPath = await video.path();
      await testInfo.attach(`${attachPrefix}-window-${index}.webm`, {
        path: videoPath,
        contentType: 'video/webm',
      });
    } catch {
      // Видео могло не сохраниться — пропускаем.
    }
  }
}

export const test = base.extend<VSCodeFixtures>({
  // Опция-фикстура: значение задаётся через `test.use({ extraEnv: ... })`
  // в самом спеке. По умолчанию — пусто.
  extraEnv: [{}, { option: true }],

  electronApp: async ({ extraEnv }, use, testInfo) => {
    const dirs = makeIsolatedDirs();
    const app = await launchVSCodeApp(dirs, testInfo, 'video', extraEnv);
    await use(app);
    await closeAndAttachVideos(app, testInfo);
  },

  vscodeWindow: async ({ electronApp }, use) => {
    // У VS Code при старте может быть несколько окон (например, open
    // recent). Ждём первое и считаем его главным workbench'ом.
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },

  workspacePath: async ({ electronApp }, use) => {
    await use(getSessionDirs(electronApp).workspacePath);
  },

  scenarioPath: async ({ electronApp }, use) => {
    await use(getSessionDirs(electronApp).scenarioPath);
  },
});

/**
 * Хелпер: достать пути изолированной сессии. Прокидываем их через
 * приватное поле на ElectronApplication (см. `__dirs` в launch выше).
 */
export function getSessionDirs(app: ElectronApplication): {
  workspacePath: string;
  scenarioPath: string;
  userDataDir: string;
  extensionsDir: string;
} {
  const dirs = (
    app as unknown as {
      __dirs?: {
        workspacePath: string;
        scenarioPath: string;
        userDataDir: string;
        extensionsDir: string;
      };
    }
  ).__dirs;
  if (!dirs) {
    throw new Error(
      '[e2e] Не удалось получить временные папки сессии — фикстура electronApp не инициализировалась.'
    );
  }
  return dirs;
}

export { expect } from '@playwright/test';
