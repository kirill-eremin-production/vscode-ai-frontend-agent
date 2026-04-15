import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@app/App';

/**
 * Точка входа webview-бандла.
 *
 * Esbuild собирает именно этот файл в `out/webview/main.js`
 * (см. скрипт `build:webview` в package.json). Здесь мы:
 *  1) находим корневой DOM-узел, который заранее кладёт в HTML
 *     extension host (см. `getHtml` в слое `extension/webview`);
 *  2) монтируем React 19 root через `createRoot`;
 *  3) оборачиваем приложение в `StrictMode`, чтобы ловить ошибки
 *     двойного эффекта/устаревших API на этапе разработки.
 *
 * Если `#root` не найден — молча выходим. Это значит, что HTML
 * был отрендерен не нашим `getHtml`, и продолжать бессмысленно.
 */
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
