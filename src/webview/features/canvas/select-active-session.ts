import type { RunMeta, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Чистая функция: для роли на канвасе выбирает «её» сессию, чьим
 * статусом и tool-лентой описывается живая активность кубика (#0024).
 *
 * Правила (по приоритету):
 *  1. Сессия, где роль есть в `participants`, имеет статус
 *     `running` или `awaiting_*` — берём самую свежую по `updatedAt`.
 *     Это покрывает кейс «архитектор сейчас работает».
 *  2. Иначе — самая свежая сессия с этой ролью в `participants`
 *     (любого статуса). Покрывает «продакт уже сдал бриф, но кубик
 *     показывает «закончил»).
 *  3. Если роли нет ни в одной сессии — `undefined`. На канвасе это
 *     значит «нет данных», кубик показываем как idle с прочерком.
 */
export function selectActiveSessionForRole(meta: RunMeta, role: Role): SessionSummary | undefined {
  const sessions = meta.sessions ?? [];
  const ownsRole = (s: SessionSummary): boolean =>
    Boolean(s.participants?.some((p) => p.kind === 'agent' && p.role === role));
  const candidates = sessions.filter(ownsRole);
  if (candidates.length === 0) return undefined;

  const live = candidates.filter(
    (s) =>
      s.status === 'running' || s.status === 'awaiting_user_input' || s.status === 'awaiting_human'
  );
  const pool = live.length > 0 ? live : candidates;
  return [...pool].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

/**
 * Возвращает роль агента-владельца сессии — для kind='user-agent'
 * единственного агента, для kind='agent-agent' (bridge) приёмника
 * handoff'а (роли, которой не было в родительской сессии).
 *
 * Используется канвасом, чтобы понять, какая роль сейчас «активна»
 * на уровне рана: владелец активной сессии — единственный агент,
 * чей кубик может показывать живой спиннер; остальные — idle.
 */
export function ownerRoleOfActiveSession(meta: RunMeta): Role | undefined {
  const sessions = meta.sessions ?? [];
  const active = sessions.find((s) => s.id === meta.activeSessionId);
  if (!active) return undefined;
  const agents: Role[] = (active.participants ?? [])
    .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
    .map((p) => p.role as Role);
  if (agents.length === 0) return undefined;
  if (active.kind === 'user-agent' || !active.parentSessionId) return agents[0];
  const parent = sessions.find((s) => s.id === active.parentSessionId);
  const parentRoles = new Set<Role>(
    (parent?.participants ?? [])
      .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
      .map((p) => p.role as Role)
  );
  return agents.find((r) => !parentRoles.has(r)) ?? agents[agents.length - 1];
}
