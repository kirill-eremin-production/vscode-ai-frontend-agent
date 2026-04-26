import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildRoleScopedKbTools } from './role-kb-tools';

/**
 * Юнит-тест ключевого инварианта роли: модель пишет относительные
 * к роли пути (`decisions/foo.md`), а под капотом всё резолвится в
 * `<role>/decisions/foo.md`. Если этот контракт сломается — продакт
 * начнёт писать в чужие kb-роли (или в корень knowledge), и sandbox-
 * гарантия issue #0003 рассыплется.
 *
 * Проверяем поведение на настоящем fs (через `__TEST_WORKSPACE__`,
 * см. `tests/setup-vscode.ts`) — это и есть то, что увидит модель в
 * проде. Моки тут только запутают.
 */

function getTool(name: string) {
  const tool = buildRoleScopedKbTools('product').find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in role-scoped registry`);
  return tool;
}

const HANDLER_CONTEXT = { runId: 'test-run', toolCallId: 'test-call' };

describe('buildRoleScopedKbTools — sandbox продактовой kb', () => {
  it('kb.write кладёт файл под product/<path>, а не под голый <path>', async () => {
    const write = getTool('kb.write');

    // Модель якобы вызывает kb.write({ path: "decisions/...", content }).
    await write.handler(
      { path: 'decisions/scope-test.md', content: '# scope test' },
      HANDLER_CONTEXT
    );

    // Файл должен оказаться в .agents/knowledge/product/decisions/...,
    // а не в .agents/knowledge/decisions/... (это бы значило, что
    // обёртка не сработала).
    const expected = path.join(
      globalThis.__TEST_WORKSPACE__,
      '.agents',
      'knowledge',
      'product',
      'decisions',
      'scope-test.md'
    );
    const content = await fs.readFile(expected, 'utf8');
    expect(content).toBe('# scope test');

    // Дополнительно убеждаемся: «голый» путь без префикса роли НЕ
    // создан. Это страховка от ситуации, когда обёртка по ошибке
    // дублирует запись в обе локации.
    const wrongPath = path.join(
      globalThis.__TEST_WORKSPACE__,
      '.agents',
      'knowledge',
      'decisions',
      'scope-test.md'
    );
    await expect(fs.access(wrongPath)).rejects.toThrow();
  });

  it('kb.read получает файл, записанный самой ролью (round-trip через обёртку)', async () => {
    const write = getTool('kb.write');
    const read = getTool('kb.read');

    await write.handler(
      { path: 'features/round-trip.md', content: 'persisted by role' },
      HANDLER_CONTEXT
    );

    const result = (await read.handler({ path: 'features/round-trip.md' }, HANDLER_CONTEXT)) as {
      exists: boolean;
      content: string | null;
    };

    expect(result.exists).toBe(true);
    expect(result.content).toBe('persisted by role');
  });

  it('kb.list с пустым path показывает корень kb роли (поддиректории product/), а не корень knowledge', async () => {
    const write = getTool('kb.write');
    const list = getTool('kb.list');

    // Готовим файлы в двух поддиректориях продакта.
    await write.handler({ path: 'glossary/term-a.md', content: 'a' }, HANDLER_CONTEXT);
    await write.handler({ path: 'personas/user-b.md', content: 'b' }, HANDLER_CONTEXT);

    // Без обёртки kb.list({ path: "" }) показал бы корень knowledge —
    // там бы лежала папка product/. С обёрткой — мы видим именно
    // содержимое product/, то есть свои поддиректории.
    const result = (await list.handler({ path: '' }, HANDLER_CONTEXT)) as {
      entries: Array<{ name: string; isDirectory: boolean }>;
    };

    const dirNames = result.entries.filter((e) => e.isDirectory).map((e) => e.name);
    expect(dirNames).toContain('glossary');
    expect(dirNames).toContain('personas');
    // Никаких папок других ролей здесь быть не должно (а если бы
    // обёртка не работала, мы бы увидели саму папку `product` —
    // это был бы явный знак бага).
    expect(dirNames).not.toContain('product');
  });

  it('kb.grep с пустым path ищет только внутри kb роли', async () => {
    const write = getTool('kb.write');
    const grep = getTool('kb.grep');

    await write.handler(
      { path: 'features/grep-target.md', content: 'UNIQUE_MARKER inside product' },
      HANDLER_CONTEXT
    );

    const result = (await grep.handler({ pattern: 'UNIQUE_MARKER' }, HANDLER_CONTEXT)) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(result.matches.length).toBeGreaterThan(0);
    // Путь в результате — относительно корня knowledge (контракт kb.grep);
    // но раз префикс `product/` обязателен, проверяем что он там есть.
    expect(result.matches[0].path.startsWith('product/')).toBe(true);
  });
});
