import * as vscode from 'vscode';
import { buildWebviewHtml, buildWebviewOptions } from '@ext/webview/html';

/**
 * Полноценная webview-панель агента, открывающаяся как обычная
 * вкладка редактора (в отличие от sidebar-view, который живёт
 * в боковой панели Activity Bar).
 *
 * Реализован паттерн singleton через статический `current`:
 *  - если панель уже открыта — просто фокусируем её через `reveal`;
 *  - если нет — создаём новую и сохраняем ссылку.
 * Это типовой подход из примеров VS Code Extension Samples: открывать
 * несколько одинаковых webview-панелей одновременно почти всегда
 * не нужно, а singleton избавляет от дубликатов и утечек ресурсов.
 *
 * `retainContextWhenHidden: true` нужен, чтобы при переключении
 * вкладок React-приложение не размонтировалось и не теряло состояние.
 * Цена — повышенный расход памяти, но для одной панели это приемлемо.
 */
export class AgentPanel {
  /** Текущий открытый инстанс панели или undefined, если её нет. */
  public static current: AgentPanel | undefined;

  /** ID типа webview-панели — используется VS Code для сериализации. */
  public static readonly viewType = 'aiFrontendAgent.panel';

  /**
   * Единственный публичный способ открыть/сфокусировать панель.
   * Сам конструктор приватный, чтобы извне нельзя было создать
   * вторую копию в обход singleton-логики.
   */
  public static createOrShow(extensionUri: vscode.Uri) {
    // Открываем в той же колонке, где сейчас активный редактор —
    // это меньше всего ломает пользовательский layout.
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentPanel.viewType,
      'AI Frontend Agent',
      column,
      { ...buildWebviewOptions(extensionUri), retainContextWhenHidden: true }
    );

    AgentPanel.current = new AgentPanel(panel, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    panel.webview.html = buildWebviewHtml(panel.webview, extensionUri);

    // Маршрутизация сообщений от webview — зеркалит логику
    // sidebar-провайдера, но `openInTab` здесь означает «просто
    // сфокусировать уже открытую панель», а не «открыть новую».
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ping') {
        panel.webview.postMessage({ type: 'pong', at: Date.now() });
      } else if (msg?.type === 'openInTab') {
        panel.reveal();
      }
    });

    // Очищаем singleton, когда пользователь закрывает вкладку,
    // иначе следующий `createOrShow` попытается сфокусировать
    // уже уничтоженный webview.
    panel.onDidDispose(() => {
      AgentPanel.current = undefined;
    });
  }
}
