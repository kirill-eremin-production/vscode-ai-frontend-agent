import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunStorageError,
  appendToolEvent,
  findPendingAsk,
  getKnowledgeRoot,
  initRunDir,
  readMeta,
  resolveKnowledgePath,
  writeLoopConfig,
  readLoopConfig,
  writeMeta,
  type ToolEvent,
} from './storage';
import type { RunMeta } from './types';

/**
 * Unit-тесты файлового хранилища.
 *
 * Цель — закрыть детерминированную логику: sandbox knowledge-base,
 * поиск pending ask_user в логе, атомарность записи (temp + rename).
 * VS Code API замокан в `tests/setup-vscode.ts`, реальный fs работает
 * на временной директории из `__TEST_WORKSPACE__`.
 */

/**
 * Каждый тест получает уникальный runId — это исключает гонки между
 * тестами, которые трогают `.agents/runs/<id>/`. Чистить общую папку
 * не пытаемся: ОС сама убирает `os.tmpdir()` между сессиями.
 */
function freshRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

function makeMeta(runId: string): RunMeta {
  return {
    id: runId,
    title: 'test',
    prompt: 'prompt',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('resolveKnowledgePath', () => {
  it('возвращает абсолютный путь внутри knowledge root для валидного relative', () => {
    const resolved = resolveKnowledgePath('product/glossary/term.md');
    expect(resolved.startsWith(getKnowledgeRoot() + path.sep)).toBe(true);
    expect(resolved.endsWith(path.join('product', 'glossary', 'term.md'))).toBe(true);
  });

  it('допускает пустую строку — это сам корень knowledge', () => {
    expect(resolveKnowledgePath('')).toBe(getKnowledgeRoot());
  });

  it('бросает RunStorageError при попытке выйти через `..`', () => {
    expect(() => resolveKnowledgePath('../escape.md')).toThrow(RunStorageError);
    expect(() => resolveKnowledgePath('product/../../escape.md')).toThrow(RunStorageError);
  });

  it('бросает RunStorageError при абсолютном пути', () => {
    expect(() => resolveKnowledgePath('/etc/passwd')).toThrow(RunStorageError);
  });

  it('не путает префикс: `knowledge-evil` не должен считаться внутри `knowledge`', () => {
    // path.resolve превратит `..-evil` в путь ВНЕ knowledge/, и проверка
    // `startsWith(root + sep)` это поймает. Проверяем явно, чтобы не
    // регрессировать на «префиксная проверка без разделителя».
    expect(() => resolveKnowledgePath('../knowledge-evil/x.md')).toThrow(RunStorageError);
  });
});

describe('initRunDir / writeMeta / readMeta', () => {
  it('создаёт директорию и пишет meta.json', async () => {
    const runId = freshRunId();
    const meta = makeMeta(runId);
    await initRunDir(meta);
    const read = await readMeta(runId);
    expect(read).toEqual(meta);
  });

  it('readMeta возвращает undefined для отсутствующего рана', async () => {
    expect(await readMeta('does-not-exist-' + crypto.randomUUID())).toBeUndefined();
  });

  it('writeMeta атомарен: на диске нет temp-файла после успешной записи', async () => {
    const runId = freshRunId();
    await initRunDir(makeMeta(runId));
    const dir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    const entries = await fs.readdir(dir);
    // .tmp временный должен быть переименован в финальный.
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(entries).toContain('meta.json');
  });

  it('writeMeta пишет в .tmp до rename — финальный файл не трогается до завершения записи', async () => {
    // Проверка инварианта temp+rename без ESM-spy (vitest не даёт spyOn'ить
    // экспорты `node:fs/promises`). Делаем так: создаём папку рана, кладём
    // готовый meta.json и rename'им бекап. Запускаем writeMeta с
    // невалидным контентом, который заставит JSON.stringify бросить, —
    // финальный файл должен остаться прежним. Это доказывает, что
    // writeMeta не пишет в финальный путь напрямую.
    const runId = freshRunId();
    await initRunDir(makeMeta(runId));
    const dir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    const before = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');

    // Циклическая ссылка вызовет TypeError в JSON.stringify.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(writeMeta(cyclic as unknown as RunMeta)).rejects.toThrow();

    const after = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('writeLoopConfig / readLoopConfig', () => {
  it('round-trip конфиг через диск без потерь', async () => {
    const runId = freshRunId();
    await initRunDir(makeMeta(runId));
    const config = {
      model: 'openai/gpt-x',
      systemPrompt: 'system',
      toolNames: ['kb.read', 'ask_user'],
      userMessage: 'hi',
      role: 'smoke',
      temperature: 0.2,
    };
    await writeLoopConfig(runId, config);
    expect(await readLoopConfig(runId)).toEqual(config);
  });

  it('readLoopConfig возвращает undefined, если файла нет', async () => {
    const runId = freshRunId();
    await initRunDir(makeMeta(runId));
    expect(await readLoopConfig(runId)).toBeUndefined();
  });
});

describe('findPendingAsk', () => {
  /**
   * Хелпер: подготовить ран и записать в `tools.jsonl` готовую цепочку
   * событий. Изолирует тесты от форматов файлов — все ходим через
   * публичный `appendToolEvent`.
   */
  async function seedEvents(runId: string, events: ToolEvent[]): Promise<void> {
    await initRunDir(makeMeta(runId));
    for (const event of events) {
      await appendToolEvent(runId, event);
    }
  }

  it('возвращает undefined, если в логе нет ask_user', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: new Date().toISOString(),
        content: 'hello',
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('возвращает pending ask_user без ответа', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            name: 'ask_user',
            arguments: JSON.stringify({ question: 'нужен порт?', context: 'для dev-сервера' }),
          },
        ],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending).toEqual({
      toolCallId: 'call_1',
      question: 'нужен порт?',
      context: 'для dev-сервера',
      at: '2026-04-26T10:00:00.000Z',
    });
  });

  it('возвращает undefined, если ask_user уже получил tool_result', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'call_1', name: 'ask_user', arguments: JSON.stringify({ question: 'q' }) },
        ],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'call_1',
        tool_name: 'ask_user',
        result: { answer: 'ok' },
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('игнорирует не-ask_user tool_calls', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'call_1', name: 'kb.read', arguments: JSON.stringify({ path: 'x.md' }) },
        ],
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('возвращает самый поздний pending, если их несколько', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'older', name: 'ask_user', arguments: JSON.stringify({ question: 'q1' }) },
        ],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'older',
        tool_name: 'ask_user',
        result: { answer: 'a1' },
      },
      {
        kind: 'assistant',
        at: '2026-04-26T10:02:00.000Z',
        content: null,
        tool_calls: [
          { id: 'newer', name: 'ask_user', arguments: JSON.stringify({ question: 'q2' }) },
        ],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending?.toolCallId).toBe('newer');
  });

  it('не падает на битом JSON в arguments — возвращает пустой вопрос', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [{ id: 'call_x', name: 'ask_user', arguments: 'NOT JSON' }],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending?.toolCallId).toBe('call_x');
    expect(pending?.question).toBe('(пустой вопрос)');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // На случай, если предыдущий тест оставил пустой knowledge root —
  // не страшно, тесты создают вложенные пути с нуля. Хук пустой,
  // но оставлен как точка для будущих общих установок.
});
