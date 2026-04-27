import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Юнит-тесты agent-loop'а — на этой итерации (#0051) фокус ровно на
 * ветке `paused`: если хоть один tool вернул `{kind: 'queued',
 * meetingRequestId}`, цикл обязан корректно довести текущий пакет
 * tool_call'ов до конца и вернуть `{kind: 'paused', ...}` без
 * следующей итерации к модели.
 *
 * `chat` из openrouter/client мокается на уровне модуля — это
 * единственный способ дать loop'у детерминированный ответ модели без
 * реальных HTTP-запросов. Storage и broadcast гоняются «по-честному»
 * через `__TEST_WORKSPACE__` (см. `tests/setup-vscode.ts`) — иначе
 * `recordToolEvent` упал бы на отсутствии RunMeta.
 */

vi.mock('@ext/shared/openrouter/client', async () => {
  const actual = await vi.importActual<typeof import('@ext/shared/openrouter/client')>(
    '@ext/shared/openrouter/client'
  );
  return {
    ...actual,
    chat: vi.fn(),
  };
});

import { runAgentLoop, type ToolDefinition, type ToolRegistry } from './index';
import { chat, type ChatResponse } from '@ext/shared/openrouter/client';
import { initRunDir, readToolEvents } from '@ext/entities/run/storage';
import { _resetValidatorCache } from './validator';
import type { Participant, RunMeta } from '@ext/entities/run/types';

const chatMock = vi.mocked(chat);

function freshRunId(): string {
  return `run-loop-${crypto.randomUUID()}`;
}

function baseMeta(runId: string): Omit<RunMeta, 'activeSessionId' | 'sessions' | 'usage'> {
  return {
    id: runId,
    title: 'loop-test',
    prompt: 'prompt',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

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

/**
 * Сборщик assistant-ответа модели для мока `chat`. Поля минимально
 * достаточные: модель «вызывает один тул» — этого хватает, чтобы loop
 * прошёл валидацию и попал в ветку выполнения tool_call'ов.
 */
function assistantWithToolCall(
  toolName: string,
  args: object,
  toolCallId = 'call-1'
): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        },
      ],
    },
    model: 'mock-model',
    finishReason: 'tool_calls',
  };
}

beforeEach(() => {
  chatMock.mockReset();
  // Сбрасываем кэш валидаторов: ajv-функции компилируются по имени тула,
  // а в этом файле разные тесты переиспользуют одни и те же имена
  // (`fake.queue`, `fake.side`) с разными схемами. Без сброса второй тест
  // увидел бы валидатор первого и упал бы на «несовпадении required».
  _resetValidatorCache();
});

afterEach(() => {
  chatMock.mockReset();
});

