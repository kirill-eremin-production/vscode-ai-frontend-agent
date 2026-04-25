import * as vscode from 'vscode';
import { createRun, getRunDetails, listRuns } from '@ext/entities/run/service';
import { promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './messages';

/**
 * Подключить обработку сообщений ранов к произвольному webview.
 *
 * Один и тот же провод используется и для sidebar-view, и для
 * полноразмерной панели — обоим нужна идентичная функциональность.
 * Возвращает `Disposable`, который владелец webview обязан положить
 * в `context.subscriptions` (или вызвать в onDidDispose), чтобы
 * корректно отписаться при закрытии.
 *
 * Решение НЕ оборачивать сообщения в request-id/Promise:
 *  - на текущей итерации хватает event-driven модели;
 *  - проще отлаживать (видно в DevTools, какое сообщение какое);
 *  - один request может породить несколько событий (`created` +
 *    обновлённый `list.result`), что естественно ложится на эту схему.
 */
export function wireRunMessages(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): vscode.Disposable {
  /** Утилита: типобезопасный send наружу. */
  const send = (msg: ExtensionToWebviewMessage) => webview.postMessage(msg);

  /**
   * Универсальный канал сообщения об ошибке. Дополнительно дублируем
   * текст в `vscode.window.showErrorMessage`, потому что webview может
   * быть скрыт (sidebar collapsed), и пользователь иначе не увидит
   * причину сбоя.
   */
  const reportError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'runs.error', message });
    void vscode.window.showErrorMessage(`AI Frontend Agent: ${message}`);
  };

  return webview.onDidReceiveMessage(async (raw: unknown) => {
    // На уровне типа доверяем, но валидируем минимально: если у
    // сообщения нет строкового `type` — это либо чужой источник,
    // либо повреждённый payload. В обоих случаях молча игнорируем.
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { type?: unknown }).type !== 'string'
    ) {
      return;
    }
    const msg = raw as WebviewToExtensionMessage;

    try {
      switch (msg.type) {
        case 'runs.create': {
          const meta = await createRun(context, msg.prompt);
          if (!meta) {
            // createRun вернул undefined => пользователь отказался
            // вводить ключ. Это не ошибка, просто ничего не делаем.
            return;
          }
          send({ type: 'runs.created', meta });
          // Сразу же шлём обновлённый список, чтобы webview не делал
          // отдельный запрос — экономим один round-trip и гарантируем,
          // что список и `runs.created` придут согласованно.
          send({ type: 'runs.list.result', runs: await listRuns() });
          return;
        }
        case 'runs.list': {
          send({ type: 'runs.list.result', runs: await listRuns() });
          return;
        }
        case 'runs.get': {
          const details = await getRunDetails(msg.id);
          send({
            type: 'runs.get.result',
            id: msg.id,
            meta: details?.meta,
            chat: details?.chat,
          });
          return;
        }
        case 'runs.setApiKey': {
          await promptForOpenRouterKey(context);
          return;
        }
        default: {
          // Защита от не-исчерпанного switch: если в union добавится
          // новый вариант, а кейс забудут — TS подсветит ошибкой.
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    } catch (err) {
      reportError(err);
    }
  });
}
