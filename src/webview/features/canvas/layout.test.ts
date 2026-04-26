import { describe, it, expect } from 'vitest';
import { layoutCanvas, NODE_W, PAD_X, PAD_Y, ROW_STEP_Y, USER_DIAMETER } from './layout';
import type { RunMeta, SessionSummary, UsageAggregate } from '@shared/runs/types';

const ZERO_USAGE: UsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastTotalTokens: 0,
  lastModel: null,
};

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'user-agent',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    usage: ZERO_USAGE,
    ...over,
  };
}

function meta(sessions: SessionSummary[], over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r1',
    title: 't',
    prompt: 'p',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    activeSessionId: sessions[0]?.id ?? 's1',
    sessions,
    usage: ZERO_USAGE,
    ...over,
  };
}

describe('layoutCanvas — hierarchy-layout (#0042)', () => {
  it('три роли (product, architect, programmer) → три позиции на разных y, одинаковом x', () => {
    // AC #0042: «для трёх ролей возвращает три позиции на разных y,
    // одинаковом x». Порядок по y — строго по `levelOf` (product
    // выше programmer'а вне зависимости от порядка появления в meta).
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
      ])
    );
    expect(result.nodes).toHaveLength(3);
    const [first, second, third] = result.nodes;
    expect(first.role).toBe('product');
    expect(second.role).toBe('architect');
    expect(third.role).toBe('programmer');

    // Все x одинаковые — кубики выровнены по центру по горизонтали.
    expect(second.x).toBe(first.x);
    expect(third.x).toBe(first.x);

    // y растёт строго по уровням, шаг ROW_STEP_Y.
    expect(second.y).toBe(first.y + ROW_STEP_Y);
    expect(third.y).toBe(second.y + ROW_STEP_Y);

    // Каждому кубику — свой `level`, совпадающий с уровнем в иерархии.
    expect(first.level).toBe(0);
    expect(second.level).toBe(1);
    expect(third.level).toBe(2);
  });

  it('две роли → корректно сжимает: два кубика подряд по y, одна линия между ними', () => {
    // AC #0042: «для двух — корректно сжимает». Сжатие = идут подряд
    // по списку, без пустого слота для отсутствующего уровня.
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(result.nodes).toHaveLength(2);
    const [upper, lower] = result.nodes;
    expect(upper.role).toBe('product');
    expect(lower.role).toBe('programmer');
    // Сжатие: y идут подряд, как если бы между ними не было пропуска.
    expect(lower.y).toBe(upper.y + ROW_STEP_Y);
    // Линия одна — между двумя присутствующими уровнями.
    expect(result.reportingLines).toHaveLength(1);
    expect(result.reportingLines[0]).toMatchObject({
      id: 'product--programmer',
      x: upper.x + NODE_W / 2,
      fromY: upper.y + upper.height,
      toY: lower.y,
    });
  });

  it('layout не содержит edges-полей (стрелки коммуникации удалены)', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result).not.toHaveProperty('edges');
    // Только статичные линии-репортинги допустимы как «связи».
    expect(Array.isArray(result.reportingLines)).toBe(true);
  });

  it('пустой meta.sessions → fallback одна нода продакта без линий', () => {
    const result = layoutCanvas(meta([]));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].role).toBe('product');
    expect(result.reportingLines).toHaveLength(0);
  });

  it('user-участник в сессии не порождает кубик (кубик user — задача #0043)', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result.nodes.map((node) => node.role)).toEqual(['product']);
  });

  it('lastActivityAt берётся максимальным по сессиям роли', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          updatedAt: '2026-04-26T10:00:00Z',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          updatedAt: '2026-04-26T11:00:00Z',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    expect(result.nodes[0].lastActivityAt).toBe('2026-04-26T11:00:00Z');
  });

  it('width/height положительны и учитывают число уровней', () => {
    const single = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
      ])
    );
    const triple = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(single.width).toBeGreaterThanOrEqual(NODE_W + PAD_X * 2);
    expect(single.height).toBeGreaterThan(0);
    expect(triple.height).toBeGreaterThan(single.height);
  });

  it('линии-репортинги для трёх ролей: две линии, между соседними уровнями', () => {
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    expect(result.reportingLines).toHaveLength(2);
    expect(result.reportingLines[0].id).toBe('product--architect');
    expect(result.reportingLines[1].id).toBe('architect--programmer');
  });
});

/**
 * User-элемент над иерархией агентов (#0043). Layout добавляет
 * круглый аватар над верхним кубиком и линию-репортинг от него к
 * продакту того же стиля, что между уровнями.
 */
