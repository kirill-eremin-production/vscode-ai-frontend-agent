import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePending } from './meeting-resolver';
import {
  createSession,
  initRunDir,
  appendChatMessage,
  readMeta,
  readChat,
} from '../entities/run/storage';
import { createMeetingRequest, listMeetingRequests } from '../entities/run/meeting-request';
import { setMeetingWakeupHandler } from './meeting-wakeup';
import type { Participant, RunMeta } from '../entities/run/types';

/**
 * Юнит-тесты meeting-resolver (#0050).
 *
 * Покрываем ровно AC задачи:
 *  - pending-запрос к idle-роли резолвится в новую сессию (с записью
 *    `message` инициатора первым сообщением и `prev = [contextSessionId]`);
 *  - pending к busy-роли остаётся pending;
 *  - bidirectional pending → оба `failed` со ссылкой на роли в reason;
 *  - несколько pending к одной роли — резолв самого старого по
 *    `createdAt`, остальные — still_pending.
 *
 * Дополнительно фиксируем «нет заявок → пустой результат» как быстрый
 * путь и инвариант: тест не должен трогать диск, если незачем.
 */

function freshRunId(): string {
  return `run-resolver-${crypto.randomUUID()}`;
}

/**
 * Минимальная RunMeta для теста — `initRunDir` сам проставит
 * `activeSessionId`/`sessions[]`/`usage`.
 */
function makeBaseMeta(runId: string): Omit<RunMeta, 'activeSessionId' | 'sessions' | 'usage'> {
  return {
    id: runId,
    title: 'test',
    prompt: 'prompt',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const USER_PRODUCT: Participant[] = [{ kind: 'user' }, { kind: 'agent', role: 'product' }];

/** Создать ран с одной user-agent сессией продакта. */
async function initProductRun(runId: string): Promise<RunMeta> {
  return initRunDir(makeBaseMeta(runId), {
    kind: 'user-agent',
    participants: USER_PRODUCT,
    status: 'awaiting_human',
  });
}

describe('resolvePending — пустой случай', () => {
  it('возвращает пустой массив, если pending-заявок нет', async () => {
    const runId = freshRunId();
    await initProductRun(runId);
    expect(await resolvePending(runId)).toEqual([]);
  });
});

describe('resolvePending — резолв к idle-роли', () => {
  it('создаёт новую agent-agent сессию с участниками-парой и пишет message от инициатора', async () => {
    // Сценарий: продакт работает в корневой сессии (последнее сообщение
    // от него самого → продакт idle), отправляет запрос архитектору.
    // Архитектор тоже idle (нет своих сессий). Resolver должен поднять
    // комнату product↔architect и положить туда сообщение продакта.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    // Симулируем: продакт ответил пользователю — последнее сообщение
    // от продакта, значит он idle (никто его не ждёт).
    await appendChatMessage(runId, {
      id: 'm1',
      from: 'agent:product',
      at: new Date().toISOString(),
      text: 'Готов передать архитектору',
    });

    const request = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'привет, нужен план',
    });

    const results = await resolvePending(runId);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'resolved', requestId: request.id });
    const resolved = results[0];
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') return;

    // 1) Заявка переведена в resolved с resolvedSessionId.
    const requests = await listMeetingRequests(runId);
    expect(requests[0].status).toBe('resolved');
    expect(requests[0].resolvedSessionId).toBe(resolved.sessionId);

    // 2) Создана новая сессия-комната с парой ролей и prev = [контекст].
    const meta = await readMeta(runId);
    const room = meta?.sessions.find((session) => session.id === resolved.sessionId);
    expect(room).toBeDefined();
    expect(room?.kind).toBe('agent-agent');
    expect(room?.participants).toEqual([
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ]);
    expect(room?.prev).toEqual([initial.activeSessionId]);

    // 3) В чате комнаты — ровно одно сообщение от инициатора с тем
    //    же текстом, что был в заявке.
    const chat = await readChat(runId, resolved.sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].from).toBe('agent:product');
    expect(chat[0].text).toBe('привет, нужен план');
  });
});

describe('resolvePending — busy-роль не резолвит', () => {
  it('оставляет заявку pending, если адресат сейчас busy', async () => {
    // Архитектор busy: к нему обращена активная сессия (последнее
    // сообщение от продакта, архитектор должен ответить). Заявка к
    // архитектору должна остаться pending.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    // Делаем архитектора busy через bridge-сессию product↔architect,
    // где последнее сообщение от продакта.
    const bridge = await createSession(runId, {
      kind: 'agent-agent',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
      prev: [initial.activeSessionId],
      status: 'running',
    });
    await appendChatMessage(
      runId,
      {
        id: 'm1',
        from: 'agent:product',
        at: new Date().toISOString(),
        text: 'привет',
      },
      bridge.session.id
    );

    const request = await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'обсудить эскалацию',
    });

    const results = await resolvePending(runId);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'still_pending', requestId: request.id });

    // Журнал не тронут: заявка по-прежнему pending.
    const requests = await listMeetingRequests(runId);
    expect(requests[0].status).toBe('pending');
    expect(requests[0].resolvedSessionId).toBeUndefined();
  });
});

