import * as vscode from 'vscode';
import { buildWebviewHtml, buildWebviewOptions } from '@ext/webview/html';
import { wireRunMessages } from '@ext/features/run-management/wire';

/**
 * Провайдер sidebar-view — той самой иконки в Activity Bar, которая
 * раскрывает webview в боковой панели VS Code.
 *
 * VS Code сам решает, когда вызвать `resolveWebviewView`: лениво,
 * при первом раскрытии вью пользователем. До этого момента ничего
 * рендериться не должно, поэтому конструктор хранит только ссылку на
 * `ExtensionContext` — это всё, что нужно для последующей сборки HTML,
 * опций и подключения IPC ранов.
 *
 * Локальная команда `openInTab` обрабатывается прямо тут — она нужна
 * только sidebar-у, чтобы переоткрыть себя в виде полноразмерной
 * вкладки. Логика ранов вынесена в {@link wireRunMessages} и
 * переиспользуется панелью.
 */
export class AgentSidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Конфигурируем webview ДО установки HTML, иначе CSP/ресурсы
    // будут применяться к уже отрендеренной странице с задержкой.
    webviewView.webview.options = buildWebviewOptions(this.context.extensionUri);
    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.context.extensionUri);

    // Локальный обработчик: обрабатывает только `openInTab`. Любые
    // другие сообщения молча игнорируются — это даёт чистое
    // разграничение с обработчиком ранов, не пересекаясь по типам.
    const localHandler = webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openInTab') {
        // Перенаправляем в команду, которую регистрирует `activate`.
        // Не зовём `AgentPanel` напрямую, чтобы не плодить связи
        // между провайдерами — единая точка входа = команда.
        vscode.commands.executeCommand('aiFrontendAgent.openPanel');
      }
    });

    // Подключаем обработчик сообщений ранов параллельно. wireRunMessages
    // регистрирует ОТДЕЛЬНУЮ подписку — VS Code корректно умеет вызывать
    // несколько слушателей одного webview, и наш локальный фильтр выше
    // их не блокирует.
    const runsHandler = wireRunMessages(this.context, webviewView.webview);

    // Обе подписки прибиваем к жизни самого webview: когда вью свернут
    // и потом снова развёрнут, VS Code пересоздаёт webview и вызывает
    // resolveWebviewView заново — старые подписки должны умереть.
    webviewView.onDidDispose(() => {
      localHandler.dispose();
      runsHandler.dispose();
    });
  }
}
