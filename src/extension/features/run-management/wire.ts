import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { createRun, getRunDetails, listRuns } from '@ext/entities/run/service';
import {
  addParticipant,
  appendChatMessage,
  findPendingAsk,
  readBrief,
  readMeta,
  readPlan,
} from '@ext/entities/run/storage';
import { resumeRun } from '@ext/entities/run/resume-registry';
import { resolvePendingAsk } from '@ext/shared/agent-loop';
import {
  PRODUCT_FINALIZE_MARKER,
  PRODUCT_FINALIZE_USER_TEXT,
} from '@ext/entities/run/roles/product';
import { promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import { broadcast, onBroadcast } from './broadcast';
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
          const details = await getRunDetails(msg.id, msg.sessionId);
          // pendingAsk актуален только для ранов в awaiting_user_input.
          // В других статусах не читаем tools.jsonl впустую (детали
          // там есть в `details.tools`, но конкретный pending-вопрос —
          // это отдельная семантика «над чем висит ран»). После #0012
          // pending живёт в активной сессии — даже если UI просматривает
          // другую, баннер показываем по активной.
          const pendingAsk =
            details?.meta.status === 'awaiting_user_input'
              ? await findPendingAsk(msg.id)
              : undefined;
          // brief.md читаем безусловно — он может уже лежать в любом
          // статусе после фейла (если роль успела дописать) или в
          // awaiting_human (штатный финал). readBrief сам вернёт
          // undefined, если файла нет — лишнего I/O не будет.
          const brief = details ? await readBrief(msg.id) : undefined;
          // plan.md появляется после успеха архитекторской роли (#0004).
          // Читаем безусловно по тем же мотивам, что и brief: пустой —
          // вернётся undefined без лишнего I/O.
          const plan = details ? await readPlan(msg.id) : undefined;
          send({
            type: 'runs.get.result',
            id: msg.id,
            sessionId: details?.sessionId,
            meta: details?.meta,
            chat: details?.chat,
            tools: details?.tools,
            pendingAsk,
            brief,
            plan,
          });
          return;
        }
        case 'runs.setApiKey': {
          await promptForOpenRouterKey(context);
          return;
        }
        case 'runs.user.message': {
          await handleUserMessage(context, msg.runId, msg.text, msg.finalize === true);
          return;
        }
        case 'editor.open': {
          await openWorkspaceFile(msg.path);
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

/**
 * Обработать сообщение пользователя в чате рана. Маршрутизация
 * полностью на нашей стороне:
 *
 *  - `awaiting_user_input` → ответ на pending `ask_user`. Сначала
 *    пытаемся резолвить in-memory pending (быстрый путь, когда
 *    extension host не перезапускался). Если не нашли — поднимаем
 *    resumer с intent='answer'; он восстановит цикл с диска и
 *    подложит ответ как `role: tool` в историю.
 *
 *  - `awaiting_human` / `failed` → продолжение диалога (US-10).
 *    Дописываем сообщение в `chat.jsonl` (broadcast'ом, чтобы UI
 *    сразу увидел), потом поднимаем resumer с intent='continue'.
 *    Цикл получит новое сообщение как `role: user` поверх своей
 *    истории и пойдёт дальше — обычно с обновлением `brief.md`.
 *
 *  - `running` / `draft` → отбрасываем. Технически дать сообщение в
 *    `running` можно (поставить в очередь), но это сложный кейс
 *    с гонками; пока UI просто дизейблит Send, а мы здесь страхуем
 *    от рассинхрона UI/extension явным `runs.error`.
 */
async function handleUserMessage(
  context: vscode.ExtensionContext,
  runId: string,
  text: string,
  finalize: boolean
): Promise<void> {
  const meta = await readMeta(runId);
  if (!meta) {
    throw new Error(`Ран ${runId} не найден`);
  }

  // finalize-сигнал (US-13): кнопка «Достаточно вопросов» вместо обычного
  // ответа на ask_user. Поле text от UI игнорируем — кнопка одна, текст
  // подставляем дословный (PRODUCT_FINALIZE_MARKER), чтобы модель его
  // распознала ровно так, как описано в системном промпте.
  if (finalize) {
    if (meta.status !== 'awaiting_user_input') {
      throw new Error(
        `Сигнал finalize валиден только в awaiting_user_input, а ран сейчас в "${meta.status}"`
      );
    }
    const pending = await findPendingAsk(runId);
    if (!pending) {
      throw new Error(
        'Ран в awaiting_user_input, но pending-вопроса в tools.jsonl нет — состояние повреждено'
      );
    }
    // 1. Видимый след действия в chat.jsonl (короткий, без длинного маркера).
    //    Это нужно UI: пользователь должен увидеть, что нажал именно
    //    «достаточно вопросов», а не оставил поле пустым.
    const userMessage = {
      id: crypto.randomBytes(6).toString('hex'),
      from: 'user',
      at: new Date().toISOString(),
      text: PRODUCT_FINALIZE_USER_TEXT,
    };
    const finalizeSessionId = await appendChatMessage(runId, userMessage);
    await ensureUserParticipant(runId, finalizeSessionId);
    broadcast({
      type: 'runs.message.appended',
      runId,
      sessionId: finalizeSessionId,
      message: userMessage,
    });

    // 2. Маркер уходит в pending как ответ на ask_user. Дальше — обычный
    //    путь: in-memory pending → resolvePendingAsk; если процесс
    //    перезапускался — поднимаем resumer с intent='answer'.
    const resolved = resolvePendingAsk(pending.toolCallId, PRODUCT_FINALIZE_MARKER);
    if (resolved) return;
    await resumeRun({
      context,
      runId,
      intent: {
        kind: 'answer',
        pendingToolCallId: pending.toolCallId,
        userAnswer: PRODUCT_FINALIZE_MARKER,
      },
    });
    return;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Пустое сообщение — нечего отправлять');
  }

  if (meta.status === 'awaiting_user_input') {
    // Ищем pending ask_user, чтобы привязать ответ. findPendingAsk
    // читает tools.jsonl — это устойчиво и к перезапуску VS Code,
    // и к гонке «UI прислал устаревший askId» (askId мы вообще
    // не получаем от UI, всегда берём актуальный с диска).
    const pending = await findPendingAsk(runId);
    if (!pending) {
      throw new Error(
        'Ран в awaiting_user_input, но pending-вопроса в tools.jsonl нет — состояние повреждено'
      );
    }
    // Сначала быстрый путь: pending в памяти текущего процесса.
    const resolved = resolvePendingAsk(pending.toolCallId, trimmed);
    if (resolved) return;

    // Иначе — pending не в памяти: либо был перезапуск VS Code,
    // либо мы сейчас в свежей сессии extension host'а.
    await resumeRun({
      context,
      runId,
      intent: { kind: 'answer', pendingToolCallId: pending.toolCallId, userAnswer: trimmed },
    });
    return;
  }

  if (meta.status === 'awaiting_human' || meta.status === 'failed') {
    // Дописываем в chat.jsonl и сразу broadcast'им, чтобы лента
    // обновилась мгновенно — даже если resumer'у понадобится секунда
    // на чтение loop.json/tools.jsonl, пользователь уже видит свой ввод.
    const chatMessage = {
      id: crypto.randomBytes(6).toString('hex'),
      from: 'user',
      at: new Date().toISOString(),
      text: trimmed,
    };
    const continueSessionId = await appendChatMessage(runId, chatMessage);
    await ensureUserParticipant(runId, continueSessionId);
    broadcast({
      type: 'runs.message.appended',
      runId,
      sessionId: continueSessionId,
      message: chatMessage,
    });

    await resumeRun({
      context,
      runId,
      intent: { kind: 'continue', userMessage: trimmed },
    });
    return;
  }

  // running / draft: ничего не делаем, но даём UI понятный сигнал.
  throw new Error(
    `Нельзя отправить сообщение, пока ран в статусе "${meta.status}". Дождитесь завершения шага агента.`
  );
}

/**
 * Гарантировать, что пользователь числится участником сессии (#0012).
 * После первого user-сообщения в agent-agent сессии она становится
 * hybrid: `participants` дополняется `{kind:'user'}`, в meta.json это
 * отражено, UI получает `runs.updated` и может перерисовать badge таба.
 *
 * Идемпотентно: для user-agent сессий, где user уже в participants,
 * не делает ничего. Не бросает на отсутствии сессии — это деградирует
 * до «не пометили hybrid», но не валит обработку сообщения.
 */
async function ensureUserParticipant(runId: string, sessionId: string): Promise<void> {
  try {
    const updated = await addParticipant(runId, sessionId, { kind: 'user' });
    if (updated) broadcast({ type: 'runs.updated', meta: updated });
  } catch {
    // sessionId всегда валиден (только что в неё писали), но на всякий
    // случай не даём упасть всему обработчику сообщения.
  }
}

/**
 * Открыть файл из workspace в новой вкладке редактора. Путь — строго
 * относительный от корня workspace; абсолютные пути отклоняем как
 * лишнюю поверхность атаки и кросс-платформенный риск.
 *
 * Если файла нет — `vscode.open` сам покажет ошибку пользователю; мы
 * не префлайтим существование, чтобы не плодить специфичных сообщений.
 */
async function openWorkspaceFile(relativePath: string): Promise<void> {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('editor.open: путь обязателен');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error('editor.open: ожидается относительный путь от корня workspace');
  }
  // Блокируем выход за пределы workspace через `..` — это не дыра,
  // т.к. webview работает с теми же файлами, но соответствует
  // принципу «откуда пришло, туда и можно».
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('editor.open: путь не должен содержать ".."');
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('editor.open: нет открытого workspace');
  }
  const absolute = path.join(folders[0].uri.fsPath, relativePath);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute));
}