describe('layoutCanvas — user element (#0043)', () => {
  function withProduct(): RunMeta {
    return meta([
      session({
        id: 's1',
        participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
      }),
    ]);
  }

  it('userElement присутствует всегда — даже на дефолтном рана с одним продактом', () => {
    const result = layoutCanvas(withProduct());
    expect(result.userElement).toBeDefined();
    expect(result.userElement.radius).toBe(USER_DIAMETER / 2);
    // Размер отличается от кубика — AC «размер и стиль отличаются».
    expect(USER_DIAMETER).toBeLessThan(NODE_W);
  });

  it('User расположен над верхним кубиком и выровнен с ним по центру по x', () => {
    const result = layoutCanvas(withProduct());
    const product = result.nodes[0];
    // По вертикали — выше продакта (центр круга < верх кубика).
    expect(result.userElement.cy).toBeLessThan(product.y);
    // По горизонтали — на одной оси с центром кубика.
    expect(result.userElement.cx).toBe(product.x + NODE_W / 2);
  });

  it('линия-репортинг от User идёт строго вертикально к верху верхнего кубика', () => {
    const result = layoutCanvas(withProduct());
    const product = result.nodes[0];
    const line = result.userElement.line;
    // x совпадает с осью кубика — линия вертикальная.
    expect(line.x).toBe(product.x + NODE_W / 2);
    // Низ линии = верх кубика; верх линии = низ круга User.
    expect(line.toY).toBe(product.y);
    expect(line.fromY).toBe(result.userElement.cy + result.userElement.radius);
    // id предсказуемый — стабильный ключ для React/тестов.
    expect(line.id).toBe('user--product');
  });

  it('линия от User лежит выше всех межуровневых линий и не входит в reportingLines', () => {
    // AC #0043 + комментарий в типе: линия user→product хранится в
    // userElement.line, а reportingLines — только межуровневые линии
    // агентов. Это позволяет UI рендерить весь User-блок единым
    // компонентом и независимо включать/выключать его.
    const result = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
      ])
    );
    expect(result.reportingLines.map((line) => line.id)).not.toContain('user--product');
    expect(result.userElement.line.fromY).toBeLessThan(result.reportingLines[0].fromY);
  });

  it('кубики сдвинуты вниз, чтобы освободить место под User-элемент', () => {
    // Регрессия: до #0043 верхний кубик сидел на y = PAD_Y. Теперь он
    // должен быть строго ниже PAD_Y, чтобы над ним помещался User
    // (круг + воздух). Конкретные значения — деталь реализации; здесь
    // проверяем только инвариант «кубики ниже PAD_Y».
    const result = layoutCanvas(withProduct());
    expect(result.nodes[0].y).toBeGreaterThan(PAD_Y);
  });

  it('height учитывает зону User-элемента (полотно выше, чем без него)', () => {
    const result = layoutCanvas(withProduct());
    // Полотно должно вмещать сам кружок User целиком: его верхний
    // край лежит на y = PAD_Y, нижний — на cy+radius. Кубик идёт ещё
    // ниже, поэтому height гарантированно > PAD_Y*2 + USER_DIAMETER.
    expect(result.height).toBeGreaterThan(PAD_Y * 2 + USER_DIAMETER);
  });

  it('width не зависит от User-элемента — ось одна с кубиками', () => {
    const result = layoutCanvas(withProduct());
    expect(result.width).toBeGreaterThanOrEqual(NODE_W + PAD_X * 2);
  });

  it('даже при пустых sessions (fallback product) userElement существует и связан с fallback-кубиком', () => {
    const result = layoutCanvas(meta([]));
    expect(result.nodes[0].role).toBe('product');
    expect(result.userElement.line.id).toBe('user--product');
    expect(result.userElement.line.toY).toBe(result.nodes[0].y);
  });

  it('User-элемент не зависит от двух- vs трёхуровневых раскладок (всегда над верхним кубиком)', () => {
    // Ослабление AC «над уровнем product»: верхним всегда оказывается
    // product (collectPresentRoles сортирует по levelOf), но даже
    // если бы UI временно отрисовал двух- или трёхуровневую команду,
    // User по-прежнему стоит над верхним cube. Защищаемся от
    // регрессии «User случайно привязан к product по-имени».
    const twoRoles = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    const threeRoles = layoutCanvas(
      meta([
        session({
          id: 's1',
          participants: [{ kind: 'agent', role: 'product' }],
        }),
        session({
          id: 's2',
          participants: [{ kind: 'agent', role: 'architect' }],
        }),
        session({
          id: 's3',
          participants: [{ kind: 'agent', role: 'programmer' }],
        }),
      ])
    );
    // Линия в обоих случаях привязана к id верхнего кубика.
    expect(twoRoles.userElement.line.id).toBe('user--product');
    expect(twoRoles.userElement.line.toY).toBe(twoRoles.nodes[0].y);
    expect(threeRoles.userElement.line.toY).toBe(threeRoles.nodes[0].y);
    // Радиус и cy-у от числа агентов не зависят.
    expect(twoRoles.userElement.cy).toBe(threeRoles.userElement.cy);
    expect(twoRoles.userElement.radius).toBe(threeRoles.userElement.radius);
  });
});
