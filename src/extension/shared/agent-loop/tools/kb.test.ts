import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kbGrepTool, kbListTool, kbReadTool, kbWriteTool } from './kb';
import { getKnowledgeRoot, RunStorageError } from '@ext/entities/run/storage';

/**
 * Unit-тесты базовых kb-тулов. Гоняем handler'ы напрямую (без agent-loop'а
 * и без валидатора): валидатор тестируется отдельно, а здесь нас интересуют
 * именно файловые сценарии.
 *
 * Каждый тест работает в уникальной поддиректории внутри knowledge-root,
 * чтобы не пересекаться с соседями. `__TEST_WORKSPACE__` уже создан
 * setup-файлом, ничего дополнительно мокать не нужно.
 */

/**
 * Уникальный префикс для теста — все пути внутри knowledge будут
 * относительно него. Возвращаем относительный (для тулов) и абсолютный
 * (для прямой проверки fs).
 */
function makeScope(): { rel: string; abs: string } {
  const rel = `kb-test-${crypto.randomUUID()}`;
  return { rel, abs: path.join(getKnowledgeRoot(), rel) };
}

const ctx = { runId: 'r', toolCallId: 'c' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kbWriteTool', () => {
  it('создаёт файл с переданным содержимым', async () => {
    const { rel, abs } = makeScope();
    const filePath = `${rel}/note.md`;
    const result = await kbWriteTool.handler({ path: filePath, content: '# hello' }, ctx);
    expect(result).toEqual({ ok: true, path: filePath });
    const onDisk = await fs.readFile(path.join(abs, 'note.md'), 'utf8');
    expect(onDisk).toBe('# hello');
  });

  it('создаёт промежуточные директории', async () => {
    const { rel } = makeScope();
    const filePath = `${rel}/deep/nested/dir/file.md`;
    await kbWriteTool.handler({ path: filePath, content: 'x' }, ctx);
    const onDisk = await fs.readFile(path.join(getKnowledgeRoot(), filePath), 'utf8');
    expect(onDisk).toBe('x');
  });

  it('атомарен: на диске нет .tmp после успешной записи', async () => {
    const { rel, abs } = makeScope();
    await kbWriteTool.handler({ path: `${rel}/atomic.md`, content: 'x' }, ctx);
    const entries = await fs.readdir(abs);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('перезаписывает существующий файл', async () => {
    const { rel } = makeScope();
    const filePath = `${rel}/over.md`;
    await kbWriteTool.handler({ path: filePath, content: 'v1' }, ctx);
    await kbWriteTool.handler({ path: filePath, content: 'v2' }, ctx);
    const onDisk = await fs.readFile(path.join(getKnowledgeRoot(), filePath), 'utf8');
    expect(onDisk).toBe('v2');
  });

  it('бросает RunStorageError при попытке выйти за пределы sandbox', async () => {
    await expect(kbWriteTool.handler({ path: '../escape.md', content: 'x' }, ctx)).rejects.toThrow(
      RunStorageError
    );
  });
});

describe('kbReadTool', () => {
  it('возвращает { exists: true, content } для существующего файла', async () => {
    const { rel } = makeScope();
    const filePath = `${rel}/r.md`;
    await kbWriteTool.handler({ path: filePath, content: 'данные' }, ctx);
    const result = await kbReadTool.handler({ path: filePath }, ctx);
    expect(result).toEqual({ exists: true, content: 'данные' });
  });

  it('возвращает { exists: false, content: null } если файла нет (а не throw)', async () => {
    const { rel } = makeScope();
    const result = await kbReadTool.handler({ path: `${rel}/no-such.md` }, ctx);
    expect(result).toEqual({ exists: false, content: null });
  });

  it('бросает RunStorageError при выходе за sandbox', async () => {
    await expect(kbReadTool.handler({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(
      RunStorageError
    );
  });
});

describe('kbListTool', () => {
  it('возвращает имена файлов и директорий с флагом isDirectory', async () => {
    const { rel } = makeScope();
    await kbWriteTool.handler({ path: `${rel}/a.md`, content: 'a' }, ctx);
    await kbWriteTool.handler({ path: `${rel}/sub/b.md`, content: 'b' }, ctx);
    const result = (await kbListTool.handler({ path: rel }, ctx)) as {
      entries: Array<{ name: string; isDirectory: boolean }>;
    };
    const byName = new Map(result.entries.map((entry) => [entry.name, entry.isDirectory]));
    expect(byName.get('a.md')).toBe(false);
    expect(byName.get('sub')).toBe(true);
  });

  it('возвращает { entries: [] } для несуществующей директории', async () => {
    const result = await kbListTool.handler({ path: `kb-test-${crypto.randomUUID()}` }, ctx);
    expect(result).toEqual({ entries: [] });
  });

  it('бросает RunStorageError при sandbox-нарушении', async () => {
    await expect(kbListTool.handler({ path: '../..' }, ctx)).rejects.toThrow(RunStorageError);
  });
});

describe('kbGrepTool', () => {
  it('находит совпадения и возвращает relative path + line + text', async () => {
    const { rel } = makeScope();
    await kbWriteTool.handler(
      { path: `${rel}/notes.md`, content: 'first line\nfind me here\nlast line' },
      ctx
    );
    const result = (await kbGrepTool.handler({ pattern: 'find me', path: rel }, ctx)) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].text).toBe('find me here');
    // Путь должен быть относительно knowledge root, не от scope.
    expect(result.matches[0].path).toBe(path.join(rel, 'notes.md'));
  });

  it('пропускает бинарные расширения (по списку SKIP)', async () => {
    const { rel, abs } = makeScope();
    await fs.mkdir(abs, { recursive: true });
    await fs.writeFile(path.join(abs, 'image.png'), 'fake-png-with-text', 'utf8');
    await fs.writeFile(path.join(abs, 'doc.md'), 'matching text', 'utf8');
    const result = (await kbGrepTool.handler({ pattern: 'text', path: rel }, ctx)) as {
      matches: Array<{ path: string }>;
    };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path.endsWith('doc.md')).toBe(true);
  });

  it('бросает RunStorageError при битом regex', async () => {
    await expect(kbGrepTool.handler({ pattern: '(?<unclosed' }, ctx)).rejects.toThrow(
      RunStorageError
    );
  });

  it('лимит совпадений — 100', async () => {
    const { rel, abs } = makeScope();
    await fs.mkdir(abs, { recursive: true });
    // 200 строк подходящих под pattern → должно отрезаться на 100.
    const lines = Array.from({ length: 200 }, (_, idx) => `line ${idx} match`).join('\n');
    await fs.writeFile(path.join(abs, 'big.md'), lines, 'utf8');
    const result = (await kbGrepTool.handler({ pattern: 'match', path: rel }, ctx)) as {
      matches: unknown[];
    };
    expect(result.matches).toHaveLength(100);
  });
});
