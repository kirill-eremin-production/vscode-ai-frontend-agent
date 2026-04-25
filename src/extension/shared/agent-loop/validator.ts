import Ajv, { type ValidateFunction } from 'ajv';
import type { ToolDefinition } from './types';

/**
 * Тонкая обёртка над ajv. Кэширует скомпилированные валидаторы по
 * имени тула — компиляция schema стоит дороже, чем валидация, и в
 * рамках одного рана одна и та же schema валидируется многократно.
 *
 * `allErrors: true` — собираем все ошибки, а не только первую: модель
 * получит более полезный фидбек и сможет починить сразу несколько
 * полей за одну итерацию.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Кэш скомпилированных функций валидации по имени тула. */
const validatorCache = new Map<string, ValidateFunction>();

/** Очистить кэш — нужен только в тестах, чтобы не мешали состояния прошлого прогона. */
export function _resetValidatorCache(): void {
  validatorCache.clear();
}

/**
 * Достать (и при необходимости скомпилировать) валидатор для тула.
 * Промахи кэша случаются один раз на тул на сессию VS Code.
 */
function getValidator(tool: ToolDefinition): ValidateFunction {
  const cached = validatorCache.get(tool.name);
  if (cached) return cached;
  const compiled = ajv.compile(tool.schema);
  validatorCache.set(tool.name, compiled);
  return compiled;
}

/**
 * Результат валидации. Дискриминированный union, чтобы вызывающий
 * код был обязан явно ветвиться (TypeScript без exhaustive-check
 * не пропустит «забыл обработать ошибку»).
 */
export type ValidationResult = { ok: true; args: unknown } | { ok: false; error: string };

/**
 * Распарсить JSON-строку аргументов (как её прислал OpenRouter в
 * `tool_calls[i].function.arguments`) и провалидировать по schema тула.
 *
 * Любая ошибка (битый JSON, schema mismatch) превращается в человеко-
 * читаемое сообщение, которое потом попадёт модели в `tool_result.error`.
 * Модель должна уметь это прочитать и попробовать ещё раз.
 */
export function validateToolArgs(tool: ToolDefinition, rawArgs: string): ValidationResult {
  let parsed: unknown;
  try {
    // Пустая строка валидна для тулов без аргументов: трактуем как `{}`.
    parsed = rawArgs.trim().length === 0 ? {} : JSON.parse(rawArgs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    return { ok: false, error: `Аргументы не парсятся как JSON: ${reason}` };
  }

  const validate = getValidator(tool);
  if (validate(parsed)) {
    return { ok: true, args: parsed };
  }

  // Собираем все ошибки в одну строку — модели проще прочитать одно
  // сообщение, чем массив объектов. Формат ajv: `instancePath message`.
  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .join('; ');
  return { ok: false, error: `Аргументы не прошли валидацию: ${errors}` };
}
