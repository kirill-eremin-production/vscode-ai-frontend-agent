import { describe, it, expect } from 'vitest';
import { resolveCubeDrillSession, isSessionOwnedBy } from './drill-resolver';
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

/**
 * Сценарий из TC-39 — typical handoff: продакт сделал бриф, передал
 * работу архитектору, архитектор сейчас ждёт юзера. На канвасе ровно
 * это должно отображаться:
 *  - product cube → root user-agent сессия (где юзер общался с продактом),
 *  - architect cube → bridge product↔architect (где архитектор работает).
 *
 * Корневой кейс регрессии #0026: до фикса `selectActiveSessionForRole`
 * возвращал bridge и для product, потому что product присутствует в его
 * `participants`. Тест защищает этот контракт.
 */
describe('resolveCubeDrillSession — handoff product→architect (TC-39)', () => {
  const root = session({
    id: 's_root',
    kind: 'user-agent',
    status: 'awaiting_human',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:30:00Z',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
  });
  const bridge = session({
    id: 's_bridge',
    kind: 'agent-agent',
    status: 'awaiting_human',
    parentSessionId: 's_root',
    createdAt: '2026-04-26T10:31:00Z',
    updatedAt: '2026-04-26T10:35:00Z',
    participants: [
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ],
  });
  const m = meta([root, bridge], 's_bridge');

  it('product cube → root user-agent сессия (а не bridge, где product тоже в participants)', () => {
    expect(resolveCubeDrillSession('product', m)).toBe('s_root');
  });

  it('architect cube → bridge (recipient handoff-а)', () => {
    expect(resolveCubeDrillSession('architect', m)).toBe('s_bridge');
  });

  it('user cube (которого тут нет на канвасе) → undefined: bridge без user-участника', () => {
    expect(resolveCubeDrillSession('user', m)).toBeUndefined();
  });
});

/**
 * Hybrid (#0012): юзер вмешался в bridge, теперь в `participants`
 * bridge'а есть `{kind:'user'}`. На канвасе появляется кубик user, и
 * клик по нему должен вести в эту bridge — там реально шёл диалог
 * человек↔архитектор.
 */
describe('resolveCubeDrillSession — hybrid bridge (#0012)', () => {
  const root = session({
    id: 's_root',
    kind: 'user-agent',
    status: 'done',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:10:00Z',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
  });
  const hybridBridge = session({
    id: 's_bridge',
    kind: 'agent-agent',
    status: 'awaiting_human',
    parentSessionId: 's_root',
    createdAt: '2026-04-26T10:11:00Z',
    updatedAt: '2026-04-26T10:30:00Z',
    participants: [
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
      { kind: 'user' },
    ],
  });
  const m = meta([root, hybridBridge], 's_bridge');

  it('product cube остаётся на root (вмешательство юзера не делает product владельцем bridge)', () => {
    expect(resolveCubeDrillSession('product', m)).toBe('s_root');
  });

  it('architect cube → hybrid bridge (он же owner — recipient)', () => {
    expect(resolveCubeDrillSession('architect', m)).toBe('s_bridge');
  });

  it('user cube → hybrid bridge (единственная bridge с user-участником)', () => {
    expect(resolveCubeDrillSession('user', m)).toBe('s_bridge');
  });
});

/**
 * Среди нескольких owned-сессий выбираем live; среди нескольких live —
 * самую свежую по `updatedAt`. Тот же контракт, что у индикатора
 * активности кубика (#0024) — drill идёт «туда же, что показывает спиннер».
 */
