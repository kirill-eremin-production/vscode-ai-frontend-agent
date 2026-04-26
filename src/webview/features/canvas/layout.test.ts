import { describe, it, expect } from 'vitest';
import { layoutCanvas, NODE_W, PAD_X, ROW_STEP_Y } from './layout';
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

describe('layoutCanvas — hierarchy-layout (#0042)', () => {
  it('три роли (product, architect, programmer) → три позиции на разных y, одинаковом x', () => {
    // AC #0042: «для трёх ролей возвращает три позиции на разных y,
    // одинаковом x». Порядок по y — строго по `levelOf` (product
    // выше programmer'а вне зависимости от порядка появления в meta).
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
      ])
    );
    expect(result.nodes).toHaveLength(3);
    const [first, second, third] = result.nodes;
    expect(first.role).toBe('product');
    expect(second.role).toBe('architect');
    expect(third.role).toBe('programmer');

    // Все x одинаковые — кубики выровнены по центру по горизонтали.
    expect(second.x).toBe(first.x);
    expect(third.x).toBe(first.x);

    // y растёт строго по уровням, шаг ROW_STEP_Y.
    expect(second.y).toBe(first.y + ROW_STEP_Y);
    expect(third.y).toBe(second.y + ROW_STEP_Y);

    // Каждому кубику — свой `level`, совпадающий с уровнем в иерархии.
    expect(first.level).toBe(0);
    expect(second.level).toBe(1);
    expect(third.level).toBe(2);
  });

  it('две роли → корректно сжимает: два кубика подряд по y, одна линия между ними', () => {
    // AC #0042: «для двух — корректно сжимает». Сжатие = идут подряд
    // по списку, без пустого слота для отсутствующего уровня.
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(result.nodes).toHaveLength(2);
    const [upper, lower] = result.nodes;
    expect(upper.role).toBe('product');
    expect(lower.role).toBe('programmer');
    // Сжатие: y идут подряд, как если бы между ними не было пропуска.
    expect(lower.y).toBe(upper.y + ROW_STEP_Y);
    // Линия одна — между двумя присутствующими уровнями.
    expect(result.reportingLines).toHaveLength(1);
    expect(result.reportingLines[0]).toMatchObject({
      id: 'product--programmer',
      x: upper.x + NODE_W / 2,
      fromY: upper.y + upper.height,
      toY: lower.y,
    });
  });

  it('layout не содержит edges-полей (стрелки коммуникации удалены)', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result).not.toHaveProperty('edges');
    // Только статичные линии-репортинги допустимы как «связи».
    expect(Array.isArray(result.reportingLines)).toBe(true);
  });

  it('пустой meta.sessions → fallback одна нода продакта без линий', () => {
    const result = layoutCanvas(meta([]));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].role).toBe('product');
    expect(result.reportingLines).toHaveLength(0);
  });

  it('user-участник в сессии не порождает кубик (кубик user — задача #0043)', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result.nodes.map((node) => node.role)).toEqual(['product']);
  });

  it('lastActivityAt берётся максимальным по сессиям роли', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          updatedAt: '2026-04-26T10:00:00Z',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          updatedAt: '2026-04-26T11:00:00Z',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result.nodes[0].lastActivityAt).toBe('2026-04-26T11:00:00Z');
  });

  it('width/height положительны и учитывают число уровней', () => {
    const single = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    const triple = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(single.width).toBeGreaterThanOrEqual(NODE_W + PAD_X * 2);
    expect(single.height).toBeGreaterThan(0);
    expect(triple.height).toBeGreaterThan(single.height);
  });

  it('линии-репортинги для трёх ролей: две линии, между соседними уровнями', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(result.reportingLines).toHaveLength(2);
    expect(result.reportingLines[0].id).toBe('product--architect');
    expect(result.reportingLines[1].id).toBe('architect--programmer');
  });
});
