import { describe, expect, it } from 'vitest';
import {
  hasPendingAsk,
  registerPendingAsk,
  rejectPendingAsk,
  resolvePendingAsk,
} from './pending-asks';

/**
 * Unit-тесты реестра pending-вопросов от `ask_user`.
 *
 * Проверяем основной жизненный цикл: register → resolve, register → reject,
 * двойной resolve/reject, замену существующего pending'а с тем же id.
 */

describe('pending-asks registry', () => {
  it('register + resolve возвращает Promise, который резолвится ответом', async () => {
    const promise = registerPendingAsk('call-1');
    expect(hasPendingAsk('call-1')).toBe(true);
    const resolved = resolvePendingAsk('call-1', '42');
    expect(resolved).toBe(true);
    await expect(promise).resolves.toBe('42');
    expect(hasPendingAsk('call-1')).toBe(false);
  });

  it('повторный resolve возвращает false (запись уже удалена)', () => {
    registerPendingAsk('call-2');
    expect(resolvePendingAsk('call-2', 'first')).toBe(true);
    expect(resolvePendingAsk('call-2', 'second')).toBe(false);
  });

  it('resolve неизвестного id возвращает false (это валидный сигнал для resume)', () => {
    expect(resolvePendingAsk('never-registered', 'x')).toBe(false);
  });

  it('reject реджектит promise и удаляет запись', async () => {
    const promise = registerPendingAsk('call-3');
    expect(rejectPendingAsk('call-3', 'cancelled')).toBe(true);
    await expect(promise).rejects.toThrow('cancelled');
    expect(hasPendingAsk('call-3')).toBe(false);
  });

  it('повторный register с тем же id реджектит предыдущий promise', async () => {
    const oldPromise = registerPendingAsk('call-4');
    const newPromise = registerPendingAsk('call-4');
    await expect(oldPromise).rejects.toThrow(/заменён/);

    // Новый promise при этом резолвится нормально — он жив и независим.
    resolvePendingAsk('call-4', 'ok');
    await expect(newPromise).resolves.toBe('ok');
  });
});
