import { describe, it, expect } from 'vitest';
import { layoutCanvas } from './layout';
import type { RunMeta, SessionSummary, UsageAggregate } from '@shared/runs/types';

const ZERO_USAGE: UsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastTotalTokens: 0,
  lastModel: null,
};

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'user-agent',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    usage: ZERO_USAGE,
    ...over,
  };
}

function meta(sessions: SessionSummary[], over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r1',
    title: 't',
    prompt: 'p',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    activeSessionId: sessions[0]?.id ?? 's1',
    sessions,
    usage: ZERO_USAGE,
    ...over,
  };
}

describe('layoutCanvas', () => {
  it('один агент (user-agent сессия) → одна нода продакта, без user-кубика', () => {
    // User в user-agent сессии — собеседник по умолчанию, отдельный
    // кубик не нужен. Канвас рисует именно команду агентов; пользователь
    // появляется отдельным кубиком только при hybrid-вмешательстве в bridge.
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].role).toBe('product');
    expect(result.nodes[0].col).toBe(0);
    expect(result.edges).toHaveLength(0);
  });

  it('продакт→архитектор: две ноды в разных колонках, одно ребро с подписью «бриф»', () => {
    const result = layoutCanvas(
      meta(
        [
          session({
            id: 's1',
            kind: 'user-agent',
            participants: [{ kind: 'agent', role: 'product' }],
          }),
          session({
            id: 's2',
            kind: 'agent-agent',
            parentSessionId: 's1',
            participants: [
              { kind: 'agent', role: 'product' },
              { kind: 'agent', role: 'architect' },
            ],
          }),
        ],
        { briefPath: '.agents/knowledge/product/briefs/r1.md' }
      )
    );
    const product = result.nodes.find((n) => n.role === 'product')!;
    const architect = result.nodes.find((n) => n.role === 'architect')!;
    expect(product.col).toBeLessThan(architect.col);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      from: 'product',
      to: 'architect',
      label: 'бриф',
      kind: 'handoff',
    });
  });

  it('hybrid: продакт→архитектор + user-вмешательство → 3 ноды и 2 ребра', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          kind: 'user-agent',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          kind: 'agent-agent',
          parentSessionId: 's1',
          participants: [
            { kind: 'user' },
            { kind: 'agent', role: 'product' },
            { kind: 'agent', role: 'architect' },
          ],
        }),
      ])
    );
    const roles = result.nodes.map((n) => n.role).sort();
    expect(roles).toEqual(['architect', 'product', 'user']);
    const edgeKinds = result.edges.map((e) => `${e.kind}:${e.from}->${e.to}`).sort();
    expect(edgeKinds).toEqual(['handoff:product->architect', 'user:user->architect']);
  });

  it('пустой meta.sessions → fallback одна нода продакта', () => {
    const result = layoutCanvas(meta([]));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].role).toBe('product');
  });

  it('сессия без participants → fallback одна нода продакта', () => {
    const result = layoutCanvas(meta([session({ id: 's1' })]));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].role).toBe('product');
  });

  it('handoff-ребро несёт bridgeSessionId; повторный handoff заменяет на свежий', () => {
    // Drill-in #0026: клик по стрелке открывает чат той сессии, что в
    // bridgeSessionId. Если на одну пару (product→architect) случилось
    // два bridge'а подряд (повторный handoff после возврата), берём
    // последнюю — это «активная нитка» этой связи.
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          kind: 'user-agent',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          kind: 'agent-agent',
          parentSessionId: 's1',
          participants: [
            { kind: 'agent', role: 'product' },
            { kind: 'agent', role: 'architect' },
          ],
        }),
        session({
          id: 's3',
          kind: 'agent-agent',
          parentSessionId: 's1',
          updatedAt: '2026-04-26T11:00:00Z',
          participants: [
            { kind: 'agent', role: 'product' },
            { kind: 'agent', role: 'architect' },
          ],
        }),
      ])
    );
    const handoff = result.edges.find((e) => e.id === 'product->architect');
    expect(handoff?.bridgeSessionId).toBe('s3');
  });

  it('user-edge несёт bridgeSessionId соответствующего hybrid-bridge', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          kind: 'user-agent',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          kind: 'agent-agent',
          parentSessionId: 's1',
          participants: [
            { kind: 'user' },
            { kind: 'agent', role: 'product' },
            { kind: 'agent', role: 'architect' },
          ],
        }),
      ])
    );
    const userEdge = result.edges.find((e) => e.id === 'user->architect');
    expect(userEdge?.bridgeSessionId).toBe('s2');
  });

  it('width/height учитывают все колонки и ряды', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          kind: 'user-agent',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          kind: 'agent-agent',
          parentSessionId: 's1',
          participants: [
            { kind: 'agent', role: 'product' },
            { kind: 'agent', role: 'architect' },
          ],
        }),
      ])
    );
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });
});
