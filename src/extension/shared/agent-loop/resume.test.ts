import { describe, expect, it } from 'vitest';
import { reconstructHistory } from './resume';
import type { LoopConfig, ToolEvent } from '@ext/entities/run/storage';

/**
 * Unit-тесты восстановления истории чата для resume после перезапуска
 * VS Code. Полностью детерминированно: на вход — `LoopConfig` + список
 * событий, на выход — `ChatMessage[]` строго определённой формы.
 */

const baseConfig: LoopConfig = {
  model: 'm',
  systemPrompt: 'SYSTEM',
  toolNames: ['ask_user'],
  userMessage: 'USER',
  role: 'smoke',
};

describe('reconstructHistory', () => {
  it('кладёт system + user первыми двумя сообщениями', () => {
    const history = reconstructHistory(baseConfig, [], 'pending', 'answer');
    expect(history[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(history[1]).toEqual({ role: 'user', content: 'USER' });
  });

  it('преобразует assistant-событие с tool_calls в ChatMessage с function-обёрткой', () => {
    const events: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [{ id: 'c1', name: 'ask_user', arguments: '{"question":"q"}' }],
      },
    ];
    const history = reconstructHistory(baseConfig, events, 'c1', 'a');
    const assistant = history[2];
    expect(assistant).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'ask_user', arguments: '{"question":"q"}' },
        },
      ],
    });
  });

  it('assistant без tool_calls не получает поле tool_calls', () => {
    const events: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: 'plain text',
      },
    ];
    const history = reconstructHistory(baseConfig, events, 'pending', 'answer');
    expect(history[2]).toEqual({ role: 'assistant', content: 'plain text' });
    expect('tool_calls' in (history[2] as object)).toBe(false);
  });

  it('tool_result с result упаковывается в JSON-строку content', () => {
    const events: ToolEvent[] = [
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'c1',
        tool_name: 'kb.read',
        result: { exists: true, content: 'hi' },
      },
    ];
    const history = reconstructHistory(baseConfig, events, 'pending', 'answer');
    expect(history[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ result: { exists: true, content: 'hi' } }),
    });
  });

  it('tool_result с error пакует error, а не result', () => {
    const events: ToolEvent[] = [
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'c1',
        tool_name: 'kb.read',
        error: 'sandbox violation',
      },
    ];
    const history = reconstructHistory(baseConfig, events, 'pending', 'answer');
    expect(history[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ error: 'sandbox violation' }),
    });
  });

  it('system-события не попадают в историю', () => {
    const events: ToolEvent[] = [
      { kind: 'system', at: '2026-04-26T10:00:00.000Z', message: 'restart' },
    ];
    const history = reconstructHistory(baseConfig, events, 'pending', 'answer');
    // Только system + user + хвостовой tool-ответ пользователя.
    expect(history).toHaveLength(3);
  });

  it('добавляет ответ пользователя как role:tool с привязкой к pendingToolCallId', () => {
    const history = reconstructHistory(baseConfig, [], 'pending-id', 'мой ответ');
    const last = history[history.length - 1];
    expect(last).toEqual({
      role: 'tool',
      tool_call_id: 'pending-id',
      content: JSON.stringify({ result: { answer: 'мой ответ' } }),
    });
  });

  it('сохраняет порядок событий в истории', () => {
    const events: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [{ id: 'a', name: 'ask_user', arguments: '{}' }],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:00:01.000Z',
        tool_call_id: 'a',
        tool_name: 'ask_user',
        result: { answer: 'first' },
      },
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:02.000Z',
        content: 'thinking',
      },
    ];
    const history = reconstructHistory(baseConfig, events, 'pending', 'final');
    // system, user, assistant#1, tool#1, assistant#2, hint-tool — итого 6.
    expect(history).toHaveLength(6);
    expect(history[2].role).toBe('assistant');
    expect(history[3].role).toBe('tool');
    expect(history[4].role).toBe('assistant');
    expect(history[5].role).toBe('tool');
  });
});
