import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { generateTitle } from './title';
import {
  appendChatMessage,
  initRunDir,
  listAllMeta,
  readChat,
  readMeta,
  readToolEvents,
  type ToolEvent,
} from './storage';
import type { ChatMessage, RunMeta } from './types';
import { getOpenRouterKey, promptForOpenRouterKey } from '@ext/shared/secrets/openrouter-key';
import { runProduct } from '@ext/features/product-role';

/**
 * Сервисный слой для работы с ранами.
 *
 * Здесь сводится всё, что нужно знать вызывающему коду (IPC-хэндлерам,
 * командам): как создать ран, как достать список, как получить детали.
 * Никаких знаний о webview/IPC — только предметная логика; это позволит
 * позже подключить тот же сервис из тестов или из CLI.
 */

/**
 * Сгенерировать новый id рана. Используем timestamp + короткий случайный
 * суффикс: timestamp даёт естественную сортировку и читаемость в имени
 * папки, а суффикс защищает от коллизии при двух запусках в одну
 * миллисекунду (теоретически возможно при автотестах).
 *
 * Формат: `20260426T143005-ab12c3` — без двоеточий, чтобы было валидным
 * именем папки на всех ОС, включая Windows.
 */
function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${suffix}`;
}

/**
 * Гарантировать наличие ключа OpenRouter. Если его нет — спрашиваем
 * пользователя через input box. Возвращает ключ или undefined,
 * если пользователь отказался ввести.
 *
 * Эта проверка живёт здесь, а не в IPC-слое, потому что любой будущий
 * вход в систему (CLI, тест-скрипт) должен пройти через тот же шаг.
 */
async function ensureApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  let key = await getOpenRouterKey(context);
  if (key) return key;

  const provided = await promptForOpenRouterKey(context);
  if (!provided) return undefined;

  key = await getOpenRouterKey(context);
  return key;
}

/**
 * Создать новый ран по запросу пользователя.
 *
 * Шаги (порядок важен — title-генерация уже стоит денег и времени,
 * поэтому делаем её ДО создания файлов: если она упала — мы хотя бы
 * не оставим на диске «пустой» ран без заголовка):
 *  1) Достаём ключ (или просим у пользователя).
 *  2) Генерим заголовок (с fallback на первые символы prompt).
 *  3) Создаём папку рана и пишем meta.json.
 *  4) Кладём первое сообщение в chat.jsonl — сам prompt.
 *
 * @returns свежий {@link RunMeta} или undefined, если пользователь
 *          отказался ввести ключ (тогда ран не создаётся).
 */
export async function createRun(
  context: vscode.ExtensionContext,
  prompt: string
): Promise<RunMeta | undefined> {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    throw new Error('Промпт пустой — нечего запускать');
  }

  const apiKey = await ensureApiKey(context);
  if (!apiKey) return undefined;

  const title = await generateTitle(apiKey, trimmed);

  const now = new Date().toISOString();
  const baseMeta = {
    id: generateRunId(),
    title,
    prompt: trimmed,
    status: 'draft' as const,
    createdAt: now,
    updatedAt: now,
  };

  // initRunDir создаёт первую (и пока единственную) сессию рана —
  // user ↔ agent:product. Возвращает уже полную RunMeta с
  // `activeSessionId` и пустыми usage-агрегатами.
  const meta = await initRunDir(baseMeta, {
    kind: 'user-agent',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    status: 'draft',
  });

  // Первое сообщение в чате — исходный запрос пользователя. Кладём его
  // именно сюда, чтобы единая лента рана начиналась с понятной точки
  // отсчёта, и любые роли могли её читать как обычное сообщение.
  // appendChatMessage без явного sessionId пишет в активную сессию.
  const firstMessage: ChatMessage = {
    id: crypto.randomBytes(6).toString('hex'),
    from: 'user',
    at: now,
    text: trimmed,
  };
  await appendChatMessage(meta.id, firstMessage);

  // Fire-and-forget запуск продактовой роли. Не await'им — IPC-ответ
  // на `runs.create` должен прилететь сразу, прогресс роли пойдёт
  // через broadcast (`runs.updated`, `runs.askUser`,
  // `runs.message.appended`). Любые исключения внутри `runProduct`
  // ловятся им же и превращаются в `failed`-статус, наружу не утекают.
  void runProduct({ runId: meta.id, apiKey, prompt: trimmed }).catch((err) => {
    // Совсем неожиданная ошибка (например, баг в самом `runProduct`'е,
    // не пойманный его try/catch). Пишем в console — VS Code покажет
    // в Extension Host output, чтобы при разработке было видно.
    console.error('[runProduct] непойманная ошибка:', err);
  });

  return meta;
}

/** Список всех ранов в текущем workspace, свежие сверху. */
export async function listRuns(): Promise<RunMeta[]> {
  return listAllMeta();
}

/**
 * Полные детали одного рана: meta + история чата + лог tool-событий.
 * Возвращает undefined, если ран не найден (например, удалили папку
 * вручную) — UI должен это обработать как «выбранный ран исчез».
 *
 * `tools` нужен webview, чтобы строить единую ленту chat + tools по
 * timestamp (US-11). Читаем безусловно: пустой `tools.jsonl` — это
 * нормальное состояние свежего рана, `readToolEvents` сам вернёт `[]`.
 */
export async function getRunDetails(
  runId: string
): Promise<{ meta: RunMeta; chat: ChatMessage[]; tools: ToolEvent[] } | undefined> {
  const meta = await readMeta(runId);
  if (!meta) return undefined;
  const chat = await readChat(runId);
  const tools = await readToolEvents(runId);
  return { meta, chat, tools };
}
