import * as vscode from 'vscode';
import { buildWebviewHtml, buildWebviewOptions } from '@ext/webview/html';

/**
 * Провайдер sidebar-view — той самой иконки в Activity Bar, которая
 * раскрывает webview в боковой панели VS Code.
 *
 * VS Code сам решает, когда вызвать `resolveWebviewView`: лениво,
 * при первом раскрытии вью пользователем. До этого момента ничего
 * рендериться не должно, поэтому конструктор хранит только
 * `extensionUri` — это всё, что нужно для последующей сборки HTML
 * и опций.
 *
 * Почему обработчик сообщений живёт здесь, а не в общем месте:
 * sidebar и panel — это два РАЗНЫХ webview-инстанса, у каждого свой
 * `webview.postMessage`. Шарить один обработчик нельзя, потому что
 * `pong` должен прийти именно тому webview, который прислал `ping`.
 */
export class AgentSidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Конфигурируем webview ДО установки HTML, иначе CSP/ресурсы
    // будут применяться к уже отрендеренной странице с задержкой.
    webviewView.webview.options = buildWebviewOptions(this.extensionUri);
    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.extensionUri);

    // Маршрутизация входящих сообщений от webview.
    // Контракт согласован с фичами webview (см. `features/*`).
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ping') {
        // Отвечаем на пинг — фича `message-log` отрисует ответ.
        webviewView.webview.postMessage({ type: 'pong', at: Date.now() });
      } else if (msg?.type === 'openInTab') {
        // Перенаправляем в команду, которую регистрирует `activate`.
        // Не зовём `AgentPanel` напрямую, чтобы не плодить связи
        // между провайдерами — единая точка входа = команда.
        vscode.commands.executeCommand('aiFrontendAgent.openPanel');
      }
    });
  }
}