describe('resolvePending — bidirectional deadlock', () => {
  it('обе встречные заявки переводятся в failed с понятным reason', async () => {
    // Продакт зовёт архитектора, архитектор одновременно зовёт продакта.
    // Никто не свободен ответить первым (оба ждут друг друга через
    // `awaiting_input` → roleStateFor по AC #0048). Resolver обязан
    // разорвать deadlock, помечая обе заявки failed с одинаковым reason.
    const runId = freshRunId();
    const initial = await initProductRun(runId);

    const requestPA = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'plan?',
    });
    const requestAP = await createMeetingRequest(runId, {
      requesterRole: 'architect',
      requesteeRole: 'product',
      contextSessionId: initial.activeSessionId,
      message: 'brief?',
    });

    const results = await resolvePending(runId);

    // Оба результата — failed.
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') continue;
      // Reason должен явно упоминать обе вовлечённые роли.
      expect(result.reason).toContain('product');
      expect(result.reason).toContain('architect');
      expect(result.reason).toContain('deadlock');
    }
    const ids = results.map((result) => result.requestId).sort();
    expect(ids).toEqual([requestPA.id, requestAP.id].sort());

    // На диске обе заявки в failed.
    const requests = await listMeetingRequests(runId);
    expect(requests.every((request) => request.status === 'failed')).toBe(true);
    expect(requests.every((request) => request.failureReason?.includes('deadlock'))).toBe(true);
  });
});

describe('resolvePending — несколько pending к одной роли', () => {
  it('резолвит самый старый, остальные оставляет pending', async () => {
    // Два запроса к архитектору: от продакта (старый) и от программиста
    // (свежий). Архитектор idle — должна подняться сессия с продактом,
    // запрос от программиста ждёт за ним.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    // Делаем продакта idle: ответил пользователю.
    await appendChatMessage(runId, {
      id: 'm1',
      from: 'agent:product',
      at: new Date().toISOString(),
      text: 'я свободен',
    });

    const oldRequest = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'нужен план',
    });
    // Гарантируем, что createdAt у нового запроса строго позже.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newRequest = await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'эскалация',
    });

    const results = await resolvePending(runId);

    // Старый — resolved, новый — still_pending за старым.
    const resolved = results.find((result) => result.kind === 'resolved');
    const stillPending = results.find((result) => result.kind === 'still_pending');
    expect(resolved?.requestId).toBe(oldRequest.id);
    expect(stillPending?.requestId).toBe(newRequest.id);

    const requests = await listMeetingRequests(runId);
    const byId = new Map(requests.map((request) => [request.id, request] as const));
    expect(byId.get(oldRequest.id)?.status).toBe('resolved');
    expect(byId.get(newRequest.id)?.status).toBe('pending');
  });
});

describe('resolvePending — #0051: подтянуть idle-промежуточные роли цепочки escalate', () => {
  it('программист эскалирует к продакту, архитектор idle → после резолва он в комнате', async () => {
    // Сценарий из AC #0051: «escalate с busy product, idle architect →
    // request создан, после резолва в комнате есть architect (как
    // промежуточный)». Здесь target — продакт, busy была не цепочка
    // целиком, а только адресат (продакт). Архитектор в это время idle —
    // значит при резолве комнаты резолвер ОБЯЗАН подтянуть его как
    // промежуточный через `pullIntermediateIdleRoles`, иначе цепочка
    // коммуникации программист↔продакт окажется разорвана.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    // Делаем продакта idle (последнее сообщение — от него самого).
    await appendChatMessage(runId, {
      id: 'm-product',
      from: 'agent:product',
      at: new Date().toISOString(),
      text: 'я свободен',
    });

    // Заявка от программиста к продакту: rolesBetween(programmer, product)
    // → ['architect']. Программист и архитектор — оба idle (нет ни своих
    // сессий, ни pending-заявок), поэтому архитектор должен попасть в
    // новую комнату.
    await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'product',
      contextSessionId: initial.activeSessionId,
      message: 'нужно срочное уточнение',
    });

    const results = await resolvePending(runId);

    expect(results).toHaveLength(1);
    const resolved = results[0];
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') return;

    // Состав комнаты: requester + requestee + intermediate (architect).
    // Порядок не фиксируем — pullIntermediateIdleRoles добавляет
    // architect-а ПОСЛЕ создания сессии с парой [programmer, product].
    const meta = await readMeta(runId);
    const room = meta?.sessions.find((session) => session.id === resolved.sessionId);
    expect(room).toBeDefined();
    const roomRoles = room!.participants
      .filter(
        (participant): participant is Extract<Participant, { kind: 'agent' }> =>
          participant.kind === 'agent'
      )
      .map((participant) => participant.role)
      .sort();
    expect(roomRoles).toEqual(['architect', 'product', 'programmer']);
  });

  it('busy-промежуточный пропускается, заявка всё равно резолвится только requester+requestee', async () => {
    // Контр-сценарий: архитектор busy (висит bridge-сессия с продактом
    // → последнее сообщение от продакта). Программист эскалирует к
    // продакту. Решение #0051 (упрощённое): занятого посредника НЕ
    // дёргаем — он будет подтянут позже на следующем триггере, когда
    // освободится. Заявка резолвится без архитектора.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    // Делаем архитектора busy через bridge-сессию (последнее сообщение
    // от продакта — архитектор должен ответить).
    const bridge = await createSession(runId, {
      kind: 'agent-agent',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
      prev: [initial.activeSessionId],
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

    await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'product',
      contextSessionId: initial.activeSessionId,
      message: 'нужно срочно',
    });

    const results = await resolvePending(runId);

    expect(results.some((result) => result.kind === 'resolved')).toBe(true);
    const resolved = results.find((result) => result.kind === 'resolved');
    if (resolved?.kind !== 'resolved') return;

    const meta = await readMeta(runId);
    const room = meta?.sessions.find((session) => session.id === resolved.sessionId);
    const roomRoles = room!.participants
      .filter(
        (participant): participant is Extract<Participant, { kind: 'agent' }> =>
          participant.kind === 'agent'
      )
      .map((participant) => participant.role)
      .sort();
    // Архитектор НЕ подтянут — он остался занят в bridge-сессии.
    expect(roomRoles).toEqual(['product', 'programmer']);
  });
});

