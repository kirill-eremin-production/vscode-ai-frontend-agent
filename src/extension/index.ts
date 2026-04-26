import * as vscode from 'vscode';
import { AgentPanel } from '@ext/providers/agent-panel';
import { AgentSidebarViewProvider } from '@ext/providers/sidebar-view';
import { promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import {
  registerToolLoopSmokeCommand,
  registerToolLoopSmokeResumer,
} from '@ext/features/tool-loop-smoke/command';
import { registerProductResumer } from '@ext/features/product-role';

/**
 * Точка входа extension host.
 *
 * VS Code вызывает `activate` один раз при первом срабатывании любого
 * `activationEvents` (или при наличии contributes-вью, как у нас).
 * Здесь мы регистрируем всё, что должно быть доступно расширению:
 *  1) провайдер sidebar-view — отвечает за webview в Activity Bar;
 *  2) команду `aiFrontendAgent.openPanel` — открывает полноэкранную
 *     панель агента; на эту же команду маршрутизируется кнопка
 *     «Open in editor tab» из webview;
 *  3) команду `aiFrontendAgent.setOpenRouterKey` — позволяет задать
 *     или обновить API-ключ через input box; ключ попадает в
 *     SecretStorage расширения.
 *
 * Все регистрации добавляем в `context.subscriptions`, чтобы VS Code
 * корректно их освободил при `deactivate`/перезагрузке расширения.
 *
 * Контекст пробрасывается в провайдеры явно — он нужен и sidebar,
 * и панели, чтобы доставать секреты и регистрировать обработчики
 * сообщений рана. Альтернатива (глобальная переменная) усложнила бы
 * тестирование и нарушила бы предсказуемый lifecycle расширения.
 */
export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new AgentSidebarViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiFrontendAgent.sidebarView', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiFrontendAgent.openPanel', () => {
      AgentPanel.createOrShow(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiFrontendAgent.setOpenRouterKey', async () => {
      const ok = await promptForOpenRouterKey(context);
      if (ok) {
        void vscode.window.showInformationMessage('OpenRouter API key сохранён');
      }
    })
  );

  // Временная диагностическая команда для ручной проверки tool runtime
  // (Фаза A/B задачи #0001). Удалим/перепрофилируем, когда появятся
  // полноценные роли с собственными FSM-переходами.
  // Resumer регистрируем безусловно — он нужен и для ранов, оставшихся
  // в `awaiting_user_input` с прошлого запуска VS Code.
  registerToolLoopSmokeResumer();
  context.subscriptions.push(registerToolLoopSmokeCommand(context));

  // Resumer продактовой роли (#0003): нужен на каждом запуске, чтобы
  // ран, оставшийся в `awaiting_user_input` после закрытия VS Code,
  // мог возобновиться, когда пользователь введёт ответ. Регистрация
  // не имеет side-эффектов помимо записи в реестр resumer'ов.
  registerProductResumer();
}

/**
 * Хук деактивации. Сейчас пуст: все ресурсы привязаны к
 * `context.subscriptions` и освобождаются автоматически.
 * Оставлен явным, потому что VS Code ожидает экспорт `deactivate`,
 * и его отсутствие — частый источник тихих багов при выгрузке.
 */
export function deactivate() {}
