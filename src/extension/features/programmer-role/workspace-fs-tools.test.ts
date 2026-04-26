import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspaceFsTools, __test__ } from './workspace-fs-tools';

/**
 * Юнит-тест критически важного для безопасности модуля (issue #0027):
 * sandbox workspace, deny-list записи, симлинк-эскейп, атомарность.
 *
 * Каждый тест работает в своём изолированном temp-workspace'е (а не
 * через общий __TEST_WORKSPACE__), потому что:
 *  - тесты пишут файлы и иногда корректные, и иногда внутрь deny-list'а;
 *  - симлинк-тест требует чистого корня без чужих файлов;
 *  - параллельность vitest'а на одной папке привела бы к гонкам.
 *
 * Все тесты собираются через `buildWorkspaceFsTools(root)` с явным root
 * — именно так делает прод (`runProgrammer`), и так корректно работает
 * resolveWorkspacePath без vscode-зависимости.
 */

interface RecordedToolEvent {
  kind: string;
  message?: string;
}

const recordedEvents: RecordedToolEvent[] = [];

vi.mock('@ext/features/run-management/broadcast', () => {
  return {
    recordToolEvent: vi.fn(async (_runId: string, event: { kind: string; message?: string }) => {
      recordedEvents.push({ kind: event.kind, message: event.message });
    }),
    broadcast: vi.fn(),
  };
});

const HANDLER_CONTEXT = { runId: 'test-run', toolCallId: 'test-call' };

let workspaceRoot: string;

