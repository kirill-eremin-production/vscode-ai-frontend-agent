import { describe, expect, it } from 'vitest';
import { reconstructHistory } from './resume';
import type { LoopConfig, ToolEvent } from '@ext/entities/run/storage';

/**
 * Unit-тесты восстановления истории чата для resume после перезапуска
 * VS Code или после нового сообщения пользователя в `awaiting_human`.
 * Полностью детерминированно: на вход — `LoopConfig` + список событий +
 * `ResumeIntent`, на выход — `ChatMessage[]` строго определённой формы.
 */

const baseConfig: LoopConfig = {
  model: 'm',
  systemPrompt: 'SYSTEM',
  toolNames: ['ask_user'],
  userMessage: 'USER',
  role: 'smoke',
};

/** Утилита: дефолтный `answer`-intent — упрощает тесты, где хвост не важен. */
const answerIntent = (id = 'pending', text = 'answer') =>
  ({ kind: 'answer', pendingToolCallId: id, userAnswer: text }) as const;

describe('reconstructHistory', () => {
  it('кладёт system + user первыми двумя сообщениями', () => {
    const history = reconstructHistory(baseConfig, [], answerIntent());
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
    const history = reconstructHistory(baseConfig, events, answerIntent('c1', 'a'));
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
    const history = reconstructHistory(baseConfig, events, answerIntent());
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
    const history = reconstructHistory(baseConfig, events, answerIntent());
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
    const history = reconstructHistory(baseConfig, events, answerIntent());
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
    const history = reconstructHistory(baseConfig, events, answerIntent());
    // Только system + user + хвостовой tool-ответ пользователя.
    expect(history).toHaveLength(3);
  });

  it('answer-intent добавляет ответ пользователя как role:tool с привязкой к pendingToolCallId', () => {
    const history = reconstructHistory(baseConfig, [], answerIntent('pending-id', 'мой ответ'));
    const last = history[history.length - 1];
    expect(last).toEqual({
      role: 'tool',
      tool_call_id: 'pending-id',
      content: JSON.stringify({ result: { answer: 'мой ответ' } }),
    });
  });

  it('continue-intent добавляет новое сообщение пользователя как role:user', () => {
    const history = reconstructHistory(baseConfig, [], {
      kind: 'continue',
      userMessage: 'доработай бриф',
    });
    const last = history[history.length - 1];
    expect(last).toEqual({ role: 'user', content: 'доработай бриф' });
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
    const history = reconstructHistory(baseConfig, events, answerIntent('pending', 'final'));
    // system, user, assistant#1, tool#1, assistant#2, hint-tool — итого 6.
    expect(history).toHaveLength(6);
    expect(history[2].role).toBe('assistant');
    expect(history[3].role).toBe('tool');
    expect(history[4].role).toBe('assistant');
    expect(history[5].role).toBe('tool');
  });

  it('continue-intent после длинной истории просто дописывает user в самый конец', () => {
    const events: ToolEvent[] = [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: 'финальный бриф',
      },
    ];
    const history = reconstructHistory(baseConfig, events, {
      kind: 'continue',
      userMessage: 'добавь раздел про метрики',
    });
    // system, user, assistant(финал), user(новый ввод) — итого 4.
    expect(history).toHaveLength(4);
    expect(history[2]).toEqual({ role: 'assistant', content: 'финальный бриф' });
    expect(history[3]).toEqual({ role: 'user', content: 'добавь раздел про метрики' });
  });
});

/**
 * Слайсинг истории по моменту `participant_joined` для роли (#0040).
 *
 * Проверяем оба пути: роль, добавленная в комнату по ходу сессии (есть
 * запись `participant_joined` с её ролью), и роль, которая была среди
 * `participants` с создания сессии (`participant_joined` для неё нет).
 * Базовая идея: для «новенького» события до его прихода складываются
 * в единый system-блок «контекст до твоего прихода», за ним идёт
 * system-маркер, далее обычная история; для «старожила» история одна
 * на всю сессию, как было до #0040.
 */
