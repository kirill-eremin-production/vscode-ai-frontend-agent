import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildTeamEscalateTool,
  ESCALATE_NOT_NEEDED_ERROR,
  type TeamEscalateResult,
} from './escalate-tool';
import {
  appendChatMessage,
  createSession,
  initRunDir,
  readChat,
  readSessionMeta,
  readToolEvents,
  setActiveSession,
  type ToolEvent,
} from '@ext/entities/run/storage';
import { listMeetingRequests } from '@ext/entities/run/meeting-request';
import type { Participant, RunMeta } from '@ext/entities/run/types';

/**
 * Юнит-тесты тула `team.escalate` (#0038). Покрываем AC задачи:
 *
 *  1. programmer → escalate(product) — happy path: в комнате
 *     оказываются programmer, architect и product (порядок неважен,
 *     но все три обязаны быть). Сообщение записано один раз от
 *     имени caller'а.
 *  2. product → escalate(programmer) — escalate работает в обе
 *     стороны: всё та же тройка участников.
 *  3. programmer → escalate(architect) — отказ (соседний уровень,
 *     нужен `team.invite`).
 *  4. programmer → escalate(programmer) — отказ (сам себе
 *     эскалировать бессмысленно).
 *
 * Тесты ходят в реальный fs через `__TEST_WORKSPACE__` и моков нет:
 * это надёжнее, чем мокать `pullIntoRoom`/`appendChatMessage`, и
 * заодно страхует от рассинхронизации тула с storage-API.
 */

const HANDLER_CONTEXT = { runId: '', toolCallId: 'test-call' };

function freshRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/** Базовая RunMeta без полей, которые проставит initRunDir. */
function baseMeta(runId: string): Omit<RunMeta, 'activeSessionId' | 'sessions' | 'usage'> {
  return {
    id: runId,
    title: 'escalate-test',
    prompt: 'prompt',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Создать ран с активной сессией, в которой уже есть `participants`.
 * Стартовый состав отражает «комнату до escalate»: например, для
 * сценария «программист зовёт продакта» — это `[user, programmer]`.
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

describe('team.escalate — happy path: programmer → product', () => {
  it('добавляет архитектора и продакта, пишет одно сообщение от программиста, возвращает цепочку', async () => {
    // Стартовое состояние: программист в сессии с пользователем,
    // архитектора и продакта в участниках нет. Программист хочет
    // достучаться до продакта — обязан затащить и архитектора.
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'programmer' },
    ]);

    const tool = buildTeamEscalateTool('programmer');
    const result = (await tool.handler(
      { targetRole: 'product', message: 'Нужно уточнить ТЗ — пригласил архитектора в свидетели' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamEscalateResult;

    // Все промежуточные роли idle (отсутствуют как участники), путь
    // happy → kind:'invited'. Narrow по дискриминатору фиксирует, что
    // никто из цепочки не превратился в queued.
    expect(result.kind).toBe('invited');
    if (result.kind !== 'invited') return;

    // sessionId — та же активная сессия (escalate не создаёт новую).
    expect(result.sessionId).toBe(sessionId);

    // participants содержит ВСЕ три роли (порядок не фиксируем по AC,
    // но все три обязаны быть). Используем `expect.arrayContaining`,
    // чтобы тест не падал из-за порядка пользователя в массиве.
    const roles = result.participants
      .filter(
        (participant): participant is Extract<Participant, { kind: 'agent' }> =>
          participant.kind === 'agent'
      )
      .map((participant) => participant.role);
    expect(roles).toEqual(expect.arrayContaining(['programmer', 'architect', 'product']));
    expect(roles).toHaveLength(3);

    // Цепочка идёт от caller'а к target'у через посредников.
    expect(result.chain).toEqual(['programmer', 'architect', 'product']);

    // На диске participants действительно обновился (а не только в
    // возврате) — страховка от случайного `return` без persist.
    const session = await readSessionMeta(runId, sessionId);
    expect(session?.participants).toEqual(result.participants);

    // Системное событие `participant_joined` записано РОВНО ДВА раза
    // (по одному на architect и product) и ни разу для caller'а
    // (программист уже был в комнате).
    const events = await readToolEvents(runId, sessionId);
    const joined = events.filter(
      (event): event is Extract<ToolEvent, { kind: 'participant_joined' }> =>
        event.kind === 'participant_joined'
    );
    expect(joined.map((event) => event.role)).toEqual(['architect', 'product']);

    // Сообщение в чате записано ровно один раз — после всех
    // pullIntoRoom (см. AC «Сообщение пишется один раз, после всех
    // pullIntoRoom»). Это инвариант: посредники видят message сразу
    // в полной комнате, не до подтягивания target'а.
    const chat = await readChat(runId, sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].from).toBe('agent:programmer');
    expect(chat[0].text).toBe('Нужно уточнить ТЗ — пригласил архитектора в свидетели');
  });
});

describe('team.escalate — happy path: product → programmer (обратное направление)', () => {
  it('escalate работает в обе стороны: продакт зовёт программиста через архитектора', async () => {
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'product' },
    ]);

    const tool = buildTeamEscalateTool('product');
    const result = (await tool.handler(
      { targetRole: 'programmer', message: 'Хочу уточнить, как ты планируешь это сделать' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamEscalateResult;
    expect(result.kind).toBe('invited');
    if (result.kind !== 'invited') return;

    // То же самое требование к участникам: programmer + architect +
    // product (порядок неважен), как и в обратном направлении.
    const roles = result.participants
      .filter(
        (participant): participant is Extract<Participant, { kind: 'agent' }> =>
          participant.kind === 'agent'
      )
      .map((participant) => participant.role);
    expect(roles).toEqual(expect.arrayContaining(['programmer', 'architect', 'product']));
    expect(roles).toHaveLength(3);

    // Цепочка отражает направление: от продакта вниз через архитектора.
    expect(result.chain).toEqual(['product', 'architect', 'programmer']);

    // События тоже отражают порядок добавления: сначала architect,
    // потом programmer. Caller (product) уже в комнате, для него
    // событие не пишется.
    const events = await readToolEvents(runId, sessionId);
    const joined = events.filter((event) => event.kind === 'participant_joined');
    expect(joined.map((event) => (event as { role: string }).role)).toEqual([
      'architect',
      'programmer',
    ]);
  });
});

describe('team.escalate — отказ для соседних уровней', () => {
  it('programmer → escalate(architect): соседний уровень → ошибка с подсказкой про invite', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'programmer' }]);

    const tool = buildTeamEscalateTool('programmer');
    // Архитектор — сосед программиста, escalate избыточен. Текст
    // ошибки буквально совпадает с константой тула — это сигнал
    // модели, что есть правильный путь (`team.invite`).
    await expect(
      tool.handler(
        { targetRole: 'architect', message: 'irrelevant' },
        { ...HANDLER_CONTEXT, runId }
      )
    ).rejects.toThrow(ESCALATE_NOT_NEEDED_ERROR);
  });
});

