import * as vscode from 'vscode';
import { AgentPanel } from '@ext/providers/agent-panel';
import { AgentSidebarViewProvider } from '@ext/providers/sidebar-view';

/**
 * Точка входа extension host.
 *
 * VS Code вызывает `activate` один раз при первом срабатывании любого
 * `activationEvents` (или при наличии contributes-вью, как у нас).
 * Здесь мы регистрируем всё, что должно быть доступно расширению:
 *  1) провайдер sidebar-view — отвечает за webview в Activity Bar;
 *  2) команду `aiFrontendAgent.openPanel` — открывает полноэкранную
 *     панель агента; на эту же команду маршрутизируется кнопка
 *     «Open in editor tab» из webview.
 *
 * Все регистрации добавляем в `context.subscriptions`, чтобы VS Code
 * корректно их освободил при `deactivate`/перезагрузке расширения.
 */
export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new AgentSidebarViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiFrontendAgent.sidebarView', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiFrontendAgent.openPanel', () => {
      AgentPanel.createOrShow(context.extensionUri);
    })
  );
}

/**
 * Хук деактивации. Сейчас пуст: все ресурсы привязаны к
 * `context.subscriptions` и освобождаются автоматически.
 * Оставлен явным, потому что VS Code ожидает экспорт `deactivate`,
 * и его отсутствие — частый источник тихих багов при выгрузке.
 */
export function deactivate() {}