function getTool(name: string) {
  const tool = buildWorkspaceFsTools(workspaceRoot).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

beforeEach(async () => {
  recordedEvents.length = 0;
  workspaceRoot = path.join(os.tmpdir(), `programmer-fs-${crypto.randomUUID()}`);
  await fs.mkdir(workspaceRoot, { recursive: true });
  // realpath нормализует /var → /private/var на macOS — храним уже
  // нормализованный путь, иначе sandbox-проверки решат, что внутренние
  // файлы «снаружи» из-за разной формы пути.
  workspaceRoot = await fs.realpath(workspaceRoot);
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('isWriteDenied — единая точка проверки deny-list', () => {
  it('блокирует запись в .git/HEAD', () => {
    const result = __test__.isWriteDenied('.git/HEAD');
    expect(result.denied).toBe(true);
  });

  it('блокирует запись в node_modules/foo/index.js', () => {
    const result = __test__.isWriteDenied('node_modules/foo/index.js');
    expect(result.denied).toBe(true);
  });

  it('блокирует запись в .agents/runs/...', () => {
    const result = __test__.isWriteDenied('.agents/runs/abc/meta.json');
    expect(result.denied).toBe(true);
  });

  it('блокирует *.lock и *.log', () => {
    expect(__test__.isWriteDenied('package-lock.json').denied).toBe(false); // не .lock!
    expect(__test__.isWriteDenied('foo.lock').denied).toBe(true);
    expect(__test__.isWriteDenied('logs/app.log').denied).toBe(true);
  });

  it('разрешает обычный исходник', () => {
    expect(__test__.isWriteDenied('src/utils/date.ts').denied).toBe(false);
  });
});

describe('resolveWorkspacePath — sandbox', () => {
  it('отклоняет относительный путь с .., указывающий наружу', async () => {
    await expect(
      __test__.resolveWorkspacePath(workspaceRoot, '../etc/passwd')
    ).rejects.toBeInstanceOf(__test__.WorkspaceSandboxEscapeError);
  });

  it('отклоняет абсолютный путь снаружи workspace', async () => {
    await expect(
      __test__.resolveWorkspacePath(workspaceRoot, '/etc/passwd')
    ).rejects.toBeInstanceOf(__test__.WorkspaceSandboxEscapeError);
  });

  it('отклоняет путь, проходящий через симлинк наружу', async () => {
    // Создаём cel-target снаружи и симлинк escape -> цель.
    const outsideDir = path.join(os.tmpdir(), `programmer-outside-${crypto.randomUUID()}`);
    await fs.mkdir(outsideDir, { recursive: true });
    try {
      const linkPath = path.join(workspaceRoot, 'escape');
      await fs.symlink(outsideDir, linkPath);
      await expect(
        __test__.resolveWorkspacePath(workspaceRoot, 'escape/passwd')
      ).rejects.toBeInstanceOf(__test__.WorkspaceSandboxEscapeError);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('пропускает корректный путь внутри workspace', async () => {
    const resolved = await __test__.resolveWorkspacePath(workspaceRoot, 'src/utils/date.ts');
    expect(resolved).toBe(path.join(workspaceRoot, 'src', 'utils', 'date.ts'));
  });
});

describe('fs.write — happy path и deny-list', () => {
  it('пишет файл атомарно (temp + rename) и логирует system-событие', async () => {
    const write = getTool('fs.write');
    const result = await write.handler(
      { path: 'src/utils/date.ts', content: 'export const x = 1;\n' },
      HANDLER_CONTEXT
    );
    expect(result).toMatchObject({ ok: true, path: 'src/utils/date.ts' });
    const written = await fs.readFile(path.join(workspaceRoot, 'src/utils/date.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');
    // tmp-файла после атомарного rename не должно остаться
    expect(fsSync.existsSync(path.join(workspaceRoot, 'src/utils/date.ts.tmp'))).toBe(false);
    expect(
      recordedEvents.some((e) => e.kind === 'system' && e.message?.includes('[fs.write]'))
    ).toBe(true);
  });

  it('отклоняет запись в .git/HEAD ошибкой (без sandbox-escape)', async () => {
    const write = getTool('fs.write');
    await expect(
      write.handler({ path: '.git/HEAD', content: 'x' }, HANDLER_CONTEXT)
    ).rejects.toThrow();
    // Файл не должен быть создан
    expect(fsSync.existsSync(path.join(workspaceRoot, '.git/HEAD'))).toBe(false);
  });

  it('отклоняет запись в node_modules/foo', async () => {
    const write = getTool('fs.write');
    await expect(
      write.handler({ path: 'node_modules/foo/index.js', content: 'x' }, HANDLER_CONTEXT)
    ).rejects.toThrow();
  });

  it('логирует sandbox-escape отдельным маркером при попытке выйти через ..', async () => {
    const write = getTool('fs.write');
    await expect(
      write.handler({ path: '../etc/passwd', content: 'x' }, HANDLER_CONTEXT)
    ).rejects.toBeInstanceOf(__test__.WorkspaceSandboxEscapeError);
    expect(
      recordedEvents.some((e) => e.kind === 'system' && e.message?.startsWith('[sandbox-escape]'))
    ).toBe(true);
  });

  it('логирует sandbox-escape при попытке абсолютного пути снаружи', async () => {
    const write = getTool('fs.write');
    await expect(
      write.handler({ path: '/etc/passwd', content: 'x' }, HANDLER_CONTEXT)
    ).rejects.toBeInstanceOf(__test__.WorkspaceSandboxEscapeError);
    expect(
      recordedEvents.some((e) => e.kind === 'system' && e.message?.startsWith('[sandbox-escape]'))
    ).toBe(true);
  });
});

describe('fs.read — happy path', () => {
  it('возвращает { exists: true, content } для существующего файла', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src/a.ts'), 'hello', 'utf8');
    const read = getTool('fs.read');
    const result = await read.handler({ path: 'src/a.ts' }, HANDLER_CONTEXT);
    expect(result).toEqual({ exists: true, content: 'hello' });
  });

  it('возвращает { exists: false, content: null } для отсутствующего файла', async () => {
    const read = getTool('fs.read');
    const result = await read.handler({ path: 'nope.ts' }, HANDLER_CONTEXT);
    expect(result).toEqual({ exists: false, content: null });
  });
});

describe('fs.list', () => {
  it('перечисляет файлы и директории', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'x');
    const list = getTool('fs.list');
    const result = (await list.handler({ path: '' }, HANDLER_CONTEXT)) as {
      entries: Array<{ name: string; isDirectory: boolean }>;
    };
    const byName = new Map(result.entries.map((e) => [e.name, e.isDirectory]));
    expect(byName.get('a.txt')).toBe(false);
    expect(byName.get('src')).toBe(true);
  });
});
