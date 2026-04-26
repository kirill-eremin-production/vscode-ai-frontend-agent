import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunStorageError,
  addUsageToActiveSession,
  appendToolEvent,
  createSession,
  findPendingAsk,
  getKnowledgeRoot,
  initRunDir,
  readMeta,
  readSessionMeta,
  resolveKnowledgePath,
  setActiveSession,
  writeLoopConfig,
  readLoopConfig,
  writeMeta,
  type ToolEvent,
} from './storage';
import type { Participant, RunMeta } from './types';

/**
 * Unit-тесты файлового хранилища.
 *
 * Цель — закрыть детерминированную логику: sandbox knowledge-base, поиск
 * pending ask_user в логе, атомарность записи (temp + rename), накопление
 * usage и создание дополнительных сессий (готовится к #0013).
 *
 * VS Code API замокан в `tests/setup-vscode.ts`, реальный fs работает
 * на временной директории из `__TEST_WORKSPACE__`.
 */

function freshRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

/**
 * База RunMeta для теста. `initRunDir` сам проставит `activeSessionId`,
 * `sessions[]` и `usage` — поэтому здесь только обязательные поля без них.
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

const PRODUCT_PARTICIPANTS: Participant[] = [{ kind: 'user' }, { kind: 'agent', role: 'product' }];

/** Шорткат для тестов: создать ран с одной user-agent сессией. */
async function initTestRun(runId: string): Promise<RunMeta> {
  return initRunDir(makeBaseMeta(runId), {
    kind: 'user-agent',
    participants: PRODUCT_PARTICIPANTS,
  });
}

describe('resolveKnowledgePath', () => {
  it('возвращает абсолютный путь внутри knowledge root для валидного relative', () => {
    const resolved = resolveKnowledgePath('product/glossary/term.md');
    expect(resolved.startsWith(getKnowledgeRoot() + path.sep)).toBe(true);
    expect(resolved.endsWith(path.join('product', 'glossary', 'term.md'))).toBe(true);
  });

  it('допускает пустую строку — это сам корень knowledge', () => {
    expect(resolveKnowledgePath('')).toBe(getKnowledgeRoot());
  });

  it('бросает RunStorageError при попытке выйти через `..`', () => {
    expect(() => resolveKnowledgePath('../escape.md')).toThrow(RunStorageError);
    expect(() => resolveKnowledgePath('product/../../escape.md')).toThrow(RunStorageError);
  });

  it('бросает RunStorageError при абсолютном пути', () => {
    expect(() => resolveKnowledgePath('/etc/passwd')).toThrow(RunStorageError);
  });

  it('не путает префикс: `knowledge-evil` не должен считаться внутри `knowledge`', () => {
    expect(() => resolveKnowledgePath('../knowledge-evil/x.md')).toThrow(RunStorageError);
  });
});

