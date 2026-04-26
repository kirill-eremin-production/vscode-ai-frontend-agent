import type { Participant, RunMeta, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Чистая функция layout'а канваса команды агентов (#0023).
 *
 * Вход — `RunMeta.sessions` со списком участников. Выход — список нод
 * (по одной на роль) и рёбер (handoff'ы между ролями + опциональная
 * связь user→agent для hybrid-сессий).
 *
 * Layered layout: корни — в первом столбце, каждое ребро смещает
 * приёмник на колонку вправо. Внутри колонки — вертикально по порядку
 * первого появления роли. Координаты считаются константами `COL_STEP_X`
 * × `ROW_STEP_Y`. Никакой force-directed-магии: у нас 2–4 кубика.
 *
 * Все идентификаторы ролей — `Role` (`product` | `architect` | `system` |
 * `user`). Неизвестные строки нормализуются в `system`, чтобы канвас не
 * падал, если придёт новая роль до обновления типов.
 */

export const COL_STEP_X = 240;
export const ROW_STEP_Y = 140;
export const NODE_W = 180;
export const NODE_H = 96;
export const PAD_X = 32;
export const PAD_Y = 32;

export interface CanvasNode {
  id: Role;
  role: Role;
  /** Левый-верхний угол кубика в viewBox-координатах. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Колонка/ряд layout'а — для отладки и тестов. */
  col: number;
  row: number;
  /** Время последней активности любой сессии этой роли (ISO). */
  lastActivityAt?: string;
}

export interface CanvasEdge {
  id: string;
  from: Role;
  to: Role;
  /** Подпись над ребром: «бриф», «план», «вмешательство». */
  label: string;
  /** Источник handoff'а: 'agent' = handoff между агентами, 'user' = вмешательство. */
  kind: 'handoff' | 'user';
  /**
   * Bridge-сессия, которую представляет ребро (#0026). Для drill-in:
   * клик по стрелке открывает чат именно этой сессии. Если рёбер с
   * одинаковой парой (from→to) несколько (повторные handoff'ы) — берём
   * последнюю (самую свежую): она обычно и есть «активная нитка» этой
   * связи. Поле опциональное только из-за обратной совместимости в типах,
   * на практике handoff/user-edge всегда привязаны к bridge.
   */
  bridgeSessionId?: string;
}

export interface CanvasLayout {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Размер всего полотна — для дефолтного viewBox. */
  width: number;
  height: number;
}

/** Поддерживаемые роли агентов; всё прочее → `system`. */
const KNOWN_ROLES = new Set<Role>(['product', 'architect', 'system', 'user']);

function normalizeRole(raw: string): Role {
  return KNOWN_ROLES.has(raw as Role) ? (raw as Role) : 'system';
}

function rolesOf(session: SessionSummary): Role[] {
  if (!session.participants || session.participants.length === 0) return [];
  return session.participants.map((p: Participant) =>
    p.kind === 'user' ? 'user' : normalizeRole(p.role)
  );
}

function agentRolesOf(session: SessionSummary): Role[] {
  return rolesOf(session).filter((r) => r !== 'user');
}

function hasUserParticipant(session: SessionSummary): boolean {
  return rolesOf(session).includes('user');
}

/**
 * Маппинг роли-источника handoff'а на тип артефакта передачи. Кратко
 * и по-русски, чтобы поместилось над стрелкой. Если артефакт неизвестен
 * — пустая строка (стрелка без подписи).
 */
function handoffArtifactLabel(fromRole: Role, meta: RunMeta): string {
  if (fromRole === 'product' && meta.briefPath) return 'бриф';
  if (fromRole === 'architect' && meta.planPath) return 'план';
  if (fromRole === 'product') return 'бриф';
  if (fromRole === 'architect') return 'план';
  return '';
}

export function layoutCanvas(meta: RunMeta): CanvasLayout {
  const sessions = meta.sessions ?? [];

  // 1) Найти владельца каждой сессии (роль агента, для которой эта
  //    сессия — собственная). Для user-agent — единственный агент-участник.
  //    Для agent-agent (bridge) — приёмник handoff'а: роль из participants
  //    bridge'а, которой НЕ было в родительской сессии.
  const sessionById = new Map<string, SessionSummary>();
  for (const session of sessions) sessionById.set(session.id, session);

  const sessionOwner = new Map<string, Role>();
  for (const session of sessions) {
    const agents = agentRolesOf(session);
    if (agents.length === 0) continue;
    if (session.kind === 'user-agent' || !session.parentSessionId) {
      sessionOwner.set(session.id, agents[0]);
      continue;
    }
    const parent = sessionById.get(session.parentSessionId);
    const parentRoles = parent ? new Set(agentRolesOf(parent)) : new Set<Role>();
    const recipient = agents.find((r) => !parentRoles.has(r)) ?? agents[agents.length - 1];
    sessionOwner.set(session.id, recipient);
  }

  // 2) Уникальные агенты в порядке первого появления + последняя активность.
  //    user добавляется отдельной нодой, если он есть хотя бы в одной сессии.
  const agentOrder: Role[] = [];
  const lastActivity = new Map<Role, string>();
  for (const session of sessions) {
    const owner = sessionOwner.get(session.id);
    if (owner && !agentOrder.includes(owner)) agentOrder.push(owner);
    if (owner) {
      const prev = lastActivity.get(owner);
      if (!prev || prev < session.updatedAt) lastActivity.set(owner, session.updatedAt);
    }
  }
  const fallbackRole: Role | undefined = agentOrder.length === 0 ? 'product' : undefined;
  if (fallbackRole) agentOrder.push(fallbackRole);

  // User появляется отдельным кубиком только в hybrid-режиме: когда
  // пользователь вмешался в bridge (agent-agent сессию). В обычной
  // user-agent сессии user — собеседник по умолчанию и подразумевается.
  const hasUser = sessions.some((s) => s.kind === 'agent-agent' && hasUserParticipant(s));

  // 3) Рёбра: handoff'ы (parent → bridge) и user-вмешательство.
  // Накапливаем edge'ы в map по id; при повторе той же пары (повторный
  // handoff на ту же роль) заменяем bridgeSessionId на более свежий —
  // drill-in открывает «последнюю нитку» этой связи (acceptance #0026).
  const edgesById = new Map<string, CanvasEdge>();
  const addEdge = (edge: CanvasEdge) => {
    edgesById.set(edge.id, edge);
  };

  for (const session of sessions) {
    if (session.kind !== 'agent-agent' || !session.parentSessionId) continue;
    const recipient = sessionOwner.get(session.id);
    if (!recipient) continue;
    const sourceRole = sessionOwner.get(session.parentSessionId);
    if (sourceRole && sourceRole !== recipient) {
      addEdge({
        id: `${sourceRole}->${recipient}`,
        from: sourceRole,
        to: recipient,
        label: handoffArtifactLabel(sourceRole, meta),
        kind: 'handoff',
        bridgeSessionId: session.id,
      });
    }
    if (hasUserParticipant(session)) {
      addEdge({
        id: `user->${recipient}`,
        from: 'user',
        to: recipient,
        label: 'вмешательство',
        kind: 'user',
        bridgeSessionId: session.id,
      });
    }
  }
  const edges: CanvasEdge[] = [...edgesById.values()];

  // 4) Колонки: BFS от корней (агентов без входящих handoff-рёбер).
  const incoming = new Map<Role, Role[]>();
  for (const role of agentOrder) incoming.set(role, []);
  for (const edge of edges) {
    if (edge.kind !== 'handoff') continue;
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge.from);
  }

  const col = new Map<Role, number>();
  const queue: Role[] = [];
  for (const role of agentOrder) {
    if ((incoming.get(role) ?? []).length === 0) {
      col.set(role, 0);
      queue.push(role);
    }
  }
  // Если все ноды имеют входящие (циклы быть не должно, но на всякий случай) —
  // первая по порядку становится корнем.
  if (queue.length === 0 && agentOrder.length > 0) {
    col.set(agentOrder[0], 0);
    queue.push(agentOrder[0]);
  }
  while (queue.length > 0) {
    const role = queue.shift()!;
    const c = col.get(role) ?? 0;
    for (const edge of edges) {
      if (edge.kind !== 'handoff' || edge.from !== role) continue;
      const prev = col.get(edge.to);
      const next = c + 1;
      if (prev === undefined || prev < next) {
        col.set(edge.to, next);
        queue.push(edge.to);
      }
    }
  }

  // 5) Ряды внутри столбца — по порядку первого появления.
  const rowByCol = new Map<number, number>();
  const nodes: CanvasNode[] = [];
  for (const role of agentOrder) {
    const c = col.get(role) ?? 0;
    const r = rowByCol.get(c) ?? 0;
    rowByCol.set(c, r + 1);
    nodes.push({
      id: role,
      role,
      col: c,
      row: r,
      x: PAD_X + c * COL_STEP_X,
      y: PAD_Y + r * ROW_STEP_Y,
      width: NODE_W,
      height: NODE_H,
      lastActivityAt: lastActivity.get(role),
    });
  }

  // 6) User — отдельная колонка слева (col = -1), если присутствует.
  if (hasUser) {
    nodes.push({
      id: 'user',
      role: 'user',
      col: -1,
      row: 0,
      x: PAD_X,
      y: PAD_Y,
      width: NODE_W,
      height: NODE_H,
      lastActivityAt: undefined,
    });
    // Сдвинуть всех агентов на колонку правее — иначе перекрытие с user.
    for (const node of nodes) {
      if (node.role === 'user') continue;
      node.col += 1;
      node.x = PAD_X + node.col * COL_STEP_X;
    }
  }

  const maxCol = nodes.reduce((m, n) => Math.max(m, n.col), 0);
  const maxRow = nodes.reduce(
    (m, n) => Math.max(m, n.col === maxCol ? n.row : (rowByCol.get(n.col) ?? 1) - 1),
    0
  );
  const width = PAD_X * 2 + (maxCol + 1) * COL_STEP_X;
  const height = PAD_Y * 2 + (maxRow + 1) * ROW_STEP_Y;

  return { nodes, edges, width, height };
}
