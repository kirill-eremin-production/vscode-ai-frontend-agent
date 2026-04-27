import { describe, expect, it } from 'vitest';
import {
  roleStateFor,
  selectRoleStates,
  type RoleStateMeetingRequest,
  type RoleStateRunSnapshot,
  type RoleStateSession,
} from './role-state';
import type { Participant, RunStatus } from './types';

/**
 * Юниты для модели состояния роли (#0048).
 *
 * Покрываем ровно AC задачи:
 *  - пустой ран → все роли idle;
 *  - busy при «к роли обратились» в активной сессии;
 *  - idle при «роль уже ответила»;
 *  - awaiting_input при наличии pending meeting-request от этой роли;
 *  - селектор `selectRoleStates` строит запись по всем ролям иерархии.
 *
 * Дополнительно фиксируем граничные случаи, которые легко поломать
 * рефакторингом: финальные статусы сессии не делают роль busy; при
 * нескольких pending'ах берём самый старый.
 */

function session(over: Partial<RoleStateSession> & { id: string }): RoleStateSession {
  return {
    status: 'running' as RunStatus,
    participants: [],
    ...over,
  };
}

function participantsOf(...roles: Array<'user' | 'product' | 'architect' | 'programmer'>) {
  return roles.map(
    (role): Participant => (role === 'user' ? { kind: 'user' } : { kind: 'agent', role })
  );
}

function meetingRequest(
  over: Partial<RoleStateMeetingRequest> & { id: string }
): RoleStateMeetingRequest {
  return {
    requesterRole: 'product',
    status: 'pending',
    createdAt: '2026-04-26T10:00:00.000Z',
    ...over,
  };
}

function snapshot(over: Partial<RoleStateRunSnapshot> = {}): RoleStateRunSnapshot {
  return {
    sessions: [],
    meetingRequests: [],
    ...over,
  };
}

