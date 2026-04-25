import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getKnowledgeRoot, resolveKnowledgePath, RunStorageError } from '@ext/entities/run/storage';
import type { ToolDefinition } from '../types';

/**
 * Базовый набор тулов для работы с knowledge base агентов.
 *
 * Все тулы sandbox-нуты в `.agents/knowledge/` через `resolveKnowledgePath`
 * — попытка выйти за пределы (`..`, абсолютный путь) даст ошибку
 * валидации в handler, которую agent-loop превратит в `tool_result.error`.
 *
 * Тулы намеренно простые, без «умных» абстракций: одна задача — один
 * тул. Это упрощает и system prompt роли (модель быстрее понимает,
 * какой тул когда звать), и отладку.
 */

/**
 * Чтение файла. Возвращает `{ content }` при успехе. Если файла нет —
 * это **не ошибка sandbox**, а обычная not-found: модель должна уметь
 * это обработать (например, через `kb.list` сначала). Поэтому not-found
 * мы возвращаем как `{ exists: false }`, а не throw.
 */
export const kbReadTool: ToolDefinition<{ path: string }> = {
  name: 'kb.read',
  description:
    'Прочитать markdown-файл из knowledge base. ' +
    'Путь — относительный от корня kb (например, "product/glossary/term.md"). ' +
    'Возвращает { exists, content } — exists=false если файла нет (это не ошибка).',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Относительный путь от .agents/knowledge/',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async ({ path: rel }) => {
    // resolveKnowledgePath сам бросит RunStorageError при выходе за sandbox.
    const abs = resolveKnowledgePath(rel);
    try {
      const content = await fs.readFile(abs, 'utf8');
      return { exists: true, content };
    } catch (err) {
      // ENOENT — нормальный случай: файла нет. Прочие ошибки (EACCES,
      // EISDIR — попытка прочитать директорию) пробрасываем как ошибку
      // тула, чтобы модель не путала их с «нет файла».
      if (isNodeError(err) && err.code === 'ENOENT') {
        return { exists: false, content: null };
      }
      throw err;
    }
  },
};

/**
 * Запись файла. Атомарно через temp + rename — тот же приём, что для
 * meta.json. Создаёт промежуточные директории. Перезаписывает существующий
 * файл без подтверждения — это сознательно: kb-история живёт в git, откат
 * делается обычным `git checkout`.
 */
export const kbWriteTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'kb.write',
  description:
    'Записать markdown-файл в knowledge base. ' +
    'Создаёт директории по пути. Перезаписывает существующий файл. ' +
    'Возвращает { ok: true, path } при успехе.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Относительный путь от .agents/knowledge/',
      },
      content: {
        type: 'string',
        description: 'Полное содержимое файла (markdown).',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async ({ path: rel, content }) => {
    const abs = resolveKnowledgePath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Atomic write: сначала во временный файл, потом rename. Защищает
    // от обрыва записи — на диске всегда либо старая, либо новая версия.
    const tmp = `${abs}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
    return { ok: true, path: rel };
  },
};

/**
 * Листинг директории. Возвращает массив имён (без рекурсии — для
 * рекурсивного обхода модель пусть звёт `kb.list` повторно или
 * использует `kb.grep`). Каждое имя помечено флагом `isDirectory`.
 */
export const kbListTool: ToolDefinition<{ path: string }> = {
  name: 'kb.list',
  description:
    'Перечислить содержимое директории в knowledge base (без рекурсии). ' +
    'Возвращает { entries: [{ name, isDirectory }] }. ' +
    'Если директории нет — { entries: [] } (не ошибка).',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Относительный путь от .agents/knowledge/. Пустая строка = корень.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async ({ path: rel }) => {
    const abs = resolveKnowledgePath(rel);
    try {
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      return {
        entries: dirents.map((d) => ({
          name: d.name,
          isDirectory: d.isDirectory(),
        })),
      };
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return { entries: [] };
      }
      throw err;
    }
  },
};

/**
 * Поиск подстроки/regex по содержимому файлов в knowledge base.
 *
 * Реализация через рекурсивный обход + чтение файлов: ripgrep в
 * зависимости тащить избыточно (kb небольшая, на сотни файлов — это
 * миллисекунды). Регулярка компилируется один раз; ошибка компиляции
 * становится ошибкой тула — модель её увидит и поправит pattern.
 *
 * Бинарные файлы пропускаем по расширению (мы ждём только текст в kb,
 * но защита от случайного PDF в директории не помешает). Лимит на
 * число найденных совпадений — 100, чтобы случайно не подсунуть
 * модели гигантский результат.
 */
export const kbGrepTool: ToolDefinition<{ pattern: string; path?: string }> = {
  name: 'kb.grep',
  description:
    'Поиск подстроки/regex по содержимому файлов в knowledge base. ' +
    'Возвращает { matches: [{ path, line, text }] }, ограничено 100 совпадениями. ' +
    'pattern интерпретируется как JavaScript regex (без флагов; для case-insensitive используй "(?i)..." неподдерживается — пиши символьные классы).',
  schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        minLength: 1,
        description: 'JavaScript regex, как строка (без обрамляющих слешей).',
      },
      path: {
        type: 'string',
        description: 'Поддиректория для ограничения области поиска. По умолчанию — весь kb.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async ({ pattern, path: rel }) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new RunStorageError(`Невалидный regex: ${reason}`);
    }

    const root = rel ? resolveKnowledgePath(rel) : getKnowledgeRoot();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const MAX_MATCHES = 100;

    await walkAndGrep(root, getKnowledgeRoot(), regex, matches, MAX_MATCHES);

    return { matches };
  },
};

/**
 * Все базовые kb-тулы одним массивом — удобно подключать в реестр
 * целиком (роль может потом отфильтровать ненужные, но сейчас все
 * роли используют весь набор).
 */
export const kbTools: ToolDefinition[] = [
  kbReadTool as ToolDefinition,
  kbWriteTool as ToolDefinition,
  kbListTool as ToolDefinition,
  kbGrepTool as ToolDefinition,
];

// ---------- private helpers ----------

/**
 * Type guard для NodeJS errno-ошибок. `instanceof Error` недостаточно —
 * нужно поле `code`, и оно есть только у системных ошибок fs.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Расширения, которые мы заведомо не читаем (бинарные/большие).
 * Список консервативный: kb по соглашению — markdown + json frontmatter.
 */
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
]);

/**
 * Рекурсивный обход + grep. `kbRoot` отдельным параметром — нужен
 * для построения относительных путей в результате (модель должна
 * получать пути от корня kb, а не от точки старта поиска).
 */
async function walkAndGrep(
  dir: string,
  kbRoot: string,
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
    const abs = path.join(dir, dirent.name);

    if (dirent.isDirectory()) {
      await walkAndGrep(abs, kbRoot, regex, out, limit);
      continue;
    }

    if (!dirent.isFile()) continue;
    if (SKIP_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;

    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      // Не смогли прочитать как utf8 — скорее всего, бинарный или
      // нет прав. Пропускаем, в лог не пишем (это ожидаемая ситуация).
      continue;
    }

    const relPath = path.relative(kbRoot, abs);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        out.push({ path: relPath, line: i + 1, text: lines[i] });
        if (out.length >= limit) return;
      }
    }
  }
}
