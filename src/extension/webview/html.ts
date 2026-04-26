import * as vscode from 'vscode';
import { getNonce } from '@ext/shared/nonce';

/**
 * Опции webview, общие и для sidebar-view, и для panel-view.
 *
 * Почему вынесено в отдельную функцию, а не константу:
 * `localResourceRoots` зависит от `extensionUri`, который VS Code
 * передаёт в провайдер в runtime — на этапе модуля его ещё нет.
 * Функция позволяет провайдерам строить опции лениво и единообразно.
 *
 * `enableScripts: true` нужен, потому что вся UI — это React-бандл.
 * `localResourceRoots` намеренно сужен до `out/webview` и `media`,
 * чтобы webview не мог загрузить файлы из других мест расширения
 * (защита по принципу наименьших привилегий).
 */
export function buildWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
}

/**
 * Сборка HTML-шаблона для webview.
 *
 * Что делает:
 *  1) превращает локальные пути к JS/CSS в `vscode-webview-resource://`
 *     URI через `webview.asWebviewUri` — без этого webview не сможет
 *     загрузить ресурсы из расширения;
 *  2) генерирует одноразовый nonce и встраивает его и в CSP, и в
 *     <script>, чтобы скрипт прошёл политику безопасности;
 *  3) возвращает минимальный HTML с `<div id="root">` — точкой
 *     монтирования React-приложения (см. `src/webview/app/index.tsx`).
 *
 * CSP жёсткий специально:
 *  - `default-src 'none'` — по умолчанию ничего нельзя;
 *  - `style-src ${webview.cspSource}` — стили только из расширения;
 *  - `script-src 'nonce-${nonce}'` — скрипты только с нашим nonce.
 * Это закрывает почти все классы XSS-инъекций внутри webview.
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  // URI до собранного React-бандла. Имя файла должно совпадать с
  // выходом esbuild-а из скрипта `build:webview` в package.json.
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js')
  );
  // Два стилевых файла:
  //  1) Tailwind 4 + семантические токены — собирается из
  //     `src/webview/app/app.css` командой `build:webview-css`
  //     в `out/webview/app.css`. Подключаем ПЕРВЫМ, чтобы layered-стили
  //     Tailwind'а оказались ниже unlayered-правил из `media/main.css`
  //     (cascade-layers всегда уступают unlayered CSS — это даёт нам
  //     совместимость со старыми ad-hoc стилями на время миграции #0016+).
  //  2) Старый ad-hoc CSS из `media/main.css` — оставлен на время
  //     миграции; новые компоненты должны идти на токены/utility-классы.
  const tailwindUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'app.css')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${tailwindUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>AI Frontend Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
