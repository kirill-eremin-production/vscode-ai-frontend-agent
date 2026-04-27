import * as vscode from 'vscode';
import { AgentPanel } from '@ext/providers/agent-panel';
import { AgentSidebarViewProvider } from '@ext/providers/sidebar-view';
import { promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import {
  registerToolLoopSmokeCommand,
  registerToolLoopSmokeResumer,
} from '@ext/features/tool-loop-smoke/command';
import { registerProductResumer } from '@ext/features/product-role';
import { registerArchitectResumer } from '@ext/features/architect-role';
import { registerProgrammerResumer } from '@ext/features/programmer-role';
import { listAllMeta } from '@ext/entities/run/storage';
import { triggerResolvePending } from '@ext/team/meeting-resolver';
import { setMeetingWakeupHandler } from '@ext/team/meeting-wakeup';
import { resumeRun } from '@ext/entities/run/resume-registry';

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

  // Resumer архитектора (#0004): нужен по тем же причинам, что и
  // продактовый — ран, остановленный на `ask_user` архитектора, должен
  // подняться после перезапуска VS Code или нового сообщения от
  // пользователя (US-10).
  registerArchitectResumer();

  // Resumer программиста (#0027): по тем же причинам, что и у архитектора
  // — программистский ран, остановленный на pending `ask_user`, должен
  // подняться после перезапуска VS Code или нового сообщения от
  // пользователя.
  registerProgrammerResumer();

  // Триггер meeting-resolver на активации (#0050): после рестарта VS Code
  // в ранах могут оставаться pending meeting-request'ы, которые не
  // успели разрезолвиться в предыдущей сессии редактора. Прогоняем по
  // всем известным ранам последовательно — на этой итерации их единицы,
  // I/O бюджет ничтожный. Fire-and-forget внутри `triggerResolvePending`:
  // ошибки логируются, активация не падает.
  void resolvePendingForAllRuns();

  // #0051: handler пробуждения инициатора meeting-request'а после
  // резолва. Регистрируем здесь, потому что только в `activate` есть
  // доступ к `vscode.ExtensionContext` (нужен для `resumeRun` — тот
  // достаёт apiKey из SecretStorage). Тестам этот handler не виден
  // (они работают через свои стабы поверх `setMeetingWakeupHandler`).
  setMeetingWakeupHandler(async ({ runId, meetingRequestId, requesteeRole, resolvedSessionId }) => {
    await resumeRun({
      context,
      runId,
      intent: {
        kind: 'meeting_resolved',
        meetingRequestId,
        targetRole: requesteeRole,
        resolvedSessionId,
      },
    });
  });
}

/**
 * Прогнать координатор встреч по всем ранам workspace'а. Вынесено
 * в отдельную функцию, чтобы `activate` оставался синхронным фасадом —
 * VS Code ожидает быстрый возврат, а резолвер делает несколько fs-чтений.
 */
async function resolvePendingForAllRuns(): Promise<void> {
  try {
    const runs = await listAllMeta();
    for (const run of runs) {
      await triggerResolvePending(run.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[activate] resolvePendingForAllRuns failed: ${message}`);
  }
}

/**
 * Хук деактивации. Сейчас пуст: все ресурсы привязаны к
 * `context.subscriptions` и освобождаются автоматически.
 * Оставлен явным, потому что VS Code ожидает экспорт `deactivate`,
 * и его отсутствие — частый источник тихих багов при выгрузке.
 */
export function deactivate() {}
