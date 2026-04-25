import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ChatMessage, RunMeta } from './types';

/**
 * Файловое хранилище ранов.
 *
 * Решение хардкодить `.agents/` в корне открытого workspace — сознательное:
 * это ровно то, что обещали пользователю («синхронизация через документацию
 * прямо в его проекте»). База данных или globalStorage сюда не подходят,
 * потому что артефакты рана должны лежать рядом с кодом, который агенты
 * правят, и попадать в git вместе с ним.
 */

/**
 * Имя корневой папки. Точка в начале — чтобы папка по умолчанию пряталась
 * в дереве файлов VS Code и не мозолила глаза, но при этом всё ещё
 * коммитилась (в отличие от `.vscode/`, у нас содержимое полезное).
 */
const ROOT_DIR_NAME = '.agents';
const RUNS_DIR_NAME = 'runs';
const KNOWLEDGE_DIR_NAME = 'knowledge';
const META_FILE = 'meta.json';
const CHAT_FILE = 'chat.jsonl';
const TOOLS_FILE = 'tools.jsonl';

/**
 * Кастомная ошибка хранилища. Выкидывается в случаях, когда дальнейшая
 * работа невозможна без действия пользователя (нет открытого workspace).
 * Отдельный тип нужен, чтобы IPC-слой мог отличить такие ошибки от
 * случайных багов и показать понятное сообщение.
 */
export class RunStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStorageError';
  }
}

/**
 * Достать абсолютный путь до корня workspace. Если пользователь
 * открыл VS Code без папки — мы не знаем, куда писать `.agents/`,
 * и это намеренно фатальная ситуация, а не fallback в globalStorage.
 *
 * Multi-root workspace тоже пока не поддерживаем — берём первый
 * folder. Это упрощение первой итерации; когда понадобится несколько
 * рабочих директорий, добавим явный выбор.
 */
function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new RunStorageError(
      'Откройте папку в VS Code, чтобы создавать раны (нужно место для .agents/)'
    );
  }
  return folders[0].uri.fsPath;
}

/** Полный путь до `.agents/runs/`. */
function getRunsRoot(): string {
  return path.join(getWorkspaceRoot(), ROOT_DIR_NAME, RUNS_DIR_NAME);
}

/** Полный путь до папки конкретного рана. */
function getRunDir(runId: string): string {
  return path.join(getRunsRoot(), runId);
}

/**
 * Корень knowledge base всех ролей. Используется тулами `kb.*` через
 * хелпер `resolveKnowledgePath` — отдаёт абсолютный путь и на нём же
 * проверяется sandbox (никакого `..` за пределы этой директории).
 */
export function getKnowledgeRoot(): string {
  return path.join(getWorkspaceRoot(), ROOT_DIR_NAME, KNOWLEDGE_DIR_NAME);
}

/**
 * Резолвить путь внутри knowledge base и проверить sandbox.
 * Возвращает абсолютный путь, гарантированно лежащий внутри
 * `.agents/knowledge/`. Бросает `RunStorageError` при попытке
 * выйти за пределы (через `..`, абсолютный путь и т.п.).
 *
 * @param relativePath относительный путь от корня knowledge.
 *                     Может содержать поддиректории через `/`.
 */
export function resolveKnowledgePath(relativePath: string): string {
  const root = getKnowledgeRoot();
  // path.resolve нормализует `..` и абсолютные пути; затем явно проверяем,
  // что результат начинается с `root` + sep — это и есть sandbox-проверка.
  const resolved = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new RunStorageError(
      `Путь "${relativePath}" выходит за пределы .agents/knowledge/ — sandbox запрещён`
    );
  }
  return resolved;
}

/**
 * Создать директорию рана и базовые файлы.
 * Использует `recursive: true`, чтобы не падать, если `.agents/runs/`
 * ещё не существует — это обычное состояние при первом ране.
 */
export async function initRunDir(meta: RunMeta): Promise<void> {
  const dir = getRunDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  // Пишем meta.json через temp-файл + rename, чтобы случайный креш
  // не оставил пустой файл; для chat.jsonl такой осторожности не нужно
  // (append-only, мы не теряем содержимое при оборванной записи).
  await writeMeta(meta);
  // Создаём chat.jsonl сразу пустым, чтобы последующие append-операции
  // могли работать без проверки существования.
  const chatPath = path.join(dir, CHAT_FILE);
  await fs.writeFile(chatPath, '', { flag: 'a' });
}

/**
 * Перезаписать meta.json. Атомарно: сначала во временный файл,
 * потом rename. Это защищает от обрыва (сбой питания/kill процесса
 * посреди записи) — на диске всегда либо старое, либо новое содержимое.
 */
