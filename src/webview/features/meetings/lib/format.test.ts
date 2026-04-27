import { describe, it, expect } from 'vitest';
import type { SessionSummary, UsageAggregate } from '@shared/runs/types';
import {
  formatInputFromLabel,
  formatStartedAt,
  getMessagePreview,
  participantToRole,
  sortMeetingsByCreatedDesc,
} from './format';

const ZERO_USAGE: UsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastTotalTokens: 0,
  lastModel: null,
};

function makeSession(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'user-agent',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    usage: ZERO_USAGE,
    ...over,
  };
}

describe('sortMeetingsByCreatedDesc', () => {
  it('сортирует свежие сверху по createdAt', () => {
    // Поведение «свежие сверху» — главный AC панели встреч (#0046).
    // Берём три сессии в случайном порядке и проверяем, что выдача
    // отсортирована именно по createdAt desc, а не по позиции в массиве.
    const result = sortMeetingsByCreatedDesc([
      makeSession({ id: 's-old', createdAt: '2026-04-26T10:00:00Z' }),
      makeSession({ id: 's-new', createdAt: '2026-04-26T12:00:00Z' }),
      makeSession({ id: 's-mid', createdAt: '2026-04-26T11:00:00Z' }),
    ]);
    expect(result.map((session) => session.id)).toEqual(['s-new', 's-mid', 's-old']);
  });

  it('возвращает копию, не мутирует исходный массив', () => {
    // На meta.sessions подписаны другие места UI; мутация порядка
    // подменила бы ожидания canvas/SessionTree. Ловим регрессию явно.
    const original: SessionSummary[] = [
      makeSession({ id: 'a', createdAt: '2026-04-26T10:00:00Z' }),
      makeSession({ id: 'b', createdAt: '2026-04-26T11:00:00Z' }),
    ];
    const snapshot = original.map((session) => session.id).join(',');
    sortMeetingsByCreatedDesc(original);
    expect(original.map((session) => session.id).join(',')).toBe(snapshot);
  });

  it('детерминированный tie-breaker по id при равном createdAt', () => {
    // Равный createdAt в реальности возможен при двух подсессиях,
    // созданных в одну миллисекунду. Без tie-breaker'а порядок зависел
    // бы от исходной позиции — сравнение в e2e становилось бы flaky.
    const result = sortMeetingsByCreatedDesc([
      makeSession({ id: 's-b', createdAt: '2026-04-26T10:00:00Z' }),
      makeSession({ id: 's-a', createdAt: '2026-04-26T10:00:00Z' }),
    ]);
    expect(result.map((session) => session.id)).toEqual(['s-a', 's-b']);
  });
});

