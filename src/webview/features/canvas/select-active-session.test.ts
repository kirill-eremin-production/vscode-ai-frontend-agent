import { describe, it, expect } from 'vitest';
import { selectActiveSessionForRole, ownerRoleOfActiveSession } from './select-active-session';
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

function meta(sessions: SessionSummary[], activeId?: string): RunMeta {
  return {
    id: 'r1',
    title: 't',
    prompt: 'p',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    activeSessionId: activeId ?? sessions[0]?.id ?? 's1',
    sessions,
    usage: ZERO_USAGE,
  };
}

describe('selectActiveSessionForRole', () => {
  it('возвращает live-сессию роли, даже если есть свежая done', () => {
    const m = meta([
      session({
        id: 's1',
        status: 'done',
        updatedAt: '2026-04-26T11:00:00Z',
        participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
      }),
      session({
        id: 's2',
        kind: 'agent-agent',
        status: 'running',
        updatedAt: '2026-04-26T10:30:00Z',
        parentSessionId: 's1',
        participants: [
          { kind: 'agent', role: 'product' },
          { kind: 'agent', role: 'architect' },
        ],
      }),
    ]);
    // s1 — самая свежая, но done; s2 — live и тоже содержит product →
    // live-приоритет должен победить, для канваса важен «жив или нет».
    expect(selectActiveSessionForRole(m, 'product')!.id).toBe('s2');
  });

  it('из нескольких live-сессий выбирает самую свежую', () => {
    const m = meta([
      session({
        id: 's1',
        status: 'running',
        updatedAt: '2026-04-26T10:00:00Z',
        participants: [{ kind: 'agent', role: 'architect' }],
      }),
      session({
        id: 's2',
        status: 'running',
        updatedAt: '2026-04-26T10:30:00Z',
        participants: [{ kind: 'agent', role: 'architect' }],
      }),
    ]);
    expect(selectActiveSessionForRole(m, 'architect')!.id).toBe('s2');
  });

  it('если live-сессий нет, возвращает самую свежую закрытую', () => {
    const m = meta([
      session({
        id: 's1',
        status: 'done',
        updatedAt: '2026-04-26T10:00:00Z',
        participants: [{ kind: 'agent', role: 'product' }],
      }),
      session({
        id: 's2',
        status: 'failed',
        updatedAt: '2026-04-26T10:30:00Z',
        participants: [{ kind: 'agent', role: 'product' }],
      }),
    ]);
    expect(selectActiveSessionForRole(m, 'product')!.id).toBe('s2');
  });

  it('если роли нет ни в одной сессии — undefined', () => {
    const m = meta([
      session({
        id: 's1',
        participants: [{ kind: 'agent', role: 'product' }],
      }),
    ]);
    expect(selectActiveSessionForRole(m, 'architect')).toBeUndefined();
  });
});

describe('ownerRoleOfActiveSession', () => {
  it('user-agent сессия → её агент', () => {
    const m = meta([
      session({
        id: 's1',
        participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
      }),
    ]);
    expect(ownerRoleOfActiveSession(m)).toBe('product');
  });

  it('bridge agent-agent → роль, которой не было в родителе (получатель handoff)', () => {
    const m = meta(
      [
        session({
          id: 's1',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
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
      's2'
    );
    expect(ownerRoleOfActiveSession(m)).toBe('architect');
  });

  it('активная сессия не найдена — undefined', () => {
    const m = meta(
      [session({ id: 's1', participants: [{ kind: 'agent', role: 'product' }] })],
      'unknown'
    );
    expect(ownerRoleOfActiveSession(m)).toBeUndefined();
  });
});
