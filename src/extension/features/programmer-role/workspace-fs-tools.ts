import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { recordToolEvent } from '@ext/features/run-management/broadcast';
import type { ToolDefinition } from '@ext/shared/agent-loop';

/**
 * Тулы доступа к workspace проекта пользователя для роли программиста
 * (issue #0027). Это **первый** случай, когда агент трогает реальный
 * код пользователя — поэтому в реализации упор на безопасность:
 *
 *  - sandbox прибит к `vscode.workspace.workspaceFolders[0]`;
 *  - попытка побега (через `..`, абсолютный путь, симлинк наружу)
 *    отдельно отлавливается и логируется в `tools.jsonl` уровнем
 *    `error` — это не «agent ошибся», это «возможный баг sandbox»;
 *  - на запись действует deny-list (`.git/`, `node_modules/`, etc.) —
 *    чтение разрешено везде в workspace;
 *  - НЕТ `fs.delete` / `fs.rename` (намеренно, см. issue).
 *
 * Модуль НЕ вынесен в shared: если потом архитектор/продакт получат
 * readonly fs-доступ, общую часть выделим тогда. Сейчас не угадываем.
 */

/**
 * Список путей-паттернов, в которые нельзя писать. Чтение разрешено.
 *
 *  - `prefix` — относительный префикс (с конечным `/` для директорий),
 *    с которого не должен начинаться путь записи.
 *  - `extension` — расширение файла (с точкой).
 *
 * Список — единственный источник правды; и проверяющая функция, и
 * сообщение об ошибке отсюда же берут описание.
 */
const WRITE_DENY_LIST: ReadonlyArray<{ kind: 'prefix' | 'extension'; value: string }> = [
  { kind: 'prefix', value: '.agents/' },
  { kind: 'prefix', value: '.git/' },
  { kind: 'prefix', value: 'node_modules/' },
  { kind: 'prefix', value: 'out/' },
  { kind: 'prefix', value: 'dist/' },
  { kind: 'prefix', value: '.vscode/' },
  { kind: 'extension', value: '.lock' },
  { kind: 'extension', value: '.log' },
];

function describeDenyList(): string {
  const prefixes = WRITE_DENY_LIST.filter((e) => e.kind === 'prefix')
    .map((e) => e.value)
    .join(', ');
  const extensions = WRITE_DENY_LIST.filter((e) => e.kind === 'extension')
    .map((e) => `*${e.value}`)
    .join(', ');
  return `${prefixes}; ${extensions}`;
}

function isWriteDenied(relativePath: string): { denied: false } | { denied: true; reason: string } {
  // Нормализуем сепараторы к `/`, чтобы deny-list работал и на Windows.
  const normalized = relativePath.split(path.sep).join('/');
  for (const entry of WRITE_DENY_LIST) {
    if (entry.kind === 'prefix') {
      if (normalized === entry.value.replace(/\/$/, '') || normalized.startsWith(entry.value)) {
        return {
          denied: true,
          reason: `Запись в "${entry.value}" запрещена (deny-list программиста). Полный список: ${describeDenyList()}`,
        };
      }
    } else if (entry.kind === 'extension') {
      if (normalized.toLowerCase().endsWith(entry.value)) {
        return {
          denied: true,
          reason: `Запись в файлы с расширением "${entry.value}" запрещена. Полный список: ${describeDenyList()}`,
        };
      }
    }
  }
  return { denied: false };
}

/**
 * Кастомная ошибка попытки побега из sandbox. Отдельный класс нужен,
 * чтобы handler смог отличить её от обычной fs-ошибки и записать в
 * tools.jsonl `system`-события уровнем `error` — это сигнал «возможный
 * баг sandbox или вредоносный prompt», который надо разбирать
 * отдельно от обычных tool-error'ов.
 */
class WorkspaceSandboxEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSandboxEscapeError';
  }
}

