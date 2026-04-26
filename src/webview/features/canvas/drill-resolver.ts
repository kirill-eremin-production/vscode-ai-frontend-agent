import type { RunMeta, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Чистая функция: для роли на канвасе выбирает сессию, в которую
 * должен «провалиться» drill-in по клику на кубик (#0026).
 *
 * Ключевое отличие от `selectActiveSessionForRole` — критерий **owner**
 * (а не просто participant). Иначе клик по продакту в hybrid-ране открыл
 * бы bridge product↔architect (где продакт тоже формально присутствует
 * в `participants`), а пользователь ожидает «открыть чат именно этого
 * агента». Owner для bridge — это recipient handoff'а (роль, которой не
 * было в родительской сессии), для user-agent — единственный агент.
 *
 * Среди owned-сессий выбираем свежайшую live (running/awaiting_*),
 * иначе свежайшую любого статуса — то же правило, что и у
 * `selectActiveSessionForRole` для индикатора активности (#0024).
 *
 * Для user-кубика (только в hybrid'е) — bridge с user-участником,
 * свежайшая (там user реально «говорил»).
 */
export function resolveCubeDrillSession(role: Role, meta: RunMeta): string | undefined {
  const sessions = meta.sessions ?? [];
  if (role === 'user') {
    const bridges = sessions
      .filter(
        (s) => s.kind === 'agent-agent' && (s.participants ?? []).some((p) => p.kind === 'user')
      )
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return bridges[0]?.id;
  }
  const owned = sessions.filter((s) => isSessionOwnedBy(s, role, sessions));
  if (owned.length === 0) return undefined;
  const live = owned.filter(
    (s) =>
      s.status === 'running' || s.status === 'awaiting_user_input' || s.status === 'awaiting_human'
  );
  const pool = live.length > 0 ? live : owned;
  return [...pool].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]?.id;
}

/**
 * Принадлежит ли сессия роли как **владельцу** (а не просто участнику).
 *
 *  - user-agent / orphan: владелец — единственный (первый) агент.
 *  - agent-agent (bridge): владелец — recipient handoff'а, т.е. агент,
 *    которого НЕ было среди агентов родительской сессии. Если такого
 *    нет (родитель потерян или у bridge только один агент совпадающий
 *    с родителем) — fallback на последнего участника, тот же контракт,
 *    что и у `ownerRoleOfActiveSession` в `select-active-session.ts`.
 *  - сессии без агентов вовсе (только user) — никакая роль не владеет.
 */
export function isSessionOwnedBy(
  session: SessionSummary,
  role: Role,
  allSessions: SessionSummary[]
): boolean {
  const agents = (session.participants ?? [])
    .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
    .map((p) => p.role as Role);
  if (agents.length === 0) return false;
  if (session.kind === 'user-agent' || !session.parentSessionId) return agents[0] === role;
  const parent = allSessions.find((s) => s.id === session.parentSessionId);
  const parentRoles = new Set<Role>(
    (parent?.participants ?? [])
      .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
      .map((p) => p.role as Role)
  );
  const recipient = agents.find((r) => !parentRoles.has(r)) ?? agents[agents.length - 1];
  return recipient === role;
}