describe('resolveCubeDrillSession — приоритеты live и updatedAt', () => {
  it('из двух owned — done и live — берёт live, даже если done свежее', () => {
    const oldLive = session({
      id: 's_a',
      kind: 'user-agent',
      status: 'running',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const newDone = session({
      id: 's_b',
      kind: 'user-agent',
      status: 'done',
      updatedAt: '2026-04-26T11:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const m = meta([oldLive, newDone], 's_a');
    expect(resolveCubeDrillSession('product', m)).toBe('s_a');
  });

  it('из двух live — берёт более свежую', () => {
    const olderLive = session({
      id: 's_a',
      kind: 'user-agent',
      status: 'running',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const newerLive = session({
      id: 's_b',
      kind: 'user-agent',
      status: 'awaiting_human',
      updatedAt: '2026-04-26T11:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const m = meta([olderLive, newerLive], 's_a');
    expect(resolveCubeDrillSession('product', m)).toBe('s_b');
  });

  it('если live нет, берёт самую свежую done', () => {
    const oldDone = session({
      id: 's_a',
      kind: 'user-agent',
      status: 'done',
      updatedAt: '2026-04-26T10:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const newDone = session({
      id: 's_b',
      kind: 'user-agent',
      status: 'done',
      updatedAt: '2026-04-26T11:00:00Z',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const m = meta([oldDone, newDone], 's_a');
    expect(resolveCubeDrillSession('product', m)).toBe('s_b');
  });
});

describe('resolveCubeDrillSession — край: роль не участвует', () => {
  it('роли нет ни в одной сессии → undefined', () => {
    const root = session({
      id: 's_root',
      kind: 'user-agent',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    });
    expect(resolveCubeDrillSession('architect', meta([root]))).toBeUndefined();
  });

  it('user cube без hybrid-bridge → undefined', () => {
    const root = session({
      id: 's_root',
      kind: 'user-agent',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    });
    expect(resolveCubeDrillSession('user', meta([root]))).toBeUndefined();
  });
});

/**
 * Гипотетический multi-step handoff: product→architect→backend. Для
 * backend cube ожидаем bridge architect↔backend (сам последний звено),
 * для architect — первую bridge (он там recipient), для product — root.
 * Защищает от регрессии «owner определяется глобально по всем sessions,
 * а не локально по парам parent/child».
 */
describe('resolveCubeDrillSession — multi-step handoff', () => {
  const root = session({
    id: 's_root',
    kind: 'user-agent',
    status: 'done',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:05:00Z',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
  });
  const productToArchitect = session({
    id: 's_pa',
    kind: 'agent-agent',
    status: 'done',
    parentSessionId: 's_root',
    createdAt: '2026-04-26T10:06:00Z',
    updatedAt: '2026-04-26T10:10:00Z',
    participants: [
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ],
  });
  const architectToBackend = session({
    id: 's_ab',
    kind: 'agent-agent',
    status: 'running',
    parentSessionId: 's_pa',
    createdAt: '2026-04-26T10:11:00Z',
    updatedAt: '2026-04-26T10:15:00Z',
    participants: [
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'backend' },
    ],
  });
  const m = meta([root, productToArchitect, architectToBackend], 's_ab');

  it('product cube → root', () => {
    expect(resolveCubeDrillSession('product', m)).toBe('s_root');
  });

  it('architect cube → product-architect bridge (там architect — recipient)', () => {
    expect(resolveCubeDrillSession('architect', m)).toBe('s_pa');
  });

  it('backend cube → architect-backend bridge (там backend — recipient)', () => {
    expect(resolveCubeDrillSession('backend', m)).toBe('s_ab');
  });
});

describe('isSessionOwnedBy — единичные правила', () => {
  it('user-agent: владелец — единственный агент', () => {
    const s = session({
      id: 's',
      kind: 'user-agent',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    });
    expect(isSessionOwnedBy(s, 'product', [s])).toBe(true);
    expect(isSessionOwnedBy(s, 'architect', [s])).toBe(false);
  });

  it('agent-agent: владелец — recipient (агент НЕ из родителя)', () => {
    const parent = session({
      id: 's_p',
      kind: 'user-agent',
      participants: [{ kind: 'agent', role: 'product' }],
    });
    const bridge = session({
      id: 's_b',
      kind: 'agent-agent',
      parentSessionId: 's_p',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    });
    const all = [parent, bridge];
    expect(isSessionOwnedBy(bridge, 'architect', all)).toBe(true);
    expect(isSessionOwnedBy(bridge, 'product', all)).toBe(false);
  });

  it('orphan agent-agent (родитель потерян): владелец — первый агент (fallback)', () => {
    // Без parent в `allSessions` — parentRoles пуст, recipient = первый
    // агент, не входящий в (пустое) parentRoles → первый агент.
    const orphan = session({
      id: 's_o',
      kind: 'agent-agent',
      parentSessionId: 's_missing',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    });
    expect(isSessionOwnedBy(orphan, 'product', [orphan])).toBe(true);
    expect(isSessionOwnedBy(orphan, 'architect', [orphan])).toBe(false);
  });

  it('сессия без agent-участников: никакая роль не владеет', () => {
    const userOnly = session({
      id: 's_u',
      kind: 'user-agent',
      participants: [{ kind: 'user' }],
    });
    expect(isSessionOwnedBy(userOnly, 'product', [userOnly])).toBe(false);
  });
});