describe('roleStateFor', () => {
  it('idle для всех ролей в пустом ране', () => {
    // Сценарий: ран только что создан, нет ни сессий, ни запросов.
    // Любая роль не вовлечена → idle.
    const empty = snapshot();
    expect(roleStateFor('product', empty)).toEqual({ kind: 'idle' });
    expect(roleStateFor('architect', empty)).toEqual({ kind: 'idle' });
    expect(roleStateFor('programmer', empty)).toEqual({ kind: 'idle' });
  });

  it('busy с id сессии, если последнее сообщение от другого участника', () => {
    // Классический «к продакту обратились» — пользователь задал вопрос,
    // продакт должен ответить. Состояние — busy(s1).
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('user', 'product'),
          lastMessageFrom: 'user',
        }),
      ],
    });
    expect(roleStateFor('product', state)).toEqual({ kind: 'busy', sessionId: 's1' });
  });

  it('idle, если последнее сообщение от самой роли (она уже ответила)', () => {
    // Продакт сдал реплику и ждёт реакцию пользователя/другой роли.
    // С точки зрения занятости — он не busy: к нему ничего не обращено.
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('user', 'product'),
          lastMessageFrom: 'agent:product',
        }),
      ],
    });
    expect(roleStateFor('product', state)).toEqual({ kind: 'idle' });
  });

  it('awaiting_input при наличии pending meeting-request от этой роли', () => {
    // Программист попросил встречу с продактом. Пока запрос pending,
    // программист ждёт — awaiting_input(meetingRequestId).
    const state = snapshot({
      meetingRequests: [
        meetingRequest({ id: 'mr-1', requesterRole: 'programmer', status: 'pending' }),
      ],
    });
    expect(roleStateFor('programmer', state)).toEqual({
      kind: 'awaiting_input',
      meetingRequestId: 'mr-1',
    });
  });

  it('awaiting_input приоритетнее busy', () => {
    // Если у роли одновременно есть pending-запрос и активная сессия,
    // в которой её ждут — приоритет за meeting-request: agent-loop роли
    // приостановлен (см. #0031) до резолва запроса, поэтому формально
    // она «ждёт ответ», а не «отвечает».
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('user', 'product'),
          lastMessageFrom: 'user',
        }),
      ],
      meetingRequests: [
        meetingRequest({ id: 'mr-99', requesterRole: 'product', status: 'pending' }),
      ],
    });
    expect(roleStateFor('product', state)).toEqual({
      kind: 'awaiting_input',
      meetingRequestId: 'mr-99',
    });
  });

  it('при нескольких pending-запросах от роли возвращает самый старый', () => {
    // UX «роль ждёт» — про первый, заблокировавший её. Последующие
    // встают за ним.
    const state = snapshot({
      meetingRequests: [
        meetingRequest({
          id: 'mr-new',
          requesterRole: 'architect',
          createdAt: '2026-04-26T12:00:00.000Z',
        }),
        meetingRequest({
          id: 'mr-old',
          requesterRole: 'architect',
          createdAt: '2026-04-26T10:00:00.000Z',
        }),
      ],
    });
    expect(roleStateFor('architect', state)).toEqual({
      kind: 'awaiting_input',
      meetingRequestId: 'mr-old',
    });
  });

  it('игнорирует не-pending meeting-requests', () => {
    // Resolved/failed запросы — это история, в текущее состояние не
    // влияют.
    const state = snapshot({
      meetingRequests: [
        meetingRequest({ id: 'mr-resolved', requesterRole: 'product', status: 'resolved' }),
        meetingRequest({ id: 'mr-failed', requesterRole: 'product', status: 'failed' }),
      ],
    });
    expect(roleStateFor('product', state)).toEqual({ kind: 'idle' });
  });

  it('игнорирует pending-запросы от другой роли', () => {
    // Запрос продакта не делает программиста awaiting_input — это
    // запрос *от* продакта, не *к* программисту.
    const state = snapshot({
      meetingRequests: [
        meetingRequest({ id: 'mr-1', requesterRole: 'product', status: 'pending' }),
      ],
    });
    expect(roleStateFor('programmer', state)).toEqual({ kind: 'idle' });
  });

  it('idle, если роль не участник сессии, даже если в чате к ней «обращаются»', () => {
    // Рукотворный кейс: в bridge product↔architect чат идёт без
    // программиста. Что бы там ни писали, programmer.busy не должен
    // включаться — он не в комнате.
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('product', 'architect'),
          lastMessageFrom: 'agent:product',
        }),
      ],
    });
    expect(roleStateFor('programmer', state)).toEqual({ kind: 'idle' });
  });

  it('idle для пустой сессии (без сообщений)', () => {
    // Пустой чат — не «обращение», а лишь факт создания комнаты.
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('user', 'product'),
          lastMessageFrom: undefined,
        }),
      ],
    });
    expect(roleStateFor('product', state)).toEqual({ kind: 'idle' });
  });

  it('сессии в финальных статусах (done/failed/compacted) не делают роль busy', () => {
    // Закрытая сессия — это история. Даже если её «оборвали» с
    // вопросом к продакту, busy сейчас уже неактуален.
    for (const status of ['done', 'failed', 'compacted'] as const) {
      const state = snapshot({
        sessions: [
          session({
            id: `s-${status}`,
            status,
            participants: participantsOf('user', 'product'),
            lastMessageFrom: 'user',
          }),
        ],
      });
      expect(roleStateFor('product', state)).toEqual({ kind: 'idle' });
    }
  });

  it('возвращает первую активную сессию, если их несколько', () => {
    // На старте multi-session мира (#0050) у роли обычно ≤1 одновременной
    // сессии; для предсказуемости фиксируем «первая в массиве выигрывает».
    const state = snapshot({
      sessions: [
        session({
          id: 's-first',
          participants: participantsOf('product', 'architect'),
          lastMessageFrom: 'agent:product',
        }),
        session({
          id: 's-second',
          participants: participantsOf('product', 'architect'),
          lastMessageFrom: 'agent:product',
        }),
      ],
    });
    expect(roleStateFor('architect', state)).toEqual({
      kind: 'busy',
      sessionId: 's-first',
    });
  });
});

describe('selectRoleStates', () => {
  it('возвращает запись по всем ролям иерархии', () => {
    // Пустой ран → все три роли (product/architect/programmer) с idle.
    // user в записи нет осознанно (см. #0031: его busy/idle не моделируем).
    const empty = snapshot();
    expect(selectRoleStates(empty)).toEqual({
      product: { kind: 'idle' },
      architect: { kind: 'idle' },
      programmer: { kind: 'idle' },
    });
  });

  it('собирает разные состояния по разным ролям', () => {
    // product — busy в сессии s1 (пользователь спросил), architect — idle,
    // programmer — awaiting_input по своему meeting-request'у.
    const state = snapshot({
      sessions: [
        session({
          id: 's1',
          participants: participantsOf('user', 'product'),
          lastMessageFrom: 'user',
        }),
      ],
      meetingRequests: [
        meetingRequest({ id: 'mr-7', requesterRole: 'programmer', status: 'pending' }),
      ],
    });
    expect(selectRoleStates(state)).toEqual({
      product: { kind: 'busy', sessionId: 's1' },
      architect: { kind: 'idle' },
      programmer: { kind: 'awaiting_input', meetingRequestId: 'mr-7' },
    });
  });
});
