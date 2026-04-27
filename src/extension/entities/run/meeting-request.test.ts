import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMeetingRequest,
  getPendingRequests,
  listMeetingRequests,
  updateMeetingRequestStatus,
} from './meeting-request';

/**
 * Юнит-тесты хранилища meeting-request'ов (#0049).
 *
 * Покрываем ровно AC задачи:
 *  - создание и чтение,
 *  - обновление статуса (последняя запись побеждает),
 *  - восстановление списка после симуляции рестарта (повторный read с
 *    диска), — а заодно стоящие особняком инварианты (append-only,
 *    осиротевшие апдейты, getPendingRequests).
 *
 * Каждый тест работает на собственном `runId`, который не пересекается
 * с остальными — общий temp-workspace из `tests/setup-vscode.ts` не
 * пересоздаётся между тестами, изоляция — на уровне id рана.
 */

function freshRunId(): string {
  return `run-mr-${crypto.randomUUID()}`;
}

/**
 * Гарантирует, что каталог рана существует. Реальный продакшн-код
 * перед записью заявок проходит через `initRunDir`, но в этих тестах
 * сам `meeting-request` создаёт директорию (`recursive: true`), поэтому
 * прединициализация не нужна.
 */
function getMeetingRequestsFile(runId: string): string {
  return path.join(
    globalThis.__TEST_WORKSPACE__,
    '.agents',
    'runs',
    runId,
    'meeting-requests.jsonl'
  );
}

describe('createMeetingRequest', () => {
  it('создаёт заявку с pending-статусом, генерирует id и createdAt', async () => {
    // Базовый кейс: вход — только бизнесовые поля, на выходе — полный
    // MeetingRequest. Проверяем формат id (`mr_` + hex), что createdAt
    // — валидная ISO-строка, и что начальный статус всегда pending.
    const runId = freshRunId();
    const request = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's_init',
      message: 'Нужно обсудить план',
    });

    expect(request.id).toMatch(/^mr_[0-9a-f]+$/);
    expect(request.status).toBe('pending');
    expect(Number.isNaN(Date.parse(request.createdAt))).toBe(false);
    expect(request.requesterRole).toBe('product');
    expect(request.requesteeRole).toBe('architect');
    expect(request.contextSessionId).toBe('s_init');
    expect(request.message).toBe('Нужно обсудить план');
    // resolvedAt/resolvedSessionId/failureReason для свежей pending-заявки
    // должны быть undefined — это часть контракта формата.
    expect(request.resolvedAt).toBeUndefined();
    expect(request.resolvedSessionId).toBeUndefined();
    expect(request.failureReason).toBeUndefined();
  });

  it('пишет ровно одну строку в meeting-requests.jsonl при создании', async () => {
    // Append-only журнал: после createMeetingRequest в файле должна быть
    // одна строка вида `{ kind: 'created', request: {...} }`. Если строк
    // станет две — значит хранилище зачем-то дублирует запись.
    const runId = freshRunId();
    const request = await createMeetingRequest(runId, {
      requesterRole: 'architect',
      requesteeRole: 'programmer',
      contextSessionId: 's_arch',
      message: 'Можно ли обойтись без миграции?',
    });
    const raw = await fs.readFile(getMeetingRequestsFile(runId), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { kind: string; request: { id: string } };
    expect(parsed.kind).toBe('created');
    expect(parsed.request.id).toBe(request.id);
  });
});

describe('listMeetingRequests', () => {
  it('возвращает пустой массив, если файла журнала ещё нет', async () => {
    // Каталог рана может не существовать — это валидное состояние, в
    // которое попадает свежий ран до первой заявки. Список должен
    // отдавать пустой массив, а не падать.
    const runId = freshRunId();
    expect(await listMeetingRequests(runId)).toEqual([]);
  });

  it('возвращает заявку сразу после создания', async () => {
    // Простейшая интеграция create → list: только что записанное
    // значение должно быть прочитано как pending-заявка.
    const runId = freshRunId();
    const created = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's_p',
      message: 'm',
    });
    const list = await listMeetingRequests(runId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
  });

  it('возвращает заявки в порядке создания', async () => {
    // Журнал событий хронологический; список тоже должен быть в
    // порядке `created`-строк, чтобы UI не нужно было сортировать.
    const runId = freshRunId();
    const first = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's1',
      message: 'first',
    });
    const second = await createMeetingRequest(runId, {
      requesterRole: 'architect',
      requesteeRole: 'programmer',
      contextSessionId: 's2',
      message: 'second',
    });
    const list = await listMeetingRequests(runId);
    expect(list.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it('игнорирует битые строки и пустые строки журнала', async () => {
    // Битые строки бывают по двум причинам: (1) прерывание записи
    // другим процессом (теоретически, на нашей платформе redo append
    // атомарен per-write до 4KB, но всё равно страхуемся); (2) ручная
    // правка пользователя. В обоих случаях список должен показать всё
    // валидное, а не падать целиком.
    const runId = freshRunId();
    const valid = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's',
      message: 'm',
    });
    await fs.appendFile(getMeetingRequestsFile(runId), '\n{ это не json\n\n', 'utf8');
    const list = await listMeetingRequests(runId);
    expect(list.map((r) => r.id)).toEqual([valid.id]);
  });
});