describe('reconstructHistory — slicing по participant_joined (#0040)', () => {
  /**
   * Тайминги фиктивные, главное — упорядочены и разделяемы:
   * msgN — обычные события, jAt — момент входа programmer'а (между
   * msg2 и msg3), nextN — события уже после входа.
   */
  const t = {
    msg1: '2026-04-26T10:00:01.000Z',
    msg2: '2026-04-26T10:00:02.000Z',
    jAt: '2026-04-26T10:00:02.500Z',
    msg3: '2026-04-26T10:00:03.000Z',
    msg4: '2026-04-26T10:00:04.000Z',
    msg5: '2026-04-26T10:00:05.000Z',
    next1: '2026-04-26T10:00:06.000Z',
    next2: '2026-04-26T10:00:07.000Z',
    next3: '2026-04-26T10:00:08.000Z',
  } as const;

  /** Фабрика «5 chat-событий + participant_joined в середине + 3 chat-события». */
  const buildRoomEvents = (): ToolEvent[] => [
    { kind: 'assistant', at: t.msg1, content: 'msg1' },
    { kind: 'assistant', at: t.msg2, content: 'msg2' },
    { kind: 'participant_joined', at: t.jAt, role: 'programmer' },
    { kind: 'assistant', at: t.msg3, content: 'msg3' },
    { kind: 'assistant', at: t.msg4, content: 'msg4' },
    { kind: 'assistant', at: t.msg5, content: 'msg5' },
    { kind: 'assistant', at: t.next1, content: 'next1' },
    { kind: 'assistant', at: t.next2, content: 'next2' },
    { kind: 'assistant', at: t.next3, content: 'next3' },
  ];

  /** LoopConfig для роли programmer — добавлена в комнату по ходу сессии. */
  const programmerConfig: LoopConfig = {
    model: 'm',
    systemPrompt: 'PROG',
    toolNames: [],
    userMessage: 'plan.md',
    role: 'programmer',
  };

  /** LoopConfig для роли product — была участником с создания сессии. */
  const productConfig: LoopConfig = {
    model: 'm',
    systemPrompt: 'PROD',
    toolNames: [],
    userMessage: 'brief',
    role: 'product',
  };

  it('для роли с participant_joined: события до joinedAt уходят в pre-блок, далее маркер, далее post-секция', () => {
    const events = buildRoomEvents();
    const intent = { kind: 'continue', userMessage: 'продолжай' } as const;

    const history = reconstructHistory(programmerConfig, events, intent);

    // [0] system promo + [1] user — стартовый базис, как обычно.
    expect(history[0]).toEqual({ role: 'system', content: 'PROG' });
    expect(history[1]).toEqual({ role: 'user', content: 'plan.md' });

    // [2] pre-блок: одно system-сообщение, заголовок + msg1 + msg2.
    expect(history[2].role).toBe('system');
    const preContent = (history[2] as { content: string }).content;
    expect(preContent).toContain('Контекст до твоего прихода');
    expect(preContent).toContain('msg1');
    expect(preContent).toContain('msg2');
    // События после joinedAt в pre-блок не попали.
    expect(preContent).not.toContain('msg3');
    expect(preContent).not.toContain('next1');

    // [3] system-маркер ровно по формулировке из issue #0040.
    expect(history[3]).toEqual({
      role: 'system',
      content:
        'Тебя только что добавили в эту сессию. Выше — история чата до твоего прихода. Отвечай по последнему сообщению.',
    });

    // [4] system: «в сессию вошла роль: programmer» — дубль маркера, но
    // полезен как видимая отметка момента в общей канве post-секции.
    expect(history[4]).toEqual({
      role: 'system',
      content: 'В сессию вошла роль: programmer.',
    });

    // [5..10] msg3..msg5 + next1..next3 — обычные assistant ChatMessage'и.
    expect(history.slice(5, 11).map((message) => (message as { content: string }).content)).toEqual(
      ['msg3', 'msg4', 'msg5', 'next1', 'next2', 'next3']
    );

    // [11] хвост continue-intent — новое сообщение пользователя.
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'продолжай' });

    // Полный размер: system + user + pre-block + marker + joined-as-system
    // + 6 assistant + intent-tail = 12.
    expect(history).toHaveLength(12);
  });

  it('для роли-«старожила» без participant_joined: вся история одной лентой + событие входа другой роли видно как system', () => {
    const events = buildRoomEvents();
    const intent = { kind: 'continue', userMessage: 'продолжай' } as const;

    const history = reconstructHistory(productConfig, events, intent);

    // Стартовый базис.
    expect(history[0]).toEqual({ role: 'system', content: 'PROD' });
    expect(history[1]).toEqual({ role: 'user', content: 'brief' });

    // Никакого pre-блока и маркера: их добавляют только если у роли
    // есть собственное participant_joined в журнале.
    const contents = history.map((message) =>
      typeof (message as { content: unknown }).content === 'string'
        ? (message as { content: string }).content
        : ''
    );
    expect(contents).not.toContain(
      'Тебя только что добавили в эту сессию. Выше — история чата до твоего прихода. Отвечай по последнему сообщению.'
    );
    expect(
      contents.find((content) => content.includes('Контекст до твоего прихода'))
    ).toBeUndefined();

    // Все 8 assistant-сообщений на местах.
    const assistantContents = history
      .filter((message) => message.role === 'assistant')
      .map((message) => (message as { content: string }).content);
    expect(assistantContents).toEqual([
      'msg1',
      'msg2',
      'msg3',
      'msg4',
      'msg5',
      'next1',
      'next2',
      'next3',
    ]);

    // Событие входа programmer'а — отдельным system-сообщением.
    expect(contents).toContain('В сессию вошла роль: programmer.');

    // Хвост — новое сообщение пользователя.
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'продолжай' });

    // Полный размер: system + user + 8 assistant + 1 system(joined) + intent-tail = 12.
    expect(history).toHaveLength(12);
  });

  it('идемпотентность: повторный вызов с теми же входами даёт идентичный результат', () => {
    // Воссоздаём независимые входы дважды — резумер при повторной
    // активации (#0040: «Идемпотентность при повторной активации»)
    // должен получить ровно тот же контекст, что и при первой.
    const intent = { kind: 'answer', pendingToolCallId: 'pending', userAnswer: 'ok' } as const;

    const firstHistory = reconstructHistory(programmerConfig, buildRoomEvents(), intent);
    const secondHistory = reconstructHistory(programmerConfig, buildRoomEvents(), intent);

    expect(secondHistory).toEqual(firstHistory);
  });

  it('pre-блок включает tool_calls и tool_results в текстовом виде', () => {
    // Срез берётся не только по чисто текстовым assistant'ам: события
    // с tool_calls и tool_result'ы тоже должны попасть в дамп, иначе
    // у роли пропадает ключевая часть контекста (что вызывали и что
    // вернулось до её прихода).
    const events: ToolEvent[] = [
      {
        kind: 'assistant',
        at: t.msg1,
        content: null,
        tool_calls: [{ id: 'c1', name: 'kb.read', arguments: '{"path":"a.md"}' }],
      },
      {
        kind: 'tool_result',
        at: t.msg2,
        tool_call_id: 'c1',
        tool_name: 'kb.read',
        result: { exists: true, content: 'A' },
      },
      { kind: 'participant_joined', at: t.jAt, role: 'programmer' },
      { kind: 'assistant', at: t.msg3, content: 'after' },
    ];

    const history = reconstructHistory(programmerConfig, events, {
      kind: 'continue',
      userMessage: 'go',
    });

    const preContent = (history[2] as { content: string }).content;
    expect(preContent).toContain('kb.read');
    expect(preContent).toContain('{"path":"a.md"}');
    expect(preContent).toContain('"result"');
  });

  it('participant_joined с at === joinedAt попадает в post-секцию (как пометка о моменте входа)', () => {
    // Запись `participant_joined` с at, равным joinedAt, не должна
    // утечь в pre-блок: пользователь, читая дамп, не должен видеть
    // запись о собственном входе как «контекст ДО прихода».
    const events: ToolEvent[] = [
      { kind: 'assistant', at: t.msg1, content: 'before' },
      { kind: 'participant_joined', at: t.jAt, role: 'programmer' },
      { kind: 'assistant', at: t.msg3, content: 'after' },
    ];

    const history = reconstructHistory(programmerConfig, events, {
      kind: 'continue',
      userMessage: 'go',
    });

    const preContent = (history[2] as { content: string }).content;
    expect(preContent).not.toContain('в сессию вошла роль: programmer');

    // Зеркальная проверка: в post-секции (после маркера) эта запись
    // присутствует ровно как одно system-сообщение.
    const joinedNotices = history.filter(
      (message) =>
        message.role === 'system' &&
        (message as { content: string }).content === 'В сессию вошла роль: programmer.'
    );
    expect(joinedNotices).toHaveLength(1);
  });

  it('пустой pre-блок не добавляется в историю (когда до joinedAt релевантных событий нет)', () => {
    // Если до момента входа роль видела только `system`-события
    // (диагностика, не для модели), пустой system-блок с одним лишь
    // заголовком только зашумит контекст. Проверяем, что мы его не
    // отправляем — оставляем только маркер.
    const events: ToolEvent[] = [
      { kind: 'system', at: t.msg1, message: 'diag' },
      { kind: 'participant_joined', at: t.jAt, role: 'programmer' },
      { kind: 'assistant', at: t.msg3, content: 'after' },
    ];

    const history = reconstructHistory(programmerConfig, events, {
      kind: 'continue',
      userMessage: 'go',
    });

    // [0] system, [1] user, [2] marker (без pre-блока), [3] joined-as-system,
    // [4] assistant 'after', [5] intent-tail.
    expect(history).toHaveLength(6);
    expect(history[2]).toEqual({
      role: 'system',
      content:
        'Тебя только что добавили в эту сессию. Выше — история чата до твоего прихода. Отвечай по последнему сообщению.',
    });
  });
});
