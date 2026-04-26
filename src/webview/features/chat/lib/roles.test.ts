import { describe, expect, it } from 'vitest';
import { formatJoinTime, participantToRoleInfo, resolveRoleByName, resolveRoleFrom } from './roles';

describe('resolveRoleFrom (#0041)', () => {
  it('маркер "user" → роль user / имя «Вы»', () => {
    expect(resolveRoleFrom('user')).toEqual({ role: 'user', name: 'Вы' });
  });

  it('маркер "agent:product" → роль product / имя «Продакт»', () => {
    expect(resolveRoleFrom('agent:product')).toEqual({ role: 'product', name: 'Продакт' });
  });

  it('маркер "agent:architect" → роль architect', () => {
    expect(resolveRoleFrom('agent:architect')).toEqual({ role: 'architect', name: 'Архитектор' });
  });

  it('маркер "agent:programmer" → роль programmer (новая в #0041)', () => {
    expect(resolveRoleFrom('agent:programmer')).toEqual({
      role: 'programmer',
      name: 'Программист',
    });
  });

  it('неизвестный agent:* → system с капитализированным именем', () => {
    expect(resolveRoleFrom('agent:designer')).toEqual({ role: 'system', name: 'Designer' });
  });

  it('маркер без префикса "agent:" → system с этим маркером в имени', () => {
    expect(resolveRoleFrom('telemetry')).toEqual({ role: 'system', name: 'telemetry' });
  });
});

describe('resolveRoleByName (#0041)', () => {
  it('известная роль → пара role/name', () => {
    expect(resolveRoleByName('programmer')).toEqual({ role: 'programmer', name: 'Программист' });
  });

  it('пустая строка не падает и даёт system/«Система»', () => {
    expect(resolveRoleByName('')).toEqual({ role: 'system', name: 'Система' });
  });
});

describe('participantToRoleInfo (#0041)', () => {
  it('user-участник → роль user / «Вы»', () => {
    expect(participantToRoleInfo({ kind: 'user' })).toEqual({ role: 'user', name: 'Вы' });
  });

  it('agent-участник → role/name по имени роли', () => {
    expect(participantToRoleInfo({ kind: 'agent', role: 'architect' })).toEqual({
      role: 'architect',
      name: 'Архитектор',
    });
  });
});

describe('formatJoinTime (#0041)', () => {
  it('валидная ISO-метка → строка длины 5 формата HH:MM', () => {
    // Формат HH:MM — два разряда, двоеточие, два разряда. Конкретное
    // значение зависит от TZ, поэтому проверяем форму.
    const at = new Date(2026, 3, 26, 14, 30, 0).toISOString();
    const result = formatJoinTime(at);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  it('невалидная строка проброшена как есть (нет Invalid Date в UI)', () => {
    expect(formatJoinTime('this is not a date')).toBe('this is not a date');
  });

  it('idempotent: тот же вход → тот же выход', () => {
    const at = new Date(2026, 3, 26, 9, 5, 0).toISOString();
    expect(formatJoinTime(at)).toBe(formatJoinTime(at));
  });
});
