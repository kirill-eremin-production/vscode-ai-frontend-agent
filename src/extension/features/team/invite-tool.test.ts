import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildTeamInviteTool,
  INVITE_THROUGH_LEVEL_ERROR,
  type TeamInviteResult,
} from './invite-tool';
import {
  appendChatMessage,
  initRunDir,
  readChat,
  readSessionMeta,
  readToolEvents,
  type ToolEvent,
} from '@ext/entities/run/storage';
import { listMeetingRequests } from '@ext/entities/run/meeting-request';
import type { Participant, RunMeta } from '@ext/entities/run/types';

/**
 * Юнит-тесты тула `team.invite` (#0037 + интеграция с meeting-request из
 * #0051). Покрываем AC обеих задач:
 *
 *  1. architect → invite(product), product idle — успех (kind:'invited'):
 *     участник добавлен, сообщение записано, событие participant_joined
 *     лог.
 *  2. programmer → invite(product) — отказ: иерархия запрещает
 *     приглашение через уровень, текст ошибки содержит подсказку про
 *     `team.escalate`.
 *  3. architect → invite(architect) — отказ: areAdjacent(a, a) === false
 *     (соседство — это разные уровни, см. #0033).
 *  4. #0051: invite адресату, который уже занят в той же ране →
 *     возвращается `kind:'queued'`, создан meeting-request, состав
 *     текущей сессии не меняется (никаких pullIntoRoom).
 *  5. #0051: повторный invite в комнате, где первый invite уже
 *     направил сообщение приглашённому — приглашённый теперь busy,
 *     второй invite возвращает queued (а не дублирует pullIntoRoom).
 *
 * Тесты ходят в реальный fs через `__TEST_WORKSPACE__` и моков нет:
 * это надёжнее, чем мокать `pullIntoRoom`/`appendChatMessage`, и заодно
 * страхует от рассинхронизации тулa с storage-API.
 */

const HANDLER_CONTEXT = { runId: '', toolCallId: 'test-call' };

function freshRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/** Базовая RunMeta без полей, которые проставит initRunDir. */
function baseMeta(runId: string): Omit<RunMeta, 'activeSessionId' | 'sessions' | 'usage'> {
  return {
    id: runId,
    title: 'invite-test',
    prompt: 'prompt',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Создать ран с активной сессией, в которой уже есть `participants`.
 * Для AC #0037 нам важно, чтобы стартовый состав отражал «комнату до
 * invite».
 */
async function initRoom(
  participants: Participant[]
): Promise<{ runId: string; sessionId: string }> {
  const runId = freshRunId();
  const meta = await initRunDir(baseMeta(runId), {
    kind: 'agent-agent',
    participants,
  });
  return { runId, sessionId: meta.activeSessionId };
}

describe('team.invite — happy path: architect зовёт idle-product', () => {
  it('добавляет участника, пишет сообщение архитектора и возвращает kind:"invited"', async () => {
    // Стартовое состояние: архитектор в комнате с пользователем; продакта
    // в участниках нет, и у продакта нет других сессий → roleStateFor
    // вернёт idle, идём по ветке pullIntoRoom.
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
    ]);

    const tool = buildTeamInviteTool('architect');
    const result = (await tool.handler(
      { targetRole: 'product', message: 'Уточни, пожалуйста, требование X' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamInviteResult;

    // Узкий narrow по дискриминатору — дальше работаем со структурой
    // `invited`-ветки. Если бы тут оказался queued, это было бы
    // регрессией: продакт у нас точно idle, narrow упадёт понятной
    // строкой и тест зафиксирует регрессию.
    expect(result.kind).toBe('invited');
    if (result.kind !== 'invited') return;

    expect(result.sessionId).toBe(sessionId);
    expect(result.participants).toEqual([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'product' },
    ]);

    // На диске participants действительно обновился.
    const session = await readSessionMeta(runId, sessionId);
    expect(session?.participants).toEqual(result.participants);

    // Системное событие `participant_joined` записано ровно один раз
    // и для приглашённой роли (а не для caller'а).
    const events = await readToolEvents(runId, sessionId);
    const joined = events.filter(
      (event): event is Extract<ToolEvent, { kind: 'participant_joined' }> =>
        event.kind === 'participant_joined'
    );
    expect(joined).toHaveLength(1);
    expect(joined[0].role).toBe('product');

    // Сообщение в чате есть, ровно одно, от имени caller'а.
    const chat = await readChat(runId, sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].from).toBe('agent:architect');
    expect(chat[0].text).toBe('Уточни, пожалуйста, требование X');

    // Заявок на встречу при idle-пути не создаётся.
    const requests = await listMeetingRequests(runId);
    expect(requests).toHaveLength(0);
  });
});

describe('team.invite — запрет приглашать через уровень', () => {
  it('programmer → invite(product) бросает ошибку с подсказкой про team.escalate', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'programmer' }]);

    const tool = buildTeamInviteTool('programmer');
    await expect(
      tool.handler({ targetRole: 'product', message: 'irrelevant' }, { ...HANDLER_CONTEXT, runId })
    ).rejects.toThrow(INVITE_THROUGH_LEVEL_ERROR);
  });
});