describe('resolvePending — #0051: notifyMeetingWakeup вызывается с реальными параметрами', () => {
  afterEach(() => {
    // Снимаем стаб handler-а: иначе следующие тесты в файле/сюте
    // увидят его побочки. setMeetingWakeupHandler(undefined) штатный
    // путь снятия (см. реализацию в meeting-wakeup.ts).
    setMeetingWakeupHandler(undefined);
  });

  it('после резолва handler получает runId, meetingRequestId, requester/requestee и resolvedSessionId', async () => {
    // AC #0051: «при резолве agent-loop инициатора пробуждается с
    // системным сообщением». Прямой проверки resume здесь не нужно
    // (это покрывает loop.test.ts > paused и resume.test.ts > meeting_resolved);
    // здесь убеждаемся, что резолвер РЕАЛЬНО зовёт wake-up handler с
    // полным набором параметров — без них resumer не сможет восстановить
    // контекст инициатора.
    const wakeupHandler = vi.fn(async () => {});
    setMeetingWakeupHandler(wakeupHandler);

    const runId = freshRunId();
    const initial = await initProductRun(runId);
    await appendChatMessage(runId, {
      id: 'm-product',
      from: 'agent:product',
      at: new Date().toISOString(),
      text: 'свободен',
    });
    const request = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'нужен план',
    });

    const results = await resolvePending(runId);
    const resolved = results.find((result) => result.kind === 'resolved');
    expect(resolved).toBeDefined();
    if (resolved?.kind !== 'resolved') return;

    // Резолвер не await'ит handler (fire-and-forget), но делает это в
    // том же микротик-кадре через `void notifyMeetingWakeup(...)`. К
    // моменту, когда resolvePending вернул, handler уже синхронно
    // зарегистрировал вызов — vi.fn это видит.
    expect(wakeupHandler).toHaveBeenCalledTimes(1);
    expect(wakeupHandler).toHaveBeenCalledWith({
      runId,
      meetingRequestId: request.id,
      requesterRole: 'product',
      requesteeRole: 'architect',
      resolvedSessionId: resolved.sessionId,
    });
  });
});

describe('resolvePending — повторный вызов idempotent для уже резолвнутых', () => {
  it('второй прогон не создаёт новых сессий и не трогает resolved-заявки', async () => {
    // Фиксируем «безопасность повторного триггера»: resolver вызывают и
    // на активации, и на завершении сессий — он не должен генерить
    // дубликаты при двух вызовах подряд.
    const runId = freshRunId();
    const initial = await initProductRun(runId);
    await appendChatMessage(runId, {
      id: 'm1',
      from: 'agent:product',
      at: new Date().toISOString(),
      text: 'идём дальше',
    });
    await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: initial.activeSessionId,
      message: 'привет',
    });

    const firstResults = await resolvePending(runId);
    const metaAfterFirst = await readMeta(runId);
    const sessionsAfterFirst = metaAfterFirst?.sessions.length ?? 0;

    const secondResults = await resolvePending(runId);
    const metaAfterSecond = await readMeta(runId);
    const sessionsAfterSecond = metaAfterSecond?.sessions.length ?? 0;

    expect(firstResults.some((result) => result.kind === 'resolved')).toBe(true);
    // Второй прогон видит pending-список пустым → быстрый выход.
    expect(secondResults).toEqual([]);
    expect(sessionsAfterSecond).toBe(sessionsAfterFirst);
  });
});
