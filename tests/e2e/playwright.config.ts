import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

/**
 * Playwright config для full e2e-suite (mocked OpenRouter).
 *
 * Раннер Playwright выбран потому, что он даёт ровно те фичи, которые
 * нужны для «доверительного» e2e: HTML-репорт со скринами, trace viewer,
 * `--ui` mode для интерактивной отладки, retry с артефактами.
 *
 * Запускаем НЕ через web-сервер: тесты сами запускают VS Code Electron
 * через фикстуру `electronApp` (см. fixtures/vscode.ts). Поэтому
 * `webServer` тут не нужен и `use.baseURL` тоже.
 *
 * `workers: 1` — VS Code тяжёлый, параллельный запуск на одной машине
 * приведёт к гонкам за порт DevTools и просто сожрёт RAM. Скорость
 * жертвуем осознанно.
 */
export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  // Сборку расширения и закачку VS Code делает global setup, см. ниже.
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
  // Жёсткий timeout: VS Code стартует ~3-5 сек, плюс цикл — обычно
  // укладываемся в 30 сек. Если упёрлись — это сигнал, что что-то
  // зависло, а не «нужно подождать ещё».
  timeout: 60_000,
  expect: {
    // Локаторы внутри webview iframe иногда «думают» дольше из-за React.
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: path.resolve(__dirname, '..', '..', 'playwright-report'), open: 'never' },
    ],
  ],
  use: {
    // Trace включаем всегда — это и есть тот «UI с шагами тестов»,
    // ради которого мы и взяли Playwright. Размер артефактов небольшой,
    // на скорость прогона почти не влияет.
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