describe('initRunDir / readMeta / sessions layout', () => {
  it('создаёт ран + первую сессию и возвращает полную RunMeta', async () => {
    const runId = freshRunId();
    const meta = await initTestRun(runId);

    expect(meta.id).toBe(runId);
    expect(meta.activeSessionId).toMatch(/^s_[0-9a-f]+$/);
    expect(meta.sessions).toHaveLength(1);
    expect(meta.sessions[0].id).toBe(meta.activeSessionId);
    expect(meta.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      lastTotalTokens: 0,
      lastModel: null,
    });
  });

  it('readMeta возвращает то же, что initRunDir', async () => {
    const runId = freshRunId();
    const meta = await initTestRun(runId);
    expect(await readMeta(runId)).toEqual(meta);
  });

  it('readMeta возвращает undefined для отсутствующего рана', async () => {
    expect(await readMeta('does-not-exist-' + crypto.randomUUID())).toBeUndefined();
  });

  it('создаёт ожидаемую структуру директорий: meta.json + sessions/<sid>/{meta.json,chat.jsonl}', async () => {
    const runId = freshRunId();
    const meta = await initTestRun(runId);
    const runDir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    expect(await fs.readdir(runDir)).toContain('meta.json');
    expect(await fs.readdir(runDir)).toContain('sessions');

    const sessionDir = path.join(runDir, 'sessions', meta.activeSessionId);
    const sessionEntries = await fs.readdir(sessionDir);
    expect(sessionEntries).toContain('meta.json');
    expect(sessionEntries).toContain('chat.jsonl');
  });

  it('SessionMeta совпадает с тем, что озвучено в RunMeta.sessions[]', async () => {
    const runId = freshRunId();
    const meta = await initTestRun(runId);
    const sessionMeta = await readSessionMeta(runId, meta.activeSessionId);
    expect(sessionMeta).toBeDefined();
    expect(sessionMeta?.id).toBe(meta.activeSessionId);
    expect(sessionMeta?.kind).toBe('user-agent');
    expect(sessionMeta?.participants).toEqual(PRODUCT_PARTICIPANTS);
  });

  it('writeMeta атомарен: на диске нет .tmp после успешной записи', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    const dir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    const entries = await fs.readdir(dir);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('writeMeta пишет в .tmp до rename — финальный файл не трогается до завершения', async () => {
    // Циклический объект ломает JSON.stringify → writeMeta должен бросить
    // и оставить старое содержимое meta.json целым.
    const runId = freshRunId();
    const meta = await initTestRun(runId);
    const dir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    const before = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');

    const cyclic: Record<string, unknown> = { ...meta };
    cyclic.self = cyclic;
    await expect(writeMeta(cyclic as unknown as RunMeta)).rejects.toThrow();

    const after = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('createSession + setActiveSession (готовность к #0013)', () => {
  it('создаёт вторую сессию и автоматически делает её активной', async () => {
    const runId = freshRunId();
    const initial = await initTestRun(runId);
    const result = await createSession(runId, {
      kind: 'user-agent',
      participants: PRODUCT_PARTICIPANTS,
      parentSessionId: initial.activeSessionId,
      status: 'running',
    });

    expect(result.run.activeSessionId).toBe(result.session.id);
    expect(result.run.sessions).toHaveLength(2);
    expect(result.session.parentSessionId).toBe(initial.activeSessionId);
    expect(result.session.status).toBe('running');
    expect(result.run.status).toBe('running'); // зеркало активной сессии

    // Старая сессия лежит в sessions[] и доступна через readSessionMeta.
    const oldSessionMeta = await readSessionMeta(runId, initial.activeSessionId);
    expect(oldSessionMeta).toBeDefined();
  });

  it('setActiveSession переключает фокус и переносит status', async () => {
    const runId = freshRunId();
    const initial = await initTestRun(runId);
    const created = await createSession(runId, {
      kind: 'user-agent',
      participants: PRODUCT_PARTICIPANTS,
      status: 'awaiting_human',
    });

    // Переключаемся обратно на initial — статус рана должен подтянуть
    // статус initial-сессии, а не остаться от только что созданной.
    const back = await setActiveSession(runId, initial.activeSessionId);
    expect(back?.activeSessionId).toBe(initial.activeSessionId);
    expect(back?.status).toBe('draft');

    // Туда — обратно: статус рана = статус новой сессии.
    const forward = await setActiveSession(runId, created.session.id);
    expect(forward?.status).toBe('awaiting_human');
  });

  it('setActiveSession кидает на несуществующую сессию', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    await expect(setActiveSession(runId, 's_does_not_exist')).rejects.toThrow(RunStorageError);
  });
});

/**
 * #0034: формат `participants` — массив длины ≥ 1 (а не пара).
 *
 * Покрытие:
 *  - read-time normalization старого session-meta без массива участников
 *    (`agentRole`/`kind` восстанавливаются в массив длины 2);
 *  - round-trip новых сессий длины 2 и 3 — write/read возвращает
 *    исходный массив без перестановок и потерь.
 */
describe('participants — массив произвольной длины (#0034)', () => {
  /**
   * Подменить файл session-meta legacy-объектом на диске. Используем
   * прямой fs.writeFile, чтобы обойти типизацию SessionMeta — старые
   * файлы реально были без `participants`, так что симулируем именно
   * фактическое содержимое, а не текущую TypeScript-форму.
   */
  async function writeLegacySessionMetaRaw(
    runId: string,
    sessionId: string,
    raw: Record<string, unknown>
  ): Promise<void> {
    const filePath = path.join(
      globalThis.__TEST_WORKSPACE__,
      '.agents',
      'runs',
      runId,
      'sessions',
      sessionId,
      'meta.json'
    );
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), 'utf8');
  }

  it('readSessionMeta нормализует legacy meta.json без participants → [user, agent:product]', async () => {
    const runId = freshRunId();
    const initial = await initTestRun(runId);
    // Старый формат: только `agentRole` и `kind`, никакого массива.
    await writeLegacySessionMetaRaw(runId, initial.activeSessionId, {
      id: initial.activeSessionId,
      runId,
      kind: 'user-agent',
      agentRole: 'product',
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        lastTotalTokens: 0,
        lastModel: null,
      },
    });

    const meta = await readSessionMeta(runId, initial.activeSessionId);
    expect(meta?.participants).toEqual([{ kind: 'user' }, { kind: 'agent', role: 'product' }]);
  });

  it('readSessionMeta нормализует legacy agent-agent → пара продакт+архитектор', async () => {
    const runId = freshRunId();
    const initial = await initTestRun(runId);
    await writeLegacySessionMetaRaw(runId, initial.activeSessionId, {
      id: initial.activeSessionId,
      runId,
      kind: 'agent-agent',
      // agentRole отсутствует — должен сработать дефолт 'product' и вторая
      // роль определиться по правилу «пара мостов до #0034».
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        lastTotalTokens: 0,
        lastModel: null,
      },
    });

    const meta = await readSessionMeta(runId, initial.activeSessionId);
    expect(meta?.participants).toEqual([
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ]);
  });

  it('readMeta нормализует sessions[].participants для legacy-summary', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    // Перезаписываем RunMeta.sessions[0] без поля participants — имитация
    // ранов, созданных до #0023, где summary ещё не дублировал список.
    const runDir = path.join(globalThis.__TEST_WORKSPACE__, '.agents', 'runs', runId);
    const rawMeta = JSON.parse(await fs.readFile(path.join(runDir, 'meta.json'), 'utf8')) as {
      sessions: Array<Record<string, unknown>>;
    };
    for (const session of rawMeta.sessions) {
      delete session.participants;
    }
    await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify(rawMeta, null, 2), 'utf8');

    const reread = await readMeta(runId);
    expect(reread?.sessions[0].participants).toEqual([
      { kind: 'user' },
      { kind: 'agent', role: 'product' },
    ]);
  });

  it('создание сессии с парой участников: round-trip через диск возвращает массив длины 2', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    const pair: Participant[] = [
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ];
    const result = await createSession(runId, { kind: 'agent-agent', participants: pair });
    expect(result.session.participants).toEqual(pair);

    const reread = await readSessionMeta(runId, result.session.id);
    expect(reread?.participants).toEqual(pair);

    const meta = await readMeta(runId);
    const summary = meta?.sessions.find((s) => s.id === result.session.id);
    expect(summary?.participants).toEqual(pair);
  });

  it('создание сессии с тройкой участников (комната): round-trip сохраняет длину 3', async () => {
    // Это будущий кейс из #0036/#0038 — комната, в которую подтянули
    // дополнительного агента или пользователя. На уровне storage задача
    // #0034 уже должна обеспечить корректную сериализацию N>2.
    const runId = freshRunId();
    await initTestRun(runId);
    const trio: Participant[] = [
      { kind: 'agent', role: 'programmer' },
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'product' },
    ];
    const result = await createSession(runId, { kind: 'agent-agent', participants: trio });
    expect(result.session.participants).toHaveLength(3);

    const reread = await readSessionMeta(runId, result.session.id);
    expect(reread?.participants).toEqual(trio);

    const meta = await readMeta(runId);
    const summary = meta?.sessions.find((s) => s.id === result.session.id);
    expect(summary?.participants).toEqual(trio);
  });
});

