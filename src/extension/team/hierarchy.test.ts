import { describe, expect, it } from 'vitest';
import { HIERARCHY, areAdjacent, levelOf, rolesBetween, type Role } from './hierarchy';

/**
 * Тесты на иерархию ролей. Покрываем:
 *
 *  1. Стабильность HIERARCHY и levelOf — этим знанием пользуются
 *     остальные тесты ниже, поэтому фиксируем порядок отдельно.
 *  2. `rolesBetween` для всех пар ролей: соседние, через уровень,
 *     одна и та же роль, оба направления.
 *  3. `areAdjacent` — true только для соседних, false для одинаковых
 *     и для пар с промежуточным уровнем.
 *  4. Защитное поведение `levelOf` — на роль, которой в иерархии нет
 *     (например, строкой `'user'`), бросаем явную ошибку, а не
 *     маскируем багом «-1».
 */

describe('HIERARCHY', () => {
  it('содержит роли в порядке product → architect → programmer', () => {
    // Порядок зашит в продукт: «выше» по иерархии — продакт, «ниже» —
    // программист. Если кто-то поменяет местами — этот тест поймает.
    expect(HIERARCHY).toEqual(['product', 'architect', 'programmer']);
  });
});

describe('levelOf', () => {
  it('возвращает индекс роли в HIERARCHY', () => {
    expect(levelOf('product')).toBe(0);
    expect(levelOf('architect')).toBe(1);
    expect(levelOf('programmer')).toBe(2);
  });

  it('бросает на роли, которой в иерархии нет (например, "user")', () => {
    // По AC задачи #0033: если в Role когда-нибудь окажется `'user'`,
    // levelOf на нём должен бросать. Сейчас Role = KnowledgeRole и
    // `'user'` в него не входит, но рантайм-строки могут прийти из
    // тулов/IPC, поэтому защищаемся явной ошибкой.
    expect(() => levelOf('user' as unknown as Role)).toThrow(/иерархи/);
  });
});

describe('rolesBetween', () => {
  // Все пары осмысленно перебираем явно — это и есть «AC: для всех пар».
  it('для одинаковой роли возвращает пустой массив', () => {
    expect(rolesBetween('product', 'product')).toEqual([]);
    expect(rolesBetween('architect', 'architect')).toEqual([]);
    expect(rolesBetween('programmer', 'programmer')).toEqual([]);
  });

  it('для соседних ролей возвращает пустой массив (вниз и вверх)', () => {
    // Соседние пары: (product, architect) и (architect, programmer).
    expect(rolesBetween('product', 'architect')).toEqual([]);
    expect(rolesBetween('architect', 'product')).toEqual([]);
    expect(rolesBetween('architect', 'programmer')).toEqual([]);
    expect(rolesBetween('programmer', 'architect')).toEqual([]);
  });

  it('для пары через уровень возвращает промежуточную роль в направлении от a к b', () => {
    // product → programmer: между ними один уровень — архитектор.
    expect(rolesBetween('product', 'programmer')).toEqual(['architect']);
    // programmer → product: то же содержимое, тот же одиночный
    // уровень-архитектор. Направление прохода обратное, но списком
    // это не видно (промежуточный уровень один).
    expect(rolesBetween('programmer', 'product')).toEqual(['architect']);
  });
});

describe('areAdjacent', () => {
  it('true для соседних уровней в обе стороны', () => {
    expect(areAdjacent('product', 'architect')).toBe(true);
    expect(areAdjacent('architect', 'product')).toBe(true);
    expect(areAdjacent('architect', 'programmer')).toBe(true);
    expect(areAdjacent('programmer', 'architect')).toBe(true);
  });

  it('false для одинаковой роли', () => {
    // «Соседство» подразумевает прямой канал между разными уровнями;
    // одна и та же роль — это не «канал», а «никуда не двигаемся».
    expect(areAdjacent('product', 'product')).toBe(false);
    expect(areAdjacent('architect', 'architect')).toBe(false);
    expect(areAdjacent('programmer', 'programmer')).toBe(false);
  });

  it('false для пары через уровень', () => {
    // product ↔ programmer — между ними архитектор, поэтому не соседи.
    expect(areAdjacent('product', 'programmer')).toBe(false);
    expect(areAdjacent('programmer', 'product')).toBe(false);
  });
});