/**
 * Резолвить путь относительно workspace root и убедиться, что он
 * остаётся внутри. Двухступенчатая проверка по issue #0027:
 *
 *  1. `path.resolve(root, requested)` + `startsWith(root + sep)`
 *     ловит `..` и абсолютный путь снаружи.
 *  2. `fs.realpath` + повторный `startsWith` ловит симлинк, который
 *     указывает наружу: текстовый путь внутри workspace, но реальный
 *     inode — за пределами.
 *
 * Для несуществующих файлов (типичный случай для `fs.write`) realpath
 * бросит ENOENT — в этом случае реалпасним родительскую директорию,
 * рекурсивно поднимаясь, пока не найдём существующий предок. Это и
 * есть правильное поведение: симлинк на пути к файлу = побег, даже
 * если самого файла ещё нет.
 */
async function resolveWorkspacePath(root: string, requested: string): Promise<string> {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new WorkspaceSandboxEscapeError('Путь не задан');
  }
  if (path.isAbsolute(requested)) {
    throw new WorkspaceSandboxEscapeError(
      `Абсолютные пути запрещены: "${requested}". Передавай workspace-relative путь.`
    );
  }
  const resolved = path.resolve(root, requested);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new WorkspaceSandboxEscapeError(`Путь "${requested}" выходит за пределы workspace`);
  }

  const real = await realpathDeep(resolved);
  const realWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (real !== root && !real.startsWith(realWithSep)) {
    // Реалпас существующего предка вышел за workspace — почти наверняка
    // симлинк на компонент пути. Закрываем дважды по issue #0027.
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      realRoot = root;
    }
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(realRootWithSep)) {
      throw new WorkspaceSandboxEscapeError(
        `Путь "${requested}" указывает наружу через симлинк (real: ${real})`
      );
    }
  }
  return resolved;
}

/**
 * Найти ближайшего существующего предка и сделать realpath ему. Нужно
 * для `fs.write` по новому пути: целевой файл ещё не существует, но
 * родительская директория может содержать симлинк наружу.
 */
async function realpathDeep(p: string): Promise<string> {
  let current = p;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        // Дошли до корня файловой системы — отдаём как есть.
        return p;
      }
      current = parent;
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Атомарная запись через temp + rename. Зеркалит `writeJsonAtomic` /
 * `kb.write` поведение: на диске всегда либо старая версия, либо новая,
 * никогда полу-записанная.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Записать system-событие уровня `error` в tools.jsonl. Используется
 * для попыток побега из sandbox — это не обычная tool-error, это сигнал
 * «возможный баг sandbox» (issue #0027 acceptance).
 *
 * Сообщение начинается с маркера `[sandbox-escape]`, чтобы grep по логу
 * сразу выдавал такие случаи.
 */
async function logSandboxEscape(runId: string, message: string): Promise<void> {
  await recordToolEvent(runId, {
    kind: 'system',
    at: new Date().toISOString(),
    message: `[sandbox-escape] ${message}`,
  });
}

/* ── Tool builders ──────────────────────────────────────────────── */

interface BuildWorkspaceFsToolsOptions {
  /** Список deny-write — оставлен опцией для тестов; продакшен использует дефолт. */
  denyWrite?: ReadonlyArray<{ kind: 'prefix' | 'extension'; value: string }>;
}

/**
 * Собрать набор `fs.*` тулов, привязанных к указанному workspace root.
 *
 * `workspaceRoot` передаётся явно (а не читается из vscode внутри),
 * чтобы тулы можно было юнит-тестировать без VS Code (см.
 * `workspace-fs-tools.test.ts`).
 */
export function buildWorkspaceFsTools(
  workspaceRoot: string,
  // Зарезервировано на будущее (например, расширяемый denyWrite). Сейчас
  // namespace deny-list жёстко прибит в `isDeniedForWrite` — параметр оставлен
  // в сигнатуре, чтобы не ломать вызывающих при будущей конфигурации.
  _options: BuildWorkspaceFsToolsOptions = {} // eslint-disable-line @typescript-eslint/no-unused-vars
): ToolDefinition[] {
  return [
    buildFsReadTool(workspaceRoot) as ToolDefinition,
    buildFsWriteTool(workspaceRoot) as ToolDefinition,
    buildFsListTool(workspaceRoot) as ToolDefinition,
    buildFsGrepTool(workspaceRoot) as ToolDefinition,
  ];
}

function buildFsReadTool(root: string): ToolDefinition<{ path: string }> {
  return {
    name: 'fs.read',
    description:
      'Прочитать файл из workspace проекта. ' +
      'Путь — workspace-relative (например, "src/utils/date.ts"). ' +
      'Возвращает { exists, content } — exists=false если файла нет (это не ошибка).',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Workspace-relative путь',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path: rel }, ctx) => {
      let abs: string;
      try {
        abs = await resolveWorkspacePath(root, rel);
      } catch (err) {
        if (err instanceof WorkspaceSandboxEscapeError) {
          await logSandboxEscape(ctx.runId, `fs.read: ${err.message}`);
        }
        throw err;
      }
      try {
        const content = await fs.readFile(abs, 'utf8');
        return { exists: true, content };
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return { exists: false, content: null };
        }
        throw err;
      }
    },
  };
}

