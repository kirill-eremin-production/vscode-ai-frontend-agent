import type { Role } from '@shared/ui';

/**
 * Иерархия ролей агентов команды для canvas (#0042).
 *
 * Дублирует `HIERARCHY`/`levelOf` из
 * [src/extension/team/hierarchy.ts](../../../extension/team/hierarchy.ts):
 * webview не может импортировать константы extension'а напрямую (ESLint
 * boundary, иначе Node-код утечёт в браузерный бандл — см. AGENT.md).
 * При добавлении новой роли правка в обоих местах синхронно — TS не
 * поймает рассинхрон, поэтому держим список коротким и явно напоминаем
 * комментарием.
 *
 * `User` в иерархию не входит: он внешний source of input, а не агент
 * команды. Кубик user'а на canvas (#0043) рисуется отдельно над иерархией.
 */
export const HIERARCHY: readonly Exclude<Role, 'user' | 'system'>[] = [
  'product',
  'architect',
  'programmer',
];

/**
 * Все роли иерархии (без `user`/`system`) — для защиты типа `levelOf`
 * от случайной передачи `'user'`. Возвращает индекс `role` в `HIERARCHY`.
 *
 * Бросает явной ошибкой, если роль не входит в иерархию: позволяет
 * поймать баг в момент возникновения, а не маскировать невалидным
 * сравнением уровней дальше по потоку.
 */
export type HierarchyRole = (typeof HIERARCHY)[number];

export function levelOf(role: HierarchyRole): number {
  const index = HIERARCHY.indexOf(role);
  if (index < 0) {
    throw new Error(`levelOf: роль "${role}" не входит в иерархию [${HIERARCHY.join(', ')}]`);
  }
  return index;
}

/** Тайпгард для роли из иерархии — отсекает `user`/`system`. */
export function isHierarchyRole(role: Role): role is HierarchyRole {
  return (HIERARCHY as readonly Role[]).includes(role);
}