describe('addUsageToActiveSession (#0008)', () => {
  it('накапливает токены и стоимость в активной сессии и в RunMeta', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    await addUsageToActiveSession(runId, {
      model: 'm',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUsd: 0.001,
    });
    const after = await addUsageToActiveSession(runId, {
      model: 'm',
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
      costUsd: 0.002,
    });
    expect(after.session?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      costUsd: 0.001 + 0.002,
      lastTotalTokens: 280,
      lastModel: 'm',
    });
    expect(after.run?.usage.inputTokens).toBe(300);
    expect(after.run?.usage.outputTokens).toBe(130);
    expect(after.run?.usage.lastTotalTokens).toBe(280);
  });

  it('costUsd становится null, если хоть один шаг был на модели без тарифа (TC-27)', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    await addUsageToActiveSession(runId, {
      model: 'known',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0.0001,
    });
    const result = await addUsageToActiveSession(runId, {
      model: 'unknown/model',
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      costUsd: null,
    });
    expect(result.session?.usage.costUsd).toBeNull();
    expect(result.run?.usage.costUsd).toBeNull();
    // Токены при этом всё равно копятся — важно для UI: «стоимость
    // не смогли посчитать» ≠ «модель не работала».
    expect(result.run?.usage.inputTokens).toBe(30);
    expect(result.run?.usage.outputTokens).toBe(15);
    expect(result.run?.usage.lastModel).toBe('unknown/model');
  });
});

