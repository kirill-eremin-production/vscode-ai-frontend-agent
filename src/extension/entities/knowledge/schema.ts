/**
 * Схема knowledge base для ролей агентов.
 *
 * Каждая роль (продакт, архитектор, программист…) получает свою
 * поддиректорию в `.agents/knowledge/<role>/` с **жёстко заданным
 * набором поддиректорий**. Это нужно, чтобы:
 *
 *  - модель не раскладывала файлы как попало (нет «общей» помойки);
 *  - человек, открыв `.agents/knowledge/product/`, по структуре
 *    сразу понимал, где искать что;
 *  - `kb.grep` мог давать модели полезные подсказки через путь
 *    (`decisions/...` ≠ `glossary/...`), а не только через содержимое.
 *
 * Сейчас формализована только роль `product` (см. issue #0002).
 * Архитектор/программист появятся в #0004 и далее со своей схемой —
 * добавляются в `KNOWLEDGE_SCHEMA` и в тип `KnowledgeRole`.
 *
 * Принципиально: cross-role чтение пока не разрешаем (sandbox каждой
 * роли — её поддиректория). Если когда-нибудь понадобится, обсуждаем
 * отдельно — изоляция упрощает понимание и проверку.
 */

/** Имена ролей, у которых есть собственная kb. */
export type KnowledgeRole = 'product' | 'architect' | 'programmer';

/**
 * Описание схемы одной роли. `subdirs` — закрытое множество имён
 * поддиректорий: попытка положить файл в любую другую — ошибка
 * валидации (а не молчаливое создание «свободной» папки).
 */
export interface RoleSchema {
  readonly role: KnowledgeRole;
  readonly subdirs: ReadonlySet<string>;
}

/**
 * Поддиректории продактовой kb. Соответствуют acceptance criteria
 * из issue #0002:
 *
 *  - `glossary/` — определения продуктовых терминов;
 *  - `personas/` — целевые пользователи;
 *  - `decisions/` — продуктовые решения с датой (ADR);
 *  - `features/` — описания фич/областей продукта;
 *  - `questions/` — открытые вопросы (закрытый вопрос переезжает
 *    в `decisions/` или `features/`, а не удаляется).
 *
 * Список намеренно фиксированный — расширяем кодом, а не «по факту»
 * через write в новую папку. Это делает структуру предсказуемой
 * как для роли, так и для человека.
 */
export const PRODUCT_SUBDIRS = [
  'glossary',
  'personas',
  'decisions',
  'features',
  'questions',
] as const;

export type ProductSubdir = (typeof PRODUCT_SUBDIRS)[number];

/**
 * Поддиректории kb архитектора (issue #0004). Параллельная продактовой
 * структуре: четыре «жанра» знания, по которым модель и человек
 * раскладывают артефакты. README с описанием — в [architect-readme](./architect-readme.ts).
 */
export const ARCHITECT_SUBDIRS = ['modules', 'decisions', 'patterns', 'risks'] as const;

export type ArchitectSubdir = (typeof ARCHITECT_SUBDIRS)[number];

/**
 * Поддиректории kb программиста (issue #0027). Три «жанра» знания
 * реализатора: устоявшиеся паттерны кодовой базы, реализационные
 * решения по ходу ранов, и грабли (флаки тесты, странности тулинга).
 * README с описанием — в [programmer-readme](./programmer-readme.ts).
 */
export const PROGRAMMER_SUBDIRS = ['patterns', 'decisions', 'gotchas'] as const;

export type ProgrammerSubdir = (typeof PROGRAMMER_SUBDIRS)[number];

/**
 * Реестр схем по ролям. Используется `resolveRolePath` для проверки
 * входов и теми ролями, кому нужно перечислить свои поддиректории
 * (например, при инициализации README).
 */
export const KNOWLEDGE_SCHEMA: Record<KnowledgeRole, RoleSchema> = {
  product: {
    role: 'product',
    subdirs: new Set<string>(PRODUCT_SUBDIRS),
  },
  architect: {
    role: 'architect',
    subdirs: new Set<string>(ARCHITECT_SUBDIRS),
  },
  programmer: {
    role: 'programmer',
    subdirs: new Set<string>(PROGRAMMER_SUBDIRS),
  },
};

/**
 * Получить схему роли. Вынесено в функцию (а не прямой доступ к
 * `KNOWLEDGE_SCHEMA[role]`) ради явной ошибки на неизвестной роли —
 * TS-проверка ловит большинство случаев, но строки приходят и из
 * рантайма (имена файлов, аргументы тулов в будущем).
 */
export function getRoleSchema(role: string): RoleSchema {
  const schema = (KNOWLEDGE_SCHEMA as Record<string, RoleSchema | undefined>)[role];
  if (!schema) {
    const known = Object.keys(KNOWLEDGE_SCHEMA).join(', ');
    throw new KnowledgeSchemaError(
      `Неизвестная роль knowledge base: "${role}". Известные роли: ${known}`
    );
  }
  return schema;
}

/**
 * Кастомная ошибка валидации схемы. Отдельный тип нужен, чтобы
 * вызывающий код мог отличить «нарушение схемы» от случайных
 * fs-ошибок и показать модели/пользователю понятное сообщение.
 */
export class KnowledgeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeSchemaError';
  }
}
