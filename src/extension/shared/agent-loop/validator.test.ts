import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import { _resetValidatorCache, validateToolArgs } from './validator';
import type { ToolDefinition } from './types';

/**
 * Unit-тесты валидатора аргументов тула.
 *
 * Проверяем:
 *  - валидные аргументы возвращают `{ ok: true }`;
 *  - невалидные дают `{ ok: false, error }` с человеко-читаемой ошибкой;
 *  - битый JSON в `rawArgs` отлавливается отдельно от ошибки schema;
 *  - схема компилируется один раз на тул (кеш по имени).
 */

/**
 * Минимальный тестовый тул. Имя — критично: именно по нему ключуется
 * кеш скомпилированных схем.
 */
function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: 'test',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        count: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async () => ({}),
  };
}

afterEach(() => {
  _resetValidatorCache();
  vi.restoreAllMocks();
});

describe('validateToolArgs', () => {
  it('пропускает валидные аргументы', () => {
    const result = validateToolArgs(makeTool('t1'), JSON.stringify({ path: 'x.md' }));
    expect(result).toEqual({ ok: true, args: { path: 'x.md' } });
  });

  it('пустую строку трактует как `{}` — для тулов без аргументов', () => {
    const tool: ToolDefinition = {
      name: 'no-args',
      description: '',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({}),
    };
    const result = validateToolArgs(tool, '   ');
    expect(result.ok).toBe(true);
  });

  it('даёт `{ ok: false, error }` при отсутствии required-поля', () => {
    const result = validateToolArgs(makeTool('t2'), JSON.stringify({ count: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/path/);
    }
  });

  it('даёт `{ ok: false, error }` при битом JSON', () => {
    const result = validateToolArgs(makeTool('t3'), '{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON/);
    }
  });

  it('даёт `{ ok: false, error }` при лишних полях (additionalProperties=false)', () => {
    const result = validateToolArgs(makeTool('t4'), JSON.stringify({ path: 'x', extra: 1 }));
    expect(result.ok).toBe(false);
  });

  it('кеширует скомпилированную функцию по имени тула', () => {
    const compileSpy = vi.spyOn(Ajv.prototype, 'compile');
    const tool = makeTool('cached');

    validateToolArgs(tool, JSON.stringify({ path: 'a' }));
    validateToolArgs(tool, JSON.stringify({ path: 'b' }));
    validateToolArgs(tool, JSON.stringify({ path: 'c' }));

    // ajv.compile должен быть вызван ровно один раз для имени `cached`.
    // Если вызовов больше — кеш сломан, и мы регрессируем по производительности.
    expect(compileSpy).toHaveBeenCalledTimes(1);
  });

  it('кеширует независимо для разных тулов', () => {
    const compileSpy = vi.spyOn(Ajv.prototype, 'compile');
    validateToolArgs(makeTool('alpha'), JSON.stringify({ path: 'a' }));
    validateToolArgs(makeTool('beta'), JSON.stringify({ path: 'b' }));
    expect(compileSpy).toHaveBeenCalledTimes(2);
  });
});