export async function writeMeta(meta: RunMeta): Promise<void> {
  const dir = getRunDir(meta.id);
  const finalPath = path.join(dir, META_FILE);
  const tmpPath = path.join(dir, `${META_FILE}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf8');
  await fs.rename(tmpPath, finalPath);
}

/**
 * Прочитать meta.json одного рана. Возвращает undefined, если файла
 * нет или JSON битый — список ранов не должен падать целиком из-за
 * одной повреждённой папки.
 */
export async function readMeta(runId: string): Promise<RunMeta | undefined> {
  const filePath = path.join(getRunDir(runId), META_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as RunMeta;
  } catch {
    return undefined;
  }
}

/**
 * Прочитать meta.json всех ранов в `.agents/runs/`.
 * Сортируем по убыванию `createdAt`, чтобы свежие были сверху —
 * это естественный порядок для UI-списка.
 */
export async function listAllMeta(): Promise<RunMeta[]> {
  const root = getRunsRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // Папки ещё нет — это нормально, просто пустой список.
    return [];
  }

  const metas: RunMeta[] = [];
  for (const entry of entries) {
    const meta = await readMeta(entry);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return metas;
}

/**
 * Дописать одно сообщение в chat.jsonl. Формат — по строке на сообщение,
 * выбран намеренно: append-only, легко читать построчно, не нужно
 * парсить весь файл при каждой записи.
 */
export async function appendChatMessage(runId: string, message: ChatMessage): Promise<void> {
  const filePath = path.join(getRunDir(runId), CHAT_FILE);
  // \n в конце обязателен — иначе следующая запись склеится с этой
  // и сломает построчный парсинг.
  await fs.appendFile(filePath, JSON.stringify(message) + '\n', 'utf8');
}

/**
 * Запись tool-события: один шаг agent-loop'а. Append-only лог в
 * `tools.jsonl`. Дискриминированный union по `kind` — проще как
 * расширять новыми типами событий, так и парсить.
 *
 * Это «полный» лог, в отличие от `chat.jsonl` — туда дублируются
 * только финальные assistant-ответы и сообщения от/к пользователю.
 */
export type ToolEvent =
  | {
      kind: 'assistant';
      at: string;
      /** Текст ответа модели (может быть null, если только tool_calls). */
      content: string | null;
      /** Сырой массив tool_calls, как пришёл от провайдера. */
      tool_calls?: Array<{
        id: string;
        name: string;
        /** JSON-строка аргументов — храним как есть, без парсинга. */
        arguments: string;
      }>;
    }
  | {
      kind: 'tool_result';
      at: string;
      /** id из tool_call, к которому привязан результат. */
      tool_call_id: string;
      /** Имя тула — дублируем для удобства чтения лога. */
      tool_name: string;
      /** Результат тула (успех) — произвольный JSON-сериализуемый объект. */
      result?: unknown;
      /** Ошибка тула (валидация, sandbox, исключение в handler). */
      error?: string;
    }
  | {
      kind: 'system';
      at: string;
      /** Текст диагностики: лимит итераций, фатальная ошибка цикла и т.п. */
      message: string;
    };

/**
 * Дописать одно tool-событие в tools.jsonl. Полный аналог
 * `appendChatMessage`, но для отдельного, технического лога agent-loop'а.
 */
export async function appendToolEvent(runId: string, event: ToolEvent): Promise<void> {
  const filePath = path.join(getRunDir(runId), TOOLS_FILE);
  await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * Прочитать все tool-события рана. Нужно для resume (восстановление
 * pending `ask_user` после перезапуска VS Code) и для будущей UI
 * вкладки «tools log». Битые строки пропускаем, как в `readChat`.
 */
export async function readToolEvents(runId: string): Promise<ToolEvent[]> {
  const filePath = path.join(getRunDir(runId), TOOLS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const events: ToolEvent[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as ToolEvent);
    } catch {
      // Битая строка — пропускаем.
    }
  }
  return events;
}

/**
 * Прочитать всю историю чата рана. Игнорирует пустые строки и битые
 * JSON-записи (на случай, если кто-то откроет файл и руками что-то
 * туда напишет) — лучше показать частичную историю, чем уронить UI.
 */
export async function readChat(runId: string): Promise<ChatMessage[]> {
  const filePath = path.join(getRunDir(runId), CHAT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      messages.push(JSON.parse(line) as ChatMessage);
    } catch {
      // Битая строка — пропускаем, не падаем.
    }
  }
  return messages;
}