function buildFsWriteTool(root: string): ToolDefinition<{ path: string; content: string }> {
  return {
    name: 'fs.write',
    description:
      'Записать файл в workspace проекта (атомарно: temp + rename). ' +
      'Путь — workspace-relative. Создаёт промежуточные директории. ' +
      `Запрещено писать в: ${describeDenyList()}. ` +
      'Возвращает { ok: true, path, bytes }.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Workspace-relative путь',
        },
        content: {
          type: 'string',
          description: 'Полное содержимое файла',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: async ({ path: rel, content }, ctx) => {
      let abs: string;
      try {
        abs = await resolveWorkspacePath(root, rel);
      } catch (err) {
        if (err instanceof WorkspaceSandboxEscapeError) {
          await logSandboxEscape(ctx.runId, `fs.write: ${err.message}`);
        }
        throw err;
      }
      const denied = isWriteDenied(rel);
      if (denied.denied) {
        throw new Error(denied.reason);
      }
      await writeFileAtomic(abs, content);
      const bytes = Buffer.byteLength(content, 'utf8');
      // System-событие в tools.jsonl, чтобы по логу можно было быстро
      // восстановить, что натворил агент (issue #0027 acceptance).
      await recordToolEvent(ctx.runId, {
        kind: 'system',
        at: new Date().toISOString(),
        message: `[fs.write] ${rel} (${bytes} bytes)`,
      });
      return { ok: true, path: rel, bytes };
    },
  };
}

function buildFsListTool(root: string): ToolDefinition<{ path: string }> {
  return {
    name: 'fs.list',
    description:
      'Перечислить содержимое директории в workspace (без рекурсии). ' +
      'Возвращает { entries: [{ name, isDirectory }] }. Если директории нет — { entries: [] }.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative путь. Пустая строка = корень workspace.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path: rel }, ctx) => {
      // Для пустой строки трактуем как root.
      const target = rel.length === 0 ? '.' : rel;
      let abs: string;
      try {
        abs = await resolveWorkspacePath(root, target);
      } catch (err) {
        if (err instanceof WorkspaceSandboxEscapeError) {
          await logSandboxEscape(ctx.runId, `fs.list: ${err.message}`);
        }
        throw err;
      }
      try {
        const dirents = await fs.readdir(abs, { withFileTypes: true });
        return {
          entries: dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
        };
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') return { entries: [] };
        throw err;
      }
    },
  };
}