describe('team.escalate — отказ при caller === targetRole', () => {
  it('programmer → escalate(programmer): сам себе эскалировать бессмысленно', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'programmer' }]);

    const tool = buildTeamEscalateTool('programmer');
    // Эскалация на себя — частный случай «escalate не нужен».
    // Проверяем явно: areAdjacent(a, a) === false (см. #0033), поэтому
    // в тесте ловим именно ветку `caller === target`, а не «соседство».
    await expect(
      tool.handler(
        { targetRole: 'programmer', message: 'sanity ping' },
        { ...HANDLER_CONTEXT, runId }
      )
    ).rejects.toThrow(ESCALATE_NOT_NEEDED_ERROR);
  });
});

describe('team.escalate — #0051: занятый посредник в цепочке → queued', () => {
  it('создаёт meeting-request к target и не трогает текущую сессию', async () => {
    // Сценарий: программист хочет эскалировать к продакту. Архитектор
    // занят в собственной bridge-сессии (последнее сообщение от продакта
    // → архитектор busy). По AC #0051 escalate не должен «телепортировать»
    // занятого архитектора, а обязан поставить ОДИН meeting-request к
    // продакту и вернуть queued.
    const runId = `run-${crypto.randomUUID()}`;
    const meta = await initRunDir(baseMeta(runId), {
      kind: 'agent-agent',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'programmer' }],
    });
    const programmerSessionId = meta.activeSessionId;

    // Делаем архитектора busy через отдельную bridge-сессию product↔
    // architect, последнее сообщение в ней — от продакта (значит
    // архитектор должен ответить).
    const bridge = await createSession(runId, {
      kind: 'agent-agent',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
      prev: [programmerSessionId],
      status: 'running',
    });
    await appendChatMessage(
      runId,
      {
        id: 'm-bridge',
        from: 'agent:product',
        at: new Date().toISOString(),
        text: 'архитектор, проверь',
      },
      bridge.session.id
    );

    // createSession сместил activeSessionId на bridge — но тул вызывается
    // из программистского loop'а, в его собственной сессии. Возвращаем
    // активную обратно, чтобы воспроизвести реальный контекст вызова.
    await setActiveSession(runId, programmerSessionId);

    const tool = buildTeamEscalateTool('programmer');
    const result = (await tool.handler(
      { targetRole: 'product', message: 'нужно срочное уточнение' },
      { ...HANDLER_CONTEXT, runId }
    )) as TeamEscalateResult;

    expect(result.kind).toBe('queued');
    if (result.kind !== 'queued') return;
    expect(result.requesteeRole).toBe('product');

    // Заявка к продакту: ровно одна, со ссылкой на programmerSessionId
    // как контекст. Промежуточного архитектора отдельной заявкой не
    // создаём — резолвер сам подтянет его при резолве комнаты.
    const requests = await listMeetingRequests(runId);
    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe(result.meetingRequestId);
    expect(requests[0].requesterRole).toBe('programmer');
    expect(requests[0].requesteeRole).toBe('product');
    expect(requests[0].contextSessionId).toBe(programmerSessionId);
    expect(requests[0].message).toBe('нужно срочное уточнение');

    // Активная (программистская) сессия не получила новых participants
    // и сообщения — escalate не выполнял pullIntoRoom вообще.
    const session = await readSessionMeta(runId, programmerSessionId);
    expect(session?.participants).toEqual([
      { kind: 'user' },
      { kind: 'agent', role: 'programmer' },
    ]);
    const chat = await readChat(runId, programmerSessionId);
    expect(chat).toHaveLength(0);
    const events = await readToolEvents(runId, programmerSessionId);
    const joined = events.filter(
      (event): event is Extract<ToolEvent, { kind: 'participant_joined' }> =>
        event.kind === 'participant_joined'
    );
    expect(joined).toHaveLength(0);
  });
});
