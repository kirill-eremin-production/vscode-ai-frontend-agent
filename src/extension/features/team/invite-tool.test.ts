import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTeamInviteTool, INVITE_THROUGH_LEVEL_ERROR } from './invite-tool';
import {
  initRunDir,
  readChat,
  readSessionMeta,
  readToolEvents,
  type ToolEvent,
} from '@ext/entities/run/storage';
import type { Participant, RunMeta } from '@ext/entities/run/types';

/**
 * Юнит-тесты тула `team.invite` (#0037). Покрываем AC задачи:
 *
 *  1. architect → invite(product) — успех: продакт уже был участником
 *     корневой сессии, поэтому сценарий собирается на тройке участников
 *     и проверяет, что сообщение архитектора пишется от его имени.
 *  2. programmer → invite(product) — отказ: иерархия запрещает
 *     приглашение через уровень, текст ошибки содержит подсказку про
 *     `team.escalate`.
 *  3. architect → invite(architect) — отказ: areAdjacent(a, a) === false
 *     (соседство — это разные уровни, см. #0033).
 *  4. Идемпотентность повторного invite: pullIntoRoom — no-op, событие
 *     `participant_joined` не дублируется, но новое сообщение в чат всё
 *     равно записывается (это новый месседж в ту же комнату).
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
 * invite». Например, для теста «architect зовёт product» исходный
 * состав — `[user, architect]` (архитектор уже работает с человеком),
 * после invite добавится `product`.
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

describe('team.invite — happy path: architect зовёт product', () => {
  it('добавляет участника, пишет сообщение архитектора и возвращает обновлённый состав', async () => {
    // Стартовое состояние: архитектор в комнате с пользователем; продакта
    // в участниках нет. Это валидный сценарий: на ранах с автостартом
    // программиста после архитектора может появиться сценарий, когда
    // архитектор тащит продакта обратно для уточнения.
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
    ]);

    const tool = buildTeamInviteTool('architect');
    const result = (await tool.handler(
      { targetRole: 'product', message: 'Уточни, пожалуйста, требование X' },
      { ...HANDLER_CONTEXT, runId }
    )) as { sessionId: string; participants: Participant[] };

    // Возвращённое участие — текущий состав, включая нового продакта.
    expect(result.sessionId).toBe(sessionId);
    expect(result.participants).toEqual([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'product' },
    ]);

    // На диске participants действительно обновился (а не только в
    // возврате) — страховка от случайного `return` без persist.
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

    // Сообщение в чате есть, ровно одно, от имени caller'а (архитектор),
    // с тем самым текстом — это и есть «message от caller».
    const chat = await readChat(runId, sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0].from).toBe('agent:architect');
    expect(chat[0].text).toBe('Уточни, пожалуйста, требование X');
  });
});

describe('team.invite — запрет приглашать через уровень', () => {
  it('programmer → invite(product) бросает ошибку с подсказкой про team.escalate', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'programmer' }]);

    const tool = buildTeamInviteTool('programmer');
    // Текст ошибки ВАЖЕН: это сигнал модели, как достучаться до продакта
    // правильным путём. Поэтому проверяем буквально константу из тула.
    await expect(
      tool.handler({ targetRole: 'product', message: 'irrelevant' }, { ...HANDLER_CONTEXT, runId })
    ).rejects.toThrow(INVITE_THROUGH_LEVEL_ERROR);
  });
});

describe('team.invite — нельзя пригласить самого себя', () => {
  it('architect → invite(architect): areAdjacent(a, a) === false → ошибка', async () => {
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'architect' }]);

    const tool = buildTeamInviteTool('architect');
    // По AC: areAdjacent('architect', 'architect') === false (см. #0033),
    // поэтому тул отдаёт ту же ошибку, что и при «через уровень». Это
    // ок: текст подсказки одинаково релевантен (модель сразу видит, что
    // её путь некорректен; конкретный кейс «invite себя» — следствие
    // плохого system prompt'а, а не отдельная ветка).
    await expect(
      tool.handler(
        { targetRole: 'architect', message: 'sanity ping' },
        { ...HANDLER_CONTEXT, runId }
      )
    ).rejects.toThrow(INVITE_THROUGH_LEVEL_ERROR);
  });
});

describe('team.invite — идемпотентность повторного invite', () => {
  it('второй invite той же роли: участник не дублируется, событие — нет, сообщение — да', async () => {
    const { runId, sessionId } = await initRoom([
      { kind: 'user' },
      { kind: 'agent', role: 'architect' },
    ]);

    const tool = buildTeamInviteTool('architect');

    await tool.handler(
      { targetRole: 'product', message: 'первый invite' },
      { ...HANDLER_CONTEXT, runId }
    );

    // Второй invite той же роли — pullIntoRoom внутри увидит, что
    // продакт уже в составе, и вернёт undefined. Тул при этом всё
    // равно записывает новое сообщение в чат.
    const second = (await tool.handler(
      { targetRole: 'product', message: 'второй invite — это просто новый месседж' },
      { ...HANDLER_CONTEXT, runId }
    )) as { sessionId: string; participants: Participant[] };

    // Состав не изменился между двумя invite — продакт в участниках
    // остался ровно одним экземпляром.
    const products = second.participants.filter(
      (participant) => participant.kind === 'agent' && participant.role === 'product'
    );
    expect(products).toHaveLength(1);

    // Событие `participant_joined` записано ровно один раз (за первый
    // invite). Идемпотентность тула опирается на идемпотентность
    // pullIntoRoom (#0036) — этот тест её закрепляет на уровне тула.
    const events = await readToolEvents(runId, sessionId);
    const joined = events.filter((event) => event.kind === 'participant_joined');
    expect(joined).toHaveLength(1);

    // А вот сообщений в чате — два (по одному на каждый invite). Это
    // ожидаемое поведение по AC: повторный invite — это новый месседж.
    const chat = await readChat(runId, sessionId);
    expect(chat).toHaveLength(2);
    expect(chat.map((message) => message.text)).toEqual([
      'первый invite',
      'второй invite — это просто новый месседж',
    ]);
  });
});
