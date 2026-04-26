import * as path from 'node:path';
import { resolveKnowledgePath } from '@ext/entities/run/storage';
import { getRoleSchema, KnowledgeSchemaError, type KnowledgeRole } from './schema';

/**
 * Резолв пути файла в kb роли с проверкой схемы.
 *
 * Зачем отдельный хелпер поверх `resolveKnowledgePath`:
 *  - роль получает API в терминах «папка → файл», а не «строка относительно
 *    .agents/knowledge/». Это убирает целый класс ошибок (опечатка в имени
 *    папки = новая молчаливая директория);
 *  - схема (`KNOWLEDGE_SCHEMA`) проверяется здесь, а не размазана по
 *    каждому вызову `kb.write` в роли;
 *  - sandbox-проверка делегирована единственному месту в проекте
 *    (`resolveKnowledgePath`), не дублируется.
 *
 * Сами тулы `kb.*` (#0001) остаются общими: они работают с любым
 * путём внутри `.agents/knowledge/`. Это сознательно — schema это
 * политика роли, а не свойство хранилища (архитектор/программист
 * получат свои схемы в #0004+).
 */

export interface ResolveRolePathInput {
  /** Имя роли. Должно быть в `KNOWLEDGE_SCHEMA`. */
  readonly role: KnowledgeRole;
  /** Поддиректория внутри роли. Должна быть в `schema.subdirs`. */
  readonly subdir: string;
  /** Имя файла. Только markdown, без вложенных слешей. */
  readonly file: string;
}

export interface ResolvedRolePath {
  /** Абсолютный путь на диске (для fs-операций). */
  readonly absolutePath: string;
  /**
   * Относительный путь от `.agents/knowledge/` — именно его получает
   * `kb.write`/`kb.read` из аргументов модели. Хранится с прямыми
   * слешами независимо от ОС, чтобы не зависеть от Windows-путей в
   * tool_call'ах модели.
   */
  readonly knowledgeRelativePath: string;
}

/**
 * Проверить вход и вернуть пути. Кидает `KnowledgeSchemaError` на
 * нарушении схемы, `RunStorageError` — если попытка sandbox-побега
 * (через хитрое имя файла, см. ниже).
 */
export function resolveRolePath(input: ResolveRolePathInput): ResolvedRolePath {
  const schema = getRoleSchema(input.role);

  if (!schema.subdirs.has(input.subdir)) {
    const allowed = [...schema.subdirs].join(', ');
    throw new KnowledgeSchemaError(
      `Поддиректория "${input.subdir}" не разрешена в роли "${input.role}". Разрешены: ${allowed}`
    );
  }

  validateFileName(input.file);

  // Строим knowledge-relative путь руками через `/` — это контракт
  // тулов `kb.*`. На Windows path.join даст `\\`, что в JSON-логе
  // выглядит уродливо и плохо сравнивается между ОС.
  const knowledgeRelativePath = `${input.role}/${input.subdir}/${input.file}`;

  // Делегируем sandbox-проверку единственному месту проекта.
  // Если file как-то протащит `..` мимо validateFileName — здесь
  // поймаем (двойная защита намеренная: schema-слой про политику,
  // sandbox — про физическую границу).
  const absolutePath = resolveKnowledgePath(knowledgeRelativePath);

  return { absolutePath, knowledgeRelativePath };
}

/**
 * Проверка имени файла: только markdown, без сепараторов и `..`.
 *
 * Запрет на вложенные слеши — это не sandbox (sandbox делает
 * `resolveKnowledgePath`), а часть схемы: продакт обязан класть
 * файлы прямо в поддиректорию, без собственной иерархии. Если
 * понадобится вложенность — она появится как новая поддиректория
 * в `KNOWLEDGE_SCHEMA`, а не как «свободная» структура.
 */
function validateFileName(file: string): void {
  if (file.length === 0) {
    throw new KnowledgeSchemaError('Имя файла не может быть пустым');
  }
  if (file.includes('/') || file.includes(path.sep) || file === '.' || file === '..') {
    throw new KnowledgeSchemaError(
      `Имя файла "${file}" не должно содержать разделителей пути; вложенность задаётся через schema-поддиректории`
    );
  }
  if (file.startsWith('.')) {
    throw new KnowledgeSchemaError(
      `Имя файла "${file}" начинается с точки; скрытые файлы в kb запрещены`
    );
  }
  if (!file.toLowerCase().endsWith('.md')) {
    throw new KnowledgeSchemaError(
      `Имя файла "${file}" не markdown; в kb храним только *.md (см. issue #0002)`
    );
  }
}
