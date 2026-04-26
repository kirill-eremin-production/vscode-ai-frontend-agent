import { describe, it, expect } from 'vitest';
import { diffMetaForFlashes } from './flashes';
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

describe('diffMetaForFlashes', () => {
  it('prev=undefined → ничего не флэшим (защита от первого монтирования)', () => {
    const next = meta([
      session({
        id: 's1',
        participants: [{ kind: 'agent', role: 'product' }],
      }),
    ]);
    expect(diffMetaForFlashes(undefined, next)).toEqual([]);
  });

  it('появилась новая bridge — флэш appear для handoff-ребра', () => {
    const prev = meta([
      session({
        id: 's1',
        participants: [{ kind: 'agent', role: 'product' }],
      }),
    ]);
    const next = meta([
      session({
        id: 's1',
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
    ]);
    expect(diffMetaForFlashes(prev, next)).toEqual([
      { edgeId: 'product->architect', kind: 'appear' },
    ]);
  });

  it('updatedAt существующей bridge продвинулся → message-флэш handoff-ребра', () => {
    const before = session({
      id: 's2',
      kind: 'agent-agent',
      parentSessionId: 's1',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    });
    const after = { ...before, updatedAt: '2026-04-26T10:05:00Z' };
    const prev = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      before,
    ]);
    const next = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      after,
    ]);
    expect(diffMetaForFlashes(prev, next)).toEqual([
      { edgeId: 'product->architect', kind: 'message' },
    ]);
  });

  it('user впервые добавился в bridge → appear для user-ребра, без дублирующего message', () => {
    const before = session({
      id: 's2',
      kind: 'agent-agent',
      parentSessionId: 's1',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    });
    const after: SessionSummary = {
      ...before,
      updatedAt: '2026-04-26T10:05:00Z',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
        { kind: 'user' },
      ],
    };
    const prev = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      before,
    ]);
    const next = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      after,
    ]);
    expect(diffMetaForFlashes(prev, next)).toEqual([{ edgeId: 'user->architect', kind: 'appear' }]);
  });

  it('hybrid bridge с user, updatedAt продвинулся → message для user-ребра', () => {
    const before = session({
      id: 's2',
      kind: 'agent-agent',
      parentSessionId: 's1',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
        { kind: 'user' },
      ],
    });
    const after = { ...before, updatedAt: '2026-04-26T10:05:00Z' };
    const prev = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      before,
    ]);
    const next = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      after,
    ]);
    expect(diffMetaForFlashes(prev, next)).toEqual([
      { edgeId: 'user->architect', kind: 'message' },
    ]);
  });

  it('updatedAt не менялся → ничего не флэшим', () => {
    const sess = session({
      id: 's2',
      kind: 'agent-agent',
      parentSessionId: 's1',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    });
    const prev = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      sess,
    ]);
    const next = meta([
      session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] }),
      sess,
    ]);
    expect(diffMetaForFlashes(prev, next)).toEqual([]);
  });
});