describe('formatStartedAt', () => {
  const NOW = new Date('2026-04-26T12:00:00Z').getTime();

  it('«just now» в первую минуту', () => {
    // Первая минута жизни встречи — мерцание Nm ago смотрится грубо,
    // показываем «just now», как в большинстве лент-новостей.
    expect(formatStartedAt('2026-04-26T11:59:30Z', NOW)).toBe('just now');
  });

  it('«Nm ago» в первый час', () => {
    // 5 минут назад — относительный формат: пользователь сразу видит
    // «эта встреча только что началась», без подсчёта по часам.
    expect(formatStartedAt('2026-04-26T11:55:00Z', NOW)).toBe('5m ago');
  });

  it('HH:MM в пределах суток', () => {
    // Старше часа, но в тех же сутках — переходим на абсолютное время.
    // Смотрим, что вернулось ровно «HH:MM», без секунд и AM/PM.
    expect(formatStartedAt('2026-04-26T08:30:00Z', NOW)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('DD.MM, если старше 24 часов', () => {
    // Двое суток назад — в HH:MM теряется день, поэтому показываем DD.MM.
    // Год не пишем намеренно: журнал за 365 дней пока сценария нет, а
    // длинная подпись не помещается в карточку панели.
    expect(formatStartedAt('2026-04-24T08:30:00Z', NOW)).toMatch(/^\d{2}\.\d{2}$/);
  });

  it('возвращает оригинал при невалидной метке', () => {
    // Защитная ветка: если из meta пришла кривая строка, лучше показать
    // её сырой, чем «Invalid Date». Это видно в DOM и легко чинится.
    expect(formatStartedAt('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('getMessagePreview', () => {
  it('берёт последнее непустое сообщение и обрезает по длине', () => {
    // AC #0046: «превью одной строки, truncate». Берём последнее
    // непустое — оно даёт актуальный «хвост» диалога. Длинное
    // сообщение схлопываем в … с ограничением.
    const preview = getMessagePreview(
      [{ text: 'Привет' }, { text: '   ' }, { text: 'a'.repeat(200) }],
      10
    );
    expect(preview).toBe(`${'a'.repeat(9)}…`);
  });

  it('пропускает пустые/whitespace-only сообщения', () => {
    // Если последнее сообщение — только пробелы, пробираемся к более
    // раннему. Иначе карточка показала бы пустоту.
    const preview = getMessagePreview([
      { text: 'Первое сообщение' },
      { text: '   \n\t  ' },
      { text: '' },
    ]);
    expect(preview).toBe('Первое сообщение');
  });

  it('схлопывает переносы и табы в один пробел', () => {
    // Превью однострочное; переносы превратили бы карточку в кашу.
    const preview = getMessagePreview([{ text: 'строка1\n\tстрока2' }]);
    expect(preview).toBe('строка1 строка2');
  });

  it('undefined, если все сообщения пустые', () => {
    // Карточка по этому возврату решает, рисовать ли fallback-подпись.
    expect(getMessagePreview([{ text: '' }, { text: '   ' }])).toBeUndefined();
  });

  it('undefined для пустого списка', () => {
    expect(getMessagePreview([])).toBeUndefined();
  });
});

describe('formatInputFromLabel', () => {
  it('маппит известные роли на локализованные имена', () => {
    // AC #0046: «inputFrom — пометка ← user / ← product / etc.».
    // Известные роли локализуем, неизвестные капитализируем.
    expect(formatInputFromLabel('user')).toBe('← Вы');
    expect(formatInputFromLabel('product')).toBe('← Продакт');
    expect(formatInputFromLabel('architect')).toBe('← Архитектор');
    expect(formatInputFromLabel('programmer')).toBe('← Программист');
  });

  it('капитализирует неизвестную роль', () => {
    // Защитная ветка: новый агент-роль может появиться раньше, чем
    // словарь обновлён. Не должны падать или показывать пустоту.
    expect(formatInputFromLabel('designer')).toBe('← Designer');
  });

  it('undefined, если inputFrom отсутствует', () => {
    // Legacy-сессии без поля inputFrom: карточка не должна рисовать
    // пустую пометку «← » без значения.
    expect(formatInputFromLabel(undefined)).toBeUndefined();
    expect(formatInputFromLabel('')).toBeUndefined();
  });
});

describe('participantToRole', () => {
  it('user → user', () => {
    expect(participantToRole({ kind: 'user' })).toBe('user');
  });

  it('известные агентские роли отдаются как есть', () => {
    // Цикл по всем ролям защищает от регрессии при добавлении новой
    // роли в `Role` (TypeScript всё равно поймает unhandled ветку,
    // но тест явно фиксирует контракт).
    expect(participantToRole({ kind: 'agent', role: 'product' })).toBe('product');
    expect(participantToRole({ kind: 'agent', role: 'architect' })).toBe('architect');
    expect(participantToRole({ kind: 'agent', role: 'programmer' })).toBe('programmer');
  });

  it('неизвестная роль фолбэчится в system', () => {
    // Защитная ветка: пришёл агент с ролью, которой нет в `Role`. Не
    // ломаем рендер, не показываем пустой круг — Cog-иконка в системном
    // цвете.
    expect(participantToRole({ kind: 'agent', role: 'designer' })).toBe('system');
  });
});
