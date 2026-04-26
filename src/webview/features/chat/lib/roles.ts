import type { Participant } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Утилиты сопоставления `from`-маркера сообщения и `Participant`'а с
 * визуальной ролью UI (#0041).
 *
 * Источник правды для:
 *  - `ChatMessage` — определить роль/имя автора bubble'а;
 *  - `ParticipantsHeader` — список аватаров вверху чата;
 *  - `ParticipantJoinedRow` — строка-системка «X присоединился в HH:MM».
 *
 * Чистые функции живут отдельно от компонентов, чтобы быть покрытыми
 * unit-тестами (vitest подбирает только `*.test.ts`, но не `.test.tsx`)
 * без mount'а React-дерева.
 */
export interface RoleInfo {
  role: Role;
  name: string;
}

/**
 * Имена ролей по-русски для шапок и системных событий. Если в команде
 * появится новая kb-роль (например, `designer`) — добавляем её сюда
 * одной правкой; неизвестные роли сами падают в ветку «System» с
 * капитализированным slug'ом, чтобы UI не падал и не молчал.
 */
const KNOWN_ROLES: Record<string, RoleInfo> = {
  product: { role: 'product', name: 'Продакт' },
  architect: { role: 'architect', name: 'Архитектор' },
  programmer: { role: 'programmer', name: 'Программист' },
  system: { role: 'system', name: 'Система' },
};

/**
 * Маппит `from`-маркер сообщения (`'user'`, `'agent:product'`, …) в
 * `RoleInfo`. Неизвестные `agent:foo` падают в `system`-ветку с
 * капитализированным `foo` — это безопасный дефолт: лента не падает,
 * автор виден.
 */
export function resolveRoleFrom(from: string): RoleInfo {
  if (from === 'user') return { role: 'user', name: 'Вы' };
  if (from.startsWith('agent:')) {
    const tail = from.slice('agent:'.length);
    return resolveRoleByName(tail);
  }
  return { role: 'system', name: from };
}

/**
 * Маппит имя роли (без `agent:`-префикса) в `RoleInfo`. Используется
 * `ParticipantJoinedRow` (берёт `event.role` из `participant_joined`)
 * и общая ветка `resolveRoleFrom`.
 */
export function resolveRoleByName(roleName: string): RoleInfo {
  const known = KNOWN_ROLES[roleName];
  if (known) return known;
  return {
    role: 'system',
    name: roleName.length > 0 ? roleName.charAt(0).toUpperCase() + roleName.slice(1) : 'Система',
  };
}

/**
 * Маппит участника сессии (`Participant`) в `RoleInfo`. Для `kind:
 * 'user'` берётся «Вы» — owner-сторона разговора с точки зрения UI.
 */
export function participantToRoleInfo(participant: Participant): RoleInfo {
  if (participant.kind === 'user') return { role: 'user', name: 'Вы' };
  return resolveRoleByName(participant.role);
}

/**
 * Форматирует ISO-метку как `HH:MM` для строки `participant_joined`
 * («→ Архитектор присоединился в 14:30»). Локаль `ru-RU` нужна только
 * чтобы зафиксировать порядок «часы:минуты»; конкретное значение
 * зависит от часового пояса пользователя — это и нужно, время в
 * шапке должно совпадать с ощущениями «сейчас».
 *
 * Невалидная строка пробрасывается как есть — лучше показать сырой
 * timestamp, чем «Invalid Date» или пусто.
 */
export function formatJoinTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
