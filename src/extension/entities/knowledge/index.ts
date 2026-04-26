/**
 * Публичный API сущности knowledge — схема ролевых kb + резолв путей.
 * Барелл нужен, чтобы фичи (роли) импортировали из одного места и
 * не лезли вглубь модуля.
 */

export {
  KNOWLEDGE_SCHEMA,
  KnowledgeSchemaError,
  PRODUCT_SUBDIRS,
  getRoleSchema,
  type KnowledgeRole,
  type ProductSubdir,
  type RoleSchema,
} from './schema';
export { resolveRolePath, type ResolveRolePathInput, type ResolvedRolePath } from './path';
export { PRODUCT_KB_README_MARKDOWN } from './product-readme';
