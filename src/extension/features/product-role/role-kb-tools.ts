import { kbReadTool, kbWriteTool, kbListTool, kbGrepTool } from '@ext/shared/agent-loop';
import type { ToolDefinition } from '@ext/shared/agent-loop';
import type { KnowledgeRole } from '@ext/entities/knowledge';

/**
 * Обёртка `kb.*`-тулов, прибивающая их sandbox к kb конкретной роли.
 *
 * Зачем не передавать «полный» путь моделью:
 *  - Модель не должна знать про существование других ролей. Если ей
 *    дать тул `kb.write` с любым путём внутри `.agents/knowledge/`,
 *    она при ошибке prompt'а может записать в `architect/...` —
 *    sandbox ловит «выход из knowledge», но не «вторжение в чужую роль».
 *  - Это и есть «sandbox `.agents/knowledge/product/`» из issue #0003:
 *    реализуется тут, не через хитрые проверки.
 *
 * Реализация: каждому тулу подменяем handler так, чтобы поле `path`
 * (для `kb.read`/`kb.write`/`kb.list`) или `path` (опциональный, для
 * `kb.grep`) дописывалось префиксом `<role>/`. Расположение схемы
 * (`KNOWLEDGE_SCHEMA`) и валидацию имён файлов на этом этапе НЕ
 * дублируем — для общих kb-тулов важна только sandbox-граница;
 * жёсткую schema будут использовать роли, когда захотят сами строить
 * пути через `resolveRolePath` (например, для записи `brief.md`-связанных
 * артефактов из своего сервиса).
 *
 * Description модели на тулах оставляем общий — но в system prompt'е
 * продакта (`product.prompt.ts`) явно указано: «pass paths relative
 * to your role». Чтобы не дублировать английский текст по двум местам,
 * имена и описания самих тулов не трогаем.
 */

/** Аргументы тулов с обязательным/опциональным `path`. */
type WithPath = { path: string };
type WithOptionalPath = { path?: string };

/** Тул `kb.write` дополнительно принимает `content`. */
type KbWriteArgs = WithPath & { content: string };

/** Тул `kb.grep` принимает `pattern` и опциональный `path`. */
type KbGrepArgs = { pattern: string } & WithOptionalPath;

/**
 * Префикснуть значение `path` ролью. Возвращает новый объект — оригинал
 * не мутируем (handler'ы могут получать args после schema-валидации,
 * которая создаёт новый объект; но мутацию на этом стыке всё равно
 * избегаем как принцип, дешевле в поддержке).
 */
function prefixPath(role: string, segment: string | undefined): string {
  // Пустой/undefined для kb.list/kb.grep означает «корень kb роли».
  if (!segment || segment.length === 0) return role;
  return `${role}/${segment}`;
}

/**
 * Обернуть `kb.read`/`kb.write`/`kb.list` (где path обязателен)
 * в role-scoped версию.
 */
function scopeRequiredPathTool<TArgs extends WithPath>(
  role: KnowledgeRole,
  tool: ToolDefinition<TArgs>
): ToolDefinition<TArgs> {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    handler: async (args, context) => {
      const scoped = { ...args, path: prefixPath(role, args.path) } as TArgs;
      return tool.handler(scoped, context);
    },
  };
}

/**
 * Обернуть `kb.grep` (path опциональный): если модель не задала
 * подпуть, ищем по всему kb роли, а не по всему knowledge base.
 */
function scopeOptionalPathTool(
  role: KnowledgeRole,
  tool: ToolDefinition<KbGrepArgs>
): ToolDefinition<KbGrepArgs> {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    handler: async (args, context) => {
      const scoped: KbGrepArgs = { ...args, path: prefixPath(role, args.path) };
      return tool.handler(scoped, context);
    },
  };
}

/**
 * Полный набор role-scoped kb-тулов. Имена тулов остаются прежние
 * (`kb.read` и т.п.) — модели прозрачно, что под капотом sandbox.
 */
export function buildRoleScopedKbTools(role: KnowledgeRole): ToolDefinition[] {
  return [
    scopeRequiredPathTool(role, kbReadTool) as ToolDefinition,
    scopeRequiredPathTool(role, kbWriteTool as ToolDefinition<KbWriteArgs>) as ToolDefinition,
    scopeRequiredPathTool(role, kbListTool) as ToolDefinition,
    scopeOptionalPathTool(role, kbGrepTool) as ToolDefinition,
  ];
}