describe('writeLoopConfig / readLoopConfig (per-session)', () => {
  it('round-trip конфиг через диск без потерь', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    const config = {
      model: 'openai/gpt-x',
      systemPrompt: 'system',
      toolNames: ['kb.read', 'ask_user'],
      userMessage: 'hi',
      role: 'smoke',
      temperature: 0.2,
    };
    await writeLoopConfig(runId, config);
    expect(await readLoopConfig(runId)).toEqual(config);
  });

  it('readLoopConfig возвращает undefined, если файла нет', async () => {
    const runId = freshRunId();
    await initTestRun(runId);
    expect(await readLoopConfig(runId)).toBeUndefined();
  });
});

describe('findPendingAsk', () => {
  async function seedEvents(runId: string, events: ToolEvent[]): Promise<void> {
    await initTestRun(runId);
    for (const event of events) {
      await appendToolEvent(runId, event);
    }
  }

  it('возвращает undefined, если в логе нет ask_user', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: new Date().toISOString(),
        content: 'hello',
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('возвращает pending ask_user без ответа', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            name: 'ask_user',
            arguments: JSON.stringify({ question: 'нужен порт?', context: 'для dev-сервера' }),
          },
        ],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending).toEqual({
      toolCallId: 'call_1',
      question: 'нужен порт?',
      context: 'для dev-сервера',
      at: '2026-04-26T10:00:00.000Z',
    });
  });

  it('возвращает undefined, если ask_user уже получил tool_result', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'call_1', name: 'ask_user', arguments: JSON.stringify({ question: 'q' }) },
        ],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'call_1',
        tool_name: 'ask_user',
        result: { answer: 'ok' },
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('игнорирует не-ask_user tool_calls', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'call_1', name: 'kb.read', arguments: JSON.stringify({ path: 'x.md' }) },
        ],
      },
    ]);
    expect(await findPendingAsk(runId)).toBeUndefined();
  });

  it('возвращает самый поздний pending, если их несколько', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [
          { id: 'older', name: 'ask_user', arguments: JSON.stringify({ question: 'q1' }) },
        ],
      },
      {
        kind: 'tool_result',
        at: '2026-04-26T10:01:00.000Z',
        tool_call_id: 'older',
        tool_name: 'ask_user',
        result: { answer: 'a1' },
      },
      {
        kind: 'assistant',
        at: '2026-04-26T10:02:00.000Z',
        content: null,
        tool_calls: [
          { id: 'newer', name: 'ask_user', arguments: JSON.stringify({ question: 'q2' }) },
        ],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending?.toolCallId).toBe('newer');
  });

  it('не падает на битом JSON в arguments — возвращает пустой вопрос', async () => {
    const runId = freshRunId();
    await seedEvents(runId, [
      {
        kind: 'assistant',
        at: '2026-04-26T10:00:00.000Z',
        content: null,
        tool_calls: [{ id: 'call_x', name: 'ask_user', arguments: 'NOT JSON' }],
      },
    ]);
    const pending = await findPendingAsk(runId);
    expect(pending?.toolCallId).toBe('call_x');
    expect(pending?.question).toBe('(пустой вопрос)');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Точка для общих установок; пока пусто — тесты пишут в уникальные runId,
  // OS убирает temp-директорию между сессиями.
});