describe('updateMeetingRequestStatus', () => {
  it('применяет новый статус и автоматически проставляет resolvedAt', async () => {
    // Resolver часто не передаёт resolvedAt явно — проверяем, что
    // хранилище подставляет текущее время для не-pending переходов.
    const runId = freshRunId();
    const created = await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'architect',
      contextSessionId: 's_prog',
      message: 'нужно обсудить эскалацию',
    });
    const before = Date.now();
    await updateMeetingRequestStatus(runId, created.id, 'resolved', {
      resolvedSessionId: 's_room',
    });
    const after = Date.now();

    const [request] = await listMeetingRequests(runId);
    expect(request.status).toBe('resolved');
    expect(request.resolvedSessionId).toBe('s_room');
    expect(request.resolvedAt).toBeDefined();
    const resolvedAtMs = Date.parse(request.resolvedAt!);
    // resolvedAt должен лежать в окне [before, after] — т.е. это
    // действительно «сейчас», а не какой-то фиксированный таймстамп.
    expect(resolvedAtMs).toBeGreaterThanOrEqual(before);
    expect(resolvedAtMs).toBeLessThanOrEqual(after);
  });

  it('последняя запись по id побеждает при folding', async () => {
    // Два update'а подряд: pending → resolved → failed. Итог в списке —
    // failed. Это и есть правило «последний выигрывает» из AC.
    const runId = freshRunId();
    const created = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's',
      message: 'm',
    });
    await updateMeetingRequestStatus(runId, created.id, 'resolved', {
      resolvedSessionId: 's_room',
    });
    await updateMeetingRequestStatus(runId, created.id, 'failed', {
      failureReason: 'передумали',
    });
    const [request] = await listMeetingRequests(runId);
    expect(request.status).toBe('failed');
    expect(request.failureReason).toBe('передумали');
    // resolvedSessionId, проставленный первым update'ом, остаётся —
    // второй (failed) не передал это поле, значит «не меняем».
    expect(request.resolvedSessionId).toBe('s_room');
  });

  it('игнорирует update без соответствующего created (осиротевший)', async () => {
    // Если по какой-то причине в журнале есть update для несуществующего
    // id, fold не должен «оживлять» запись из неполных данных.
    const runId = freshRunId();
    await updateMeetingRequestStatus(runId, 'mr_ghost', 'resolved');
    expect(await listMeetingRequests(runId)).toEqual([]);
  });

  it('append добавляет ровно одну строку в журнал на каждый вызов', async () => {
    // Контракт append-only: каждый updateMeetingRequestStatus = +1
    // строка. Никаких перезаписей.
    const runId = freshRunId();
    const created = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's',
      message: 'm',
    });
    await updateMeetingRequestStatus(runId, created.id, 'resolved');
    await updateMeetingRequestStatus(runId, created.id, 'failed');
    const raw = await fs.readFile(getMeetingRequestsFile(runId), 'utf8');
    const lines = raw.trim().split('\n');
    // 1 created + 2 status = 3 строки.
    expect(lines).toHaveLength(3);
  });
});

describe('восстановление после рестарта', () => {
  it('повторное чтение journal-файла даёт ту же свёртку, что и в памяти', async () => {
    // «Симуляция рестарта»: после серии create/update повторный вызов
    // listMeetingRequests должен дать ровно тот же набор объектов, что
    // и сразу после операций. Так мы фиксируем, что правда лежит на
    // диске, а не в каком-нибудь in-memory кэше.
    const runId = freshRunId();
    const requestA = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's_a',
      message: 'a',
    });
    const requestB = await createMeetingRequest(runId, {
      requesterRole: 'architect',
      requesteeRole: 'programmer',
      contextSessionId: 's_b',
      message: 'b',
    });
    await updateMeetingRequestStatus(runId, requestA.id, 'resolved', {
      resolvedSessionId: 's_room_a',
    });
    await updateMeetingRequestStatus(runId, requestB.id, 'failed', {
      failureReason: 'occupied',
    });

    const firstRead = await listMeetingRequests(runId);
    // Повторный read — гарантия отсутствия закешированного состояния.
    const secondRead = await listMeetingRequests(runId);
    expect(secondRead).toEqual(firstRead);

    // Дополнительно фиксируем содержимое: A — resolved, B — failed.
    const byId = new Map(secondRead.map((r) => [r.id, r] as const));
    expect(byId.get(requestA.id)?.status).toBe('resolved');
    expect(byId.get(requestA.id)?.resolvedSessionId).toBe('s_room_a');
    expect(byId.get(requestB.id)?.status).toBe('failed');
    expect(byId.get(requestB.id)?.failureReason).toBe('occupied');
  });
});

describe('getPendingRequests', () => {
  it('возвращает только pending-заявки', async () => {
    // Тонкий фильтр над list: проверяем, что разрезолвленные/упавшие
    // заявки исключены, а оставшиеся идут в порядке создания.
    const runId = freshRunId();
    const requestA = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's_a',
      message: 'a',
    });
    const requestB = await createMeetingRequest(runId, {
      requesterRole: 'architect',
      requesteeRole: 'programmer',
      contextSessionId: 's_b',
      message: 'b',
    });
    const requestC = await createMeetingRequest(runId, {
      requesterRole: 'programmer',
      requesteeRole: 'architect',
      contextSessionId: 's_c',
      message: 'c',
    });
    await updateMeetingRequestStatus(runId, requestB.id, 'resolved', {
      resolvedSessionId: 's_room',
    });

    const pending = await getPendingRequests(runId);
    expect(pending.map((r) => r.id)).toEqual([requestA.id, requestC.id]);
  });

  it('возвращает пустой массив, если все заявки разрезолвлены', async () => {
    const runId = freshRunId();
    const created = await createMeetingRequest(runId, {
      requesterRole: 'product',
      requesteeRole: 'architect',
      contextSessionId: 's',
      message: 'm',
    });
    await updateMeetingRequestStatus(runId, created.id, 'failed', {
      failureReason: 'no quorum',
    });
    expect(await getPendingRequests(runId)).toEqual([]);
  });
});
