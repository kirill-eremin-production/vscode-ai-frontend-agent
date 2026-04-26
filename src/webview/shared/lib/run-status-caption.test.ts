import { describe, it, expect } from 'vitest';
import { describeRunActivity } from './run-status-caption';
import type { RunMeta, ToolEvent } from '@shared/runs/types';

const META = (status: RunMeta['status']): Pick<RunMeta, 'status'> => ({ status });

describe('describeRunActivity', () => {
  it('draft → idle, «Готовлюсь к запуску…»', () => {
    const r = describeRunActivity({ meta: META('draft'), tools: [], role: 'product' });
    expect(r.kind).toBe('idle');
    expect(r.label).toBe('Готовлюсь к запуску…');
  });

  it('running без активного tool_call → thinking с именем роли', () => {
    const r = describeRunActivity({ meta: META('running'), tools: [], role: 'architect' });
    expect(r.kind).toBe('thinking');
    expect(r.label).toBe('Архитектор думает…');
  });

  it('running с pending tool_call → tool, имя тула в подписи', () => {
    const tools: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00Z',
        content: null,
        tool_calls: [{ id: 'c1', name: 'kb.read', arguments: '{}' }],
      },
    ];
    const r = describeRunActivity({ meta: META('running'), tools, role: 'product' });
    expect(r.kind).toBe('tool');
    expect(r.label).toBe('Продакт: вызов `kb.read`…');
  });

  it('running с завершённым tool_call → снова thinking', () => {
    const tools: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00Z',
        content: null,
        tool_calls: [{ id: 'c1', name: 'kb.read', arguments: '{}' }],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:00:01Z',
        tool_call_id: 'c1',
        tool_name: 'kb.read',
        result: {},
      },
    ];
    const r = describeRunActivity({ meta: META('running'), tools, role: 'product' });
    expect(r.kind).toBe('thinking');
  });

  it('awaiting_user_input → awaiting_user, ждёт ответ конкретной роли', () => {
    const r = describeRunActivity({
      meta: META('awaiting_user_input'),
      tools: [],
      role: 'product',
    });
    expect(r.kind).toBe('awaiting_user');
    expect(r.label).toBe('Продакт ждёт твой ответ');
  });

  it('awaiting_human → awaiting_human, «Готово — твой ход»', () => {
    const r = describeRunActivity({ meta: META('awaiting_human'), tools: [], role: 'product' });
    expect(r.kind).toBe('awaiting_human');
    expect(r.label).toBe('Готово — твой ход');
  });

  it('failed с ошибкой в последнем tool_result → label содержит причину', () => {
    const tools: ToolEvent[] = [
      {
        kind: 'tool_result',
        at: '2026-04-26T10:00:00Z',
        tool_call_id: 'c1',
        tool_name: 'kb.read',
        error: 'sandbox: путь вне корня',
      },
    ];
    const r = describeRunActivity({ meta: META('failed'), tools, role: 'product' });
    expect(r.kind).toBe('failed');
    expect(r.label).toContain('sandbox');
  });

  it('failed без tool-ошибок → fallback-подпись', () => {
    const r = describeRunActivity({ meta: META('failed'), tools: [], role: 'product' });
    expect(r.kind).toBe('failed');
    expect(r.label).toBe('Ошибка выполнения');
  });

  it('done → done, «Завершено»', () => {
    const r = describeRunActivity({ meta: META('done'), tools: [], role: 'product' });
    expect(r.kind).toBe('done');
    expect(r.label).toBe('Завершено');
  });
});
