import * as vscode from 'vscode';
import { createRun, getRunDetails, listRuns } from '@ext/entities/run/service';
import { findPendingAsk, readBrief } from '@ext/entities/run/storage';
import { resumeRun } from '@ext/entities/run/resume-registry';
import { resolvePendingAsk } from '@ext/shared/agent-loop';
import { promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import { onBroadcast } from './broadcast';
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
 *
 * Помимо обработки входящих, wire подписывается на `broadcast` —
 * исходящие события от agent-loop (статусы, askUser, новые сообщения
 * чата) автоматически уходят во все активные webview.
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

  // Подписка на broadcast: всё, что agent-loop / resume / роли шлют
  // через `broadcast(...)`, прокидывается в этот webview как есть.
  const broadcastSub = onBroadcast(send);

  const messageSub = webview.onDidReceiveMessage(async (raw: unknown) => {
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
          // pendingAsk актуален только для ранов в awaiting_user_input.
          // В других статусах не читаем tools.jsonl впустую.
          const pendingAsk =
            details?.meta.status === 'awaiting_user_input'
              ? await findPendingAsk(msg.id)
              : undefined;
          // brief.md читаем безусловно — он может уже лежать в любом
          // статусе после фейла (если роль успела дописать) или в
          // awaiting_human (штатный финал). readBrief сам вернёт
          // undefined, если файла нет — лишнего I/O не будет.
          const brief = details ? await readBrief(msg.id) : undefined;
          send({
            type: 'runs.get.result',
            id: msg.id,
            meta: details?.meta,
            chat: details?.chat,
            pendingAsk,
            brief,
          });
          return;
        }
        case 'runs.setApiKey': {
          await promptForOpenRouterKey(context);
          return;
        }
        case 'runs.userAnswer': {
          // Сначала пытаемся резолвить in-memory pending — это
          // быстрый путь, когда extension host не перезапускался.
          const resolved = resolvePendingAsk(msg.askId, msg.answer);
          if (resolved) return;

          // Иначе — pending не в памяти: либо был перезапуск VS Code,
          // либо поздний дубликат ответа. Пытаемся возобновить из
          // диска. resumeRun сам отчитается через broadcast.
          await resumeRun({
            context,
            runId: msg.runId,
            pendingToolCallId: msg.askId,
            userAnswer: msg.answer,
          });
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

  // Возвращаем составной Disposable: snять обе подписки одной
  // командой (broadcast и onDidReceiveMessage).
  return {
    dispose: () => {
      broadcastSub.dispose();
      messageSub.dispose();
    },
  };
}
