import { describe, it, expect } from 'vitest';
import { cubeStateFor, pausedRequesteeFor, type CubeRunState } from './cube-state';
import type {
  ChatMessage,
  MeetingRequestSummary,
  SessionSummary,
  UsageAggregate,
} from '@shared/runs/types';

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

function chat(...messages: Array<Pick<ChatMessage, 'from'>>): Array<Pick<ChatMessage, 'from'>> {
  return messages;
}

function runState(
  over: Partial<CubeRunState['meta']>,
  chatLog: CubeRunState['chat'],
  pendingRequests?: ReadonlyArray<MeetingRequestSummary>
): CubeRunState {
  return {
    meta: {
      activeSessionId: 's1',
      status: 'running',
      sessions: [],
      ...over,
    },
    chat: chatLog,
    pendingRequests,
  };
}

function pendingRequest(
  over: Partial<MeetingRequestSummary> & {
    requesterRole: string;
    requesteeRole: string;
  }
): MeetingRequestSummary {
  return {
    id: `req-${over.requesterRole}-${over.requesteeRole}`,
    contextSessionId: 's1',
    message: 'msg',
    createdAt: '2026-04-26T11:00:00Z',
    ...over,
  };
}

describe('cubeStateFor', () => {
  it('idle, если активной сессии нет в meta.sessions', () => {
    // Сценарий: meta пришла с устаревшим/несинхронизированным
    // activeSessionId (например, перед первым snapshot'ом). Кубик не
    // должен ни мигать спиннером, ни мерцать awaiting_user.
    const state = runState(
      { activeSessionId: 'unknown', sessions: [session({ id: 's1' })] },
      chat({ from: 'agent:product' })
    );
    expect(cubeStateFor('product', state)).toBe('idle');
  });

  it('idle, если роль не участник активной сессии', () => {
    // architect не в participants → даже если в чате последнее сообщение
    // от user, кубик architect'а не «работает». Иначе при любом ходе
    // user'а все идлящие кубики бы вспыхнули.
    const state = runState(
      {
        activeSessionId: 's1',
        sessions: [
          session({
            id: 's1',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat({ from: 'user' })
    );
    expect(cubeStateFor('architect', state)).toBe('idle');
  });

  it('working, если последнее сообщение не от этой роли', () => {
    // Классический «к продакту обратились, ждём ответ». Пользователь
    // задал вопрос — кубик product показывает спиннер.
    const state = runState(
      {
        activeSessionId: 's1',
        sessions: [
          session({
            id: 's1',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat({ from: 'agent:product' }, { from: 'user' })
    );
    expect(cubeStateFor('product', state)).toBe('working');
  });

  it('working для agent-agent bridge: architect отвечает продакту', () => {
    // После handoff'а активна bridge-сессия. Последнее сообщение —
    // от product (вопрос архитектору), архитектор должен «работать».
    const state = runState(
      {
        activeSessionId: 's2',
        sessions: [
          session({
            id: 's2',
            kind: 'agent-agent',
            participants: [
              { kind: 'agent', role: 'product' },
              { kind: 'agent', role: 'architect' },
            ],
          }),
        ],
      },
      chat({ from: 'agent:product' })
    );
    expect(cubeStateFor('architect', state)).toBe('working');
  });

  it('awaiting_user, если product последний написал и ран в awaiting_user_input', () => {
    // Acceptance из issue: «последнее сообщение от этой роли и адресовано
    // user → awaiting_user (только для product)». Активная сессия —
    // user-agent, статус рана — awaiting_user_input.
    const state = runState(
      {
        activeSessionId: 's1',
        status: 'awaiting_user_input',
        sessions: [
          session({
            id: 's1',
            status: 'awaiting_user_input',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat({ from: 'user' }, { from: 'agent:product' })
    );
    expect(cubeStateFor('product', state)).toBe('awaiting_user');
  });

  it('awaiting_user только для product: architect в bridge не считается', () => {
    // Граничный случай: даже если на bridge-сессии последнее сообщение
    // от architect'а и почему-то статус awaiting_user_input — кубик
    // architect не уходит в awaiting_user, потому что он user'у напрямую
    // не отвечает (bridge — между агентами, user не участник).
    const state = runState(
      {
        activeSessionId: 's2',
        status: 'awaiting_user_input',
        sessions: [
          session({
            id: 's2',
            kind: 'agent-agent',
            participants: [
              { kind: 'agent', role: 'product' },
              { kind: 'agent', role: 'architect' },
            ],
          }),
        ],
      },
      chat({ from: 'agent:architect' })
    );
    // architect — последний автор, обращения «к нему» нет → idle.
    expect(cubeStateFor('architect', state)).toBe('idle');
  });

  it('idle, если product последний написал, но статус не awaiting_user_input', () => {
    // Продакт сдал бриф, ран ушёл в awaiting_human → handoff/готово.
    // На канвасе кубик product не должен светиться awaiting_user —
    // это не вопрос пользователю.
    const state = runState(
      {
        activeSessionId: 's1',
        status: 'awaiting_human',
        sessions: [
          session({
            id: 's1',
            status: 'awaiting_human',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat({ from: 'user' }, { from: 'agent:product' })
    );
    expect(cubeStateFor('product', state)).toBe('idle');
  });

  it('paused, если у роли есть pending meeting-request как у requester', () => {
    // #0052: architect поставил встречу с программистом и ждёт ответа.
    // Кубик architect'а должен показать `paused`, даже если на активной
    // сессии (которая теперь bridge product↔architect) последнее
    // сообщение от product'а — обычно это бы дало `working`.
    const request = pendingRequest({ requesterRole: 'architect', requesteeRole: 'programmer' });
    const state = runState(
      {
        activeSessionId: 's2',
        sessions: [
          session({
            id: 's2',
            kind: 'agent-agent',
            participants: [
              { kind: 'agent', role: 'product' },
              { kind: 'agent', role: 'architect' },
            ],
          }),
        ],
      },
      chat({ from: 'agent:product' }),
      [request]
    );
    expect(cubeStateFor('architect', state)).toBe('paused');
    // Программист (requestee) сам не paused — это не его заявка.
    expect(cubeStateFor('programmer', state)).toBe('idle');
  });

  it('paused имеет приоритет над awaiting_user', () => {
    // Граничный случай: продакт ждёт ответа пользователя в корневой
    // сессии и параллельно поставил meeting-request к архитектору
    // (теоретически возможно). Главный сигнал — pending заявка, иначе
    // пользователь не поймёт, почему «awaiting_user» висит, а ответы
    // не двигают цикл (роль на самом деле паузнута).
    const request = pendingRequest({ requesterRole: 'product', requesteeRole: 'architect' });
    const state = runState(
      {
        activeSessionId: 's1',
        status: 'awaiting_user_input',
        sessions: [
          session({
            id: 's1',
            status: 'awaiting_user_input',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat({ from: 'user' }, { from: 'agent:product' }),
      [request]
    );
    expect(cubeStateFor('product', state)).toBe('paused');
  });

  it('pausedRequesteeFor возвращает самую свежую заявку, если их несколько', () => {
    // Если у роли скопилось несколько pending'ов как у requester'а,
    // в caption «ждёт ответа от X» показываем последнюю интенцию.
    const older = pendingRequest({
      requesterRole: 'architect',
      requesteeRole: 'product',
      createdAt: '2026-04-26T10:00:00Z',
    });
    const newer = pendingRequest({
      requesterRole: 'architect',
      requesteeRole: 'programmer',
      createdAt: '2026-04-26T11:00:00Z',
    });
    expect(pausedRequesteeFor('architect', [older, newer])).toBe('programmer');
    expect(pausedRequesteeFor('architect', [newer, older])).toBe('programmer');
  });

  it('pausedRequesteeFor возвращает undefined, если у роли нет pending как requester', () => {
    const request = pendingRequest({ requesterRole: 'architect', requesteeRole: 'programmer' });
    expect(pausedRequesteeFor('product', [request])).toBeUndefined();
    expect(pausedRequesteeFor('architect', [])).toBeUndefined();
    expect(pausedRequesteeFor('architect', undefined)).toBeUndefined();
  });

  it('idle для пустого чата', () => {
    // Сразу после создания рана сообщений ещё нет (или мы переключились
    // на сессию и chat пустой до прихода runs.get.result). Кубик не
    // должен мигать «working».
    const state = runState(
      {
        activeSessionId: 's1',
        sessions: [
          session({
            id: 's1',
            participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
          }),
        ],
      },
      chat()
    );
    expect(cubeStateFor('product', state)).toBe('idle');
  });
});
