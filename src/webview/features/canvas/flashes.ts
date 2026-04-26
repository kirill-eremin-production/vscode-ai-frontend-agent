import type { Participant, RunMeta, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';
import { layoutCanvas } from './layout';

/**
 * Анимации стрелок канваса (#0025). Чистый diff двух snapshot'ов
 * `RunMeta`: новые рёбра → флэш «появление» (3 сек, dash-flow в направлении
 * приёмника), bridge с продвинувшимся `updatedAt` → флэш «сообщение» (~1 сек).
 *
 * Почему не подписываемся на `runs.message.appended` напрямую:
 *  - канвас уже подписан на `selectedDetails` (meta + chat активной сессии);
 *  - meta содержит `sessions[].updatedAt`, который двигается при каждом
 *    новом сообщении в _любой_ сессии — даже не активной;
 *  - один источник правды (meta) проще, чем держать ещё один eventbus.
 *
 * Это достаточно для acceptance: handoff (новая bridge-сессия), новое
 * сообщение в bridge (updatedAt'у advance) и user-вмешательство (новый
 * `{kind:'user'}` в participants bridge'а).
 */

export type FlashKind = 'appear' | 'message';

export interface FlashEvent {
  /** edgeId = `${from}->${to}`, как в `CanvasEdge.id`. */
  edgeId: string;
  kind: FlashKind;
}

export function diffMetaForFlashes(prev: RunMeta | undefined, next: RunMeta): FlashEvent[] {
  if (!prev) return [];

  const events: FlashEvent[] = [];
  const prevById = new Map<string, SessionSummary>();
  for (const s of prev.sessions ?? []) prevById.set(s.id, s);

  // 1) Новые рёбра — diff layout'ов prev/next: всё, чего раньше не было,
  //    флэшим как «появление». Layout — единственный источник правды
  //    о том, какие edgeId реально нарисованы (учёт hidden user-кубика
  //    в нон-hybrid случае и т.п.).
  const prevEdgeIds = new Set(layoutCanvas(prev).edges.map((e) => e.id));
  const nextLayout = layoutCanvas(next);
  for (const edge of nextLayout.edges) {
    if (!prevEdgeIds.has(edge.id)) {
      events.push({ edgeId: edge.id, kind: 'appear' });
    }
  }
  const appeared = new Set(events.map((e) => e.edgeId));

  // 2) Сообщения в существующих bridge'ах — флэшим handoff-ребро того же
  //    bridge'а. На уровне meta нельзя достоверно отличить «agent написал»
  //    от «user написал», поэтому эвристика: если в bridge участвует user
  //    (hybrid) — флэшим user-edge, иначе — handoff-edge. Это покрывает
  //    «лента ощущается живой», без ложной симметрии user→bridge на
  //    agent-agent шагах.
  for (const next2 of next.sessions ?? []) {
    if (next2.kind !== 'agent-agent') continue;
    const before = prevById.get(next2.id);
    if (!before) continue; // новая bridge'а — уже сфлэшено как 'appear'
    if (next2.updatedAt <= before.updatedAt) continue;

    const recipient = recipientRoleOfBridge(next2, next);
    if (!recipient) continue;

    const hadUser = hasUserParticipant(before);
    const hasUserNow = hasUserParticipant(next2);

    if (hasUserNow && !hadUser) {
      // Сначала user только что добавился — это уже сфлэшено через
      // diff layout'ов как 'appear' для `user->{recipient}`. Дополнительно
      // не флэшим, чтобы не было двойной анимации.
      continue;
    }

    const edgeId = hasUserNow ? `user->${recipient}` : `parent->${recipient}`;
    if (hasUserNow) {
      if (!appeared.has(edgeId)) {
        events.push({ edgeId, kind: 'message' });
      }
    } else {
      // Для не-hybrid bridge'а нужен реальный edgeId handoff'а — он
      // зависит от роли-источника (родителя). Берём из next-layout.
      const handoffEdge = nextLayout.edges.find((e) => e.kind === 'handoff' && e.to === recipient);
      if (handoffEdge && !appeared.has(handoffEdge.id)) {
        events.push({ edgeId: handoffEdge.id, kind: 'message' });
      }
    }
  }

  return events;
}

function hasUserParticipant(s: SessionSummary): boolean {
  return Boolean(s.participants?.some((p: Participant) => p.kind === 'user'));
}

function recipientRoleOfBridge(bridge: SessionSummary, meta: RunMeta): Role | undefined {
  const agents = (bridge.participants ?? [])
    .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
    .map((p) => p.role as Role);
  if (agents.length === 0) return undefined;
  if (!bridge.parentSessionId) return agents[agents.length - 1];
  const parent = (meta.sessions ?? []).find((s) => s.id === bridge.parentSessionId);
  const parentRoles = new Set<Role>(
    (parent?.participants ?? [])
      .filter((p): p is { kind: 'agent'; role: string } => p.kind === 'agent')
      .map((p) => p.role as Role)
  );
  return agents.find((r) => !parentRoles.has(r)) ?? agents[agents.length - 1];
}