function buildFsGrepTool(root: string): ToolDefinition<{ pattern: string; path?: string }> {
  return {
    name: 'fs.grep',
    description:
      'Поиск регулярки по содержимому файлов в workspace. ' +
      'Использует ripgrep, если он есть на PATH; иначе fallback на JS-обход. ' +
      'Возвращает { matches: [{ path, line, text }] }, ограничено 200 совпадениями.',
    schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'Regex (без обрамляющих слешей)',
        },
        path: {
          type: 'string',
          description: 'Поддиректория поиска (workspace-relative). По умолчанию — весь workspace.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async ({ pattern, path: rel }, ctx) => {
      const subRel = rel && rel.length > 0 ? rel : '.';
      let abs: string;
      try {
        abs = await resolveWorkspacePath(root, subRel);
      } catch (err) {
        if (err instanceof WorkspaceSandboxEscapeError) {
          await logSandboxEscape(ctx.runId, `fs.grep: ${err.message}`);
        }
        throw err;
      }
      const MAX_MATCHES = 200;
      // ripgrep — быстрее и уважает .gitignore. Если его нет — JS-fallback.
      try {
        const matches = await runRipgrep(pattern, abs, root, MAX_MATCHES);
        return { matches };
      } catch (err) {
        if (!(err instanceof RipgrepUnavailableError)) throw err;
        const matches: Array<{ path: string; line: number; text: string }> = [];
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (regexErr) {
          const reason = regexErr instanceof Error ? regexErr.message : 'unknown';
          throw new Error(`Невалидный regex: ${reason}`);
        }
        await walkAndGrep(abs, root, regex, matches, MAX_MATCHES);
        return { matches };
      }
    },
  };
}

class RipgrepUnavailableError extends Error {
  constructor() {
    super('ripgrep not on PATH');
    this.name = 'RipgrepUnavailableError';
  }
}

/**
 * Запустить ripgrep. Бросает `RipgrepUnavailableError`, если бинаря нет —
 * вызывающий код должен поймать и упасть на JS-fallback.
 */
async function runRipgrep(
  pattern: string,
  searchDir: string,
  workspaceRoot: string,
  limit: number
): Promise<Array<{ path: string; line: number; text: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'rg',
      ['--no-heading', '--line-number', '--color=never', '-m', String(limit), pattern, searchDir],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new RipgrepUnavailableError());
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      // ripgrep: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) {
        reject(new Error(`ripgrep failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (matches.length >= limit) break;
        if (line.length === 0) continue;
        // Формат `path:line:text`. Путь может содержать `:` на Windows (drive),
        // но мы запускаемся только под workspace-relative — поэтому ищем
        // первые два двоеточия слева.
        const firstColon = line.indexOf(':');
        if (firstColon < 0) continue;
        const secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon < 0) continue;
        const filePath = line.slice(0, firstColon);
        const lineNum = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
        if (!Number.isFinite(lineNum)) continue;
        const text = line.slice(secondColon + 1);
        const relPath = path.relative(workspaceRoot, filePath);
        matches.push({ path: relPath, line: lineNum, text });
      }
      resolve(matches);
    });
  });
}

/** JS-fallback для grep'а — рекурсивный обход. Зеркало kb.grep. */
async function walkAndGrep(
  dir: string,
  workspaceRoot: string,
  regex: RegExp,
  out: Array<{ path: string; line: number; text: string }>,
  limit: number
): Promise<void> {
  if (out.length >= limit) return;
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const dirent of dirents) {
    if (out.length >= limit) return;
    // Пропускаем стандартные «шумные» директории, чтобы fallback не
    // обходил гигабайты node_modules и .git'а. ripgrep делает это
    // через .gitignore; здесь — захардкоженным мини-списком.
    if (dirent.isDirectory() && WALK_SKIP_DIRS.has(dirent.name)) continue;
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walkAndGrep(abs, workspaceRoot, regex, out, limit);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (SKIP_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const relPath = path.relative(workspaceRoot, abs);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        out.push({ path: relPath, line: i + 1, text: lines[i] });
        if (out.length >= limit) return;
      }
    }
  }
}

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.agents', '.vscode']);

const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.lock',
]);

/**
 * Прочитать корень workspace из VS Code. Бросает, если папка не открыта.
 * Используется `runProgrammer` для построения тулов; в тестах вместо
 * этого передаётся явный путь к temp-директории.
 */
export function getWorkspaceRootOrThrow(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Программисту нужен открытый workspace, но его нет');
  }
  return folders[0].uri.fsPath;
}

/** Экспорт для тестов. */
export const __test__ = {
  WRITE_DENY_LIST,
  isWriteDenied,
  resolveWorkspacePath,
  WorkspaceSandboxEscapeError,
};