describe('runAgentLoop — paused при queued tool-result (#0051)', () => {
  it('возвращает kind:"paused" с meetingRequestId после первого queued-вызова', async () => {
    // Заводим минимальный ран — нужен только для записи событий через
    // recordToolEvent: фактическая логика тула здесь синтетическая.
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'architect' }]);

    // Тестовый тул, имитирующий queued-результат от team.invite/escalate.
    // Контракт ровно тот, который ловит `extractQueuedMeetingRequestId`
    // в loop.ts: kind:'queued' + meetingRequestId как строка.
    const queueTool: ToolDefinition<{ targetRole: string }> = {
      name: 'fake.queue',
      description: 'returns queued meeting-request to simulate paused branch',
      schema: {
        type: 'object',
        properties: { targetRole: { type: 'string' } },
        required: ['targetRole'],
        additionalProperties: false,
      },
      handler: async () => ({
        kind: 'queued',
        meetingRequestId: 'mr-fake-1',
        requesteeRole: 'product',
      }),
    };
    const tools: ToolRegistry = new Map([[queueTool.name, queueTool as ToolDefinition]]);

    chatMock.mockResolvedValueOnce(assistantWithToolCall('fake.queue', { targetRole: 'product' }));

    const result = await runAgentLoop({
      runId,
      apiKey: 'x',
      model: 'mock-model',
      systemPrompt: 'sys',
      userMessage: 'user',
      tools,
    });

    // Главная проверка: loop вышел в paused-ветку, id заявки прокинут
    // ровно тот, что вернул тул. `iterations` равен 1 — pause выходит
    // после tool_call'ов первой итерации, не делая повторного запроса.
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') return;
    expect(result.meetingRequestId).toBe('mr-fake-1');
    expect(result.iterations).toBe(1);
    expect(result.reason).toContain('mr-fake-1');

    // Loop НЕ обращался к модели повторно: ровно один вызов chat'а.
    // Это инвариант: pause тормозит цикл сразу после tool_call'ов
    // первой итерации, не давая модели увидеть «что произошло потом».
    expect(chatMock).toHaveBeenCalledTimes(1);

    // В tools.jsonl рана появилась system-запись с упоминанием
    // meeting-request id — её ждёт диагностика и e2e (TC-58).
    const events = await readToolEvents(runId);
    const pauseSystem = events.find(
      (event) => event.kind === 'system' && event.message.includes('mr-fake-1')
    );
    expect(pauseSystem).toBeDefined();
  });

  it('доводит все tool_call-ы шага до конца, прежде чем выйти в paused', async () => {
    // Если модель в одном шаге попросила два тула, и первый из них
    // вернул queued — мы всё равно обязаны выполнить второй и записать
    // его tool_result в историю. Иначе на resume tool_call/tool_result
    // распарилось бы (модели нужно увидеть результаты ВСЕХ её вызовов
    // одного шага). См. комментарий в loop.ts около `pausedRequestId`.
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'architect' }]);

    const queueTool: ToolDefinition = {
      name: 'fake.queue',
      description: 'queued',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({
        kind: 'queued',
        meetingRequestId: 'mr-double',
        requesteeRole: 'product',
      }),
    };
    const sideToolHandler = vi.fn(async () => ({ ok: true }));
    const sideTool: ToolDefinition = {
      name: 'fake.side',
      description: 'plain side-effect tool',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: sideToolHandler,
    };
    const tools: ToolRegistry = new Map([
      [queueTool.name, queueTool],
      [sideTool.name, sideTool],
    ]);

    // Один assistant-ответ с двумя tool_calls'ами: queue первым, side
    // вторым. Loop должен исполнить оба, не прервавшись на queued.
    chatMock.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-q',
            type: 'function',
            function: { name: 'fake.queue', arguments: '{}' },
          },
          {
            id: 'call-s',
            type: 'function',
            function: { name: 'fake.side', arguments: '{}' },
          },
        ],
      },
      model: 'mock-model',
      finishReason: 'tool_calls',
    });

    const result = await runAgentLoop({
      runId,
      apiKey: 'x',
      model: 'mock-model',
      systemPrompt: 'sys',
      userMessage: 'user',
      tools,
    });

    expect(result.kind).toBe('paused');
    // Сайд-тул всё-таки был выполнен — это ключевая проверка
    // «доводим пакет до конца».
    expect(sideToolHandler).toHaveBeenCalledTimes(1);
    // И его tool_result записан в журнал — модели на resume будет что
    // увидеть как ответ на свой call-s.
    const events = await readToolEvents(runId);
    const sideResult = events.find(
      (event) => event.kind === 'tool_result' && event.tool_call_id === 'call-s'
    );
    expect(sideResult).toBeDefined();
  });

  it('обычный путь без queued: loop возвращает completed, paused не срабатывает', async () => {
    // Контр-проверка: queued-детектор не должен ложно-срабатывать на
    // тулах, которые возвращают что угодно другое. Здесь handler даёт
    // просто `{ok: true}` — это невалидный «маркер queued» (нет kind),
    // и loop должен пройти обычной веткой completed.
    const { runId } = await initRoom([{ kind: 'user' }, { kind: 'agent', role: 'architect' }]);

    const plainTool: ToolDefinition = {
      name: 'fake.plain',
      description: 'plain',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true }),
    };
    const tools: ToolRegistry = new Map([[plainTool.name, plainTool]]);

    // Сначала assistant вызывает тул, на следующей итерации — финал.
    chatMock.mockResolvedValueOnce(assistantWithToolCall('fake.plain', {})).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'готово', tool_calls: undefined },
      model: 'mock-model',
      finishReason: 'stop',
    });

    const result = await runAgentLoop({
      runId,
      apiKey: 'x',
      model: 'mock-model',
      systemPrompt: 'sys',
      userMessage: 'user',
      tools,
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.finalContent).toBe('готово');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
});
