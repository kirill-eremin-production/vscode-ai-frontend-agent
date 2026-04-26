import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './time';

/**
 * Юнит-тесты для `formatRelativeTime` (#0020). Проверяем зоны:
 * только что / минуты / сегодня / вчера / в этом году / прошлый год.
 */
describe('formatRelativeTime', () => {
  const NOW = new Date('2026-04-26T15:00:00Z');

  it('меньше минуты → «только что»', () => {
    const r = formatRelativeTime('2026-04-26T14:59:30Z', NOW);
    expect(r.label).toBe('только что');
    expect(r.tooltip.length).toBeGreaterThan(0);
  });

  it('минуты в этом часе → «N минут назад» с правильной русской формой', () => {
    expect(formatRelativeTime('2026-04-26T14:58:00Z', NOW).label).toBe('2 минуты назад');
    expect(formatRelativeTime('2026-04-26T14:55:00Z', NOW).label).toBe('5 минут назад');
    expect(formatRelativeTime('2026-04-26T14:59:00Z', NOW).label).toBe('1 минуту назад');
    expect(formatRelativeTime('2026-04-26T14:39:00Z', NOW).label).toBe('21 минуту назад');
  });

  it('тот же день, но >1 часа → «сегодня в HH:mm»', () => {
    const r = formatRelativeTime('2026-04-26T08:30:00Z', NOW);
    expect(r.label).toMatch(/^сегодня в \d{2}:\d{2}$/);
  });

  it('вчера → «вчера в HH:mm»', () => {
    const r = formatRelativeTime('2026-04-25T20:30:00Z', NOW);
    expect(r.label).toMatch(/^вчера в \d{2}:\d{2}$/);
  });

  it('давно в этом году → «D мес»', () => {
    const r = formatRelativeTime('2026-01-15T10:00:00Z', NOW);
    expect(r.label).toBe('15 янв');
  });

  it('прошлый год → «D мес YYYY»', () => {
    const r = formatRelativeTime('2025-11-03T10:00:00Z', NOW);
    expect(r.label).toBe('3 ноя 2025');
  });

  it('невалидная дата → возвращает исходную строку и не падает', () => {
    const r = formatRelativeTime('not-a-date', NOW);
    expect(r.label).toBe('not-a-date');
    expect(r.tooltip).toBe('not-a-date');
  });
});
