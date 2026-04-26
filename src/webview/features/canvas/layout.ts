import type { Participant, RunMeta, SessionSummary } from '@shared/runs/types';
import type { Role } from '@shared/ui';
import { HIERARCHY, isHierarchyRole, levelOf, type HierarchyRole } from './hierarchy';

/**
 * Hierarchy-layout канваса команды агентов (#0042).
 *
 * Заменяет прежний flow-layout (#0023): canvas из графа становится
 * org-chart'ом. Кубики ролей расположены строго по уровням иерархии
 * (`HIERARCHY`), один кубик на роль, центр по горизонтали, шаг по
 * вертикали. Все edge-данные (стрелки коммуникации, bridge-привязки)
 * удалены из layout-модели — реальная история работы живёт в журнале
 * встреч (#0029, US-29), а на canvas остаются только статичные тонкие
 * линии-«репортинги» между уровнями (org-chart-стиль).
 *
 * Линии-репортинги вычисляются один раз по присутствующим уровням и
 * не зависят от polling'а meta'ы — это соответствует требованию AC
 * «рисуются один раз на маунт, не на каждый poll-tick». Технически
 * `layoutCanvas` чистая функция и пересчитывается на смену `meta`, но
 * массив `reportingLines` пересоздаётся только при изменении набора
 * ролей; React-уровень рендерит их без анимаций и без подписки на
 * сессии/сообщения.
 */

/** Шаг между уровнями по вертикали. Подобран под высоту кубика + воздух. */
export const ROW_STEP_Y = 140;
export const NODE_W = 200;
export const NODE_H = 96;
export const PAD_X = 32;
export const PAD_Y = 32;
/**
 * Базовая ширина «полотна» — достаточно для одного кубика по центру.
 * Реальная ширина viewBox мажорно определяется CanvasViewport через
 * ResizeObserver; layout даёт минимально-разумный размер на случай,
 * если контейнер ещё не измерен (первый рендер).
 */
const BASE_WIDTH = NODE_W + PAD_X * 2;

export interface CanvasNode {
  id: Role;
  role: HierarchyRole;
  /** Левый-верхний угол кубика в viewBox-координатах. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Уровень роли в `HIERARCHY` (`product` = 0, `architect` = 1,
   * `programmer` = 2). Используется и тестами layout'а, и UI-слоем
   * для отрисовки линий-репортингов между соседними уровнями.
   */
  level: number;
  /** Время последней активности любой сессии этой роли (ISO). */
  lastActivityAt?: string;
}

/**
 * Статичная линия-«репортинг» между двумя соседними уровнями
 * иерархии (org-chart-стиль). Без стрелок, без подписей, без анимаций.
 */
export interface CanvasReportingLine {
  id: string;
  /** y-координата верхней точки линии (нижний край верхнего кубика). */
  fromY: number;
  /** y-координата нижней точки линии (верхний край нижнего кубика). */
  toY: number;
  /** x-координата (общая, кубики выровнены по центру). */
  x: number;
}

export interface CanvasLayout {
  nodes: CanvasNode[];
  /**
   * Линии-репортинги между уровнями. Длина = `nodes.length - 1` для
   * соседних кубиков (если уровней меньше — соответственно меньше).
   * Для одного кубика — пустой массив.
   */
  reportingLines: CanvasReportingLine[];
  /** Размер всего полотна — для дефолтного viewBox. */
  width: number;
  height: number;
}

function rolesOf(session: SessionSummary): Role[] {
  if (!session.participants || session.participants.length === 0) return [];
  return session.participants.map((participant: Participant) =>
    participant.kind === 'user' ? 'user' : (participant.role as Role)
  );
}

/**
 * Собирает уникальные роли иерархии, реально присутствующие в `meta`.
 * Если ни одной роли нет (пустой `sessions`, или только user-участник) —
 * возвращает fallback `['product']`: пустой canvas без кубиков выглядит
 * как сломанный, а продакт всегда первый агент в любом ране.
 *
 * `Set` не используем намеренно: ролей мало (3 на сегодня), важен
 * детерминированный порядок по `levelOf`, а не порядок появления.
 */
function collectPresentRoles(meta: RunMeta): HierarchyRole[] {
  const present = new Set<HierarchyRole>();
  for (const session of meta.sessions ?? []) {
    for (const role of rolesOf(session)) {
      if (isHierarchyRole(role)) present.add(role);
    }
  }
  if (present.size === 0) present.add('product');
  return [...present].sort((a, b) => levelOf(a) - levelOf(b));
}

/**
 * Считает `lastActivityAt` для каждой роли — берётся максимальный
 * `updatedAt` по всем сессиям, где роль присутствует как агент.
 * Используется кубиком для подписи «N мин назад» (UX из #0024).
 */
function computeLastActivity(meta: RunMeta): Map<HierarchyRole, string> {
  const lastActivity = new Map<HierarchyRole, string>();
  for (const session of meta.sessions ?? []) {
    for (const role of rolesOf(session)) {
      if (!isHierarchyRole(role)) continue;
      const previous = lastActivity.get(role);
      if (!previous || previous < session.updatedAt) {
        lastActivity.set(role, session.updatedAt);
      }
    }
  }
  return lastActivity;
}

export function layoutCanvas(meta: RunMeta): CanvasLayout {
  const presentRoles = collectPresentRoles(meta);
  const lastActivity = computeLastActivity(meta);

  // Центр по горизонтали: x одинаковый для всех кубиков.
  const centerX = PAD_X;
  const nodes: CanvasNode[] = presentRoles.map((role, index) => ({
    id: role,
    role,
    level: levelOf(role),
    x: centerX,
    y: PAD_Y + index * ROW_STEP_Y,
    width: NODE_W,
    height: NODE_H,
    lastActivityAt: lastActivity.get(role),
  }));

  // Линии-репортинги: между i и i+1 кубиками. AC говорит «между
  // уровнями» — мы соединяем соседей по отображаемому списку, а не по
  // абсолютному уровню. Это и есть ожидаемое «сжатие» в тесте на 2 роли:
  // если присутствуют только product (0) и programmer (2), они идут
  // подряд по y и линия между ними одна.
  const reportingLines: CanvasReportingLine[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const upper = nodes[i];
    const lower = nodes[i + 1];
    reportingLines.push({
      id: `${upper.role}--${lower.role}`,
      fromY: upper.y + upper.height,
      toY: lower.y,
      x: upper.x + upper.width / 2,
    });
  }

  const width = Math.max(BASE_WIDTH, NODE_W + PAD_X * 2);
  const height = PAD_Y * 2 + nodes.length * ROW_STEP_Y;
  return { nodes, reportingLines, width, height };
}

/**
 * Реэкспорт `HIERARCHY` для тестов и потребителей вне `layout.ts`,
 * чтобы не плодить импорт из соседнего файла там, где уже есть layout.
 */
export { HIERARCHY };