describe('team.invite — нельзя пригласить самого себя', () => {
  it('architect → invite(architect): areAdjacent(a, a) === false → ошибка', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'architect' }]);

    const tool = buildTeamInviteTool('architect');
    await expect(
      tool.handler(
        { targetRole: 'architect', message: 'sanity ping' },
        { ...HANDLER_CONTEXT, runId }
      )
    ).rejects.toThrow(INVITE_THROUGH_LEVEL_ERROR);
  });
});

describe('team.invite — #0051: занятый адресат → queued meeting-request', () => {
  it('создаёт meeting-request и не трогает участников/чат текущей сессии', async () => {
    // Стартовое состояние: продакт занят в собственной сессии — пользователь
    // прислал ему сообщение, продакт ещё не ответил. По roleStateFor
    // (#0048) это `busy`. Архитектор в этом же ране хочет позвать
    // продакта — тул должен поставить заявку в очередь, не «перетаскивая»
    // занятого продакта.
    const productRunId = freshRunId();
    const productMeta = await initRunDir(baseMeta(productRunId), {
      kind: 'user-agent',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
      status: 'running',
    });
    // Сообщение от пользователя → продакт busy.
    await appendChatMessage(productRunId, {
      id: 'm-user',
      from: 'user',
      at: new Date().toISOString(),
      text: 'привет, продакт',
    });
    const sessionId = productMeta.activeSessionId;

    const tool = buildTeamInviteTool('architect');
    const result = (await tool.handler(
      { targetRole: 'product', message: 'нужен консилиум' },
      { ...HANDLER_CONTEXT, runId: productRunId }
    )) as TeamInviteResult;

    // Ветка queued: получаем id заявки и роль адресата.
    expect(result.kind).toBe('queued');
    if (result.kind !== 'queued') return;
    expect(result.requesteeRole).toBe('product');
    expect(result.meetingRequestId).toMatch(/.+/);

    // Заявка действительно записана и pending.
    const requests = await listMeetingRequests(productRunId);
    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe(result.meetingRequestId);
    expect(requests[0].status).toBe('pending');
    expect(requests[0].requesterRole).toBe('architect');
    expect(requests[0].requesteeRole).toBe('product');
    expect(requests[0].message).toBe('нужен консилиум');

    // Состав исходной сессии не изменился: архитектора в продактовую
    // сессию никто не «втащил».
    const session = await readSessionMeta(productRunId, sessionId);
    expect(session?.participants).toEqual([{ kind: 'user' }, { kind: 'agent', role: 'product' }]);

    // В чат текущей сессии тоже ничего не добавлено — только исходное
    // сообщение пользователя.
    const chat = await readChat(productRunId, sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].from).toBe('user');
  });
});

describe('team.invite — #0051: повторный invite на занятого адресата', () => {
  it('второй invite той же роли возвращает queued, не дублирует pullIntoRoom', async () => {
    // После первого invite архитектор оставил сообщение продакту в общей
    // комнате — продакт стал busy (lastMessageFrom = agent:architect,
    // не от продакта). Второй invite в этом же ране должен попасть в
    // queued, потому что target теперь занят.
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
    ]);

    const tool = buildTeamInviteTool('architect');
    const first = (await tool.handler(
      { targetRole: 'product', message: 'первый invite' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamInviteResult;
    expect(first.kind).toBe('invited');

    const second = (await tool.handler(
      { targetRole: 'product', message: 'продолжение разговора' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamInviteResult;
    expect(second.kind).toBe('queued');
    if (second.kind !== 'queued') return;
    expect(second.requesteeRole).toBe('product');

    // Состав не изменился: pullIntoRoom второй раз НЕ вызывался,
    // событие participant_joined ровно одно (за первый invite).
    const session = await readSessionMeta(runId, sessionId);
    const products =
      session?.participants.filter(
        (participant) => participant.kind === 'agent' && participant.role === 'product'
      ) ?? [];
    expect(products).toHaveLength(1);
    const events = await readToolEvents(runId, sessionId);
    const joined = events.filter((event) => event.kind === 'participant_joined');
    expect(joined).toHaveLength(1);

    // Чат не получил второе сообщение (оно лежит в meeting-request,
    // а не в чате текущей сессии). Только первое от architect'а.
    const chat = await readChat(runId, sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].text).toBe('первый invite');

    // Заявка зарегистрирована.
    const requests = await listMeetingRequests(runId);
    expect(requests).toHaveLength(1);
    expect(requests[0].message).toBe('продолжение разговора');
  });
});
