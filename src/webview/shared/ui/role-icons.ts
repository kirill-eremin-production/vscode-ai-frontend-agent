import { Code, Cog, Compass, Package, User, type LucideIcon } from 'lucide-react';

/**
 * Маппинг ролей агента на lucide-иконки.
 *
 * Один источник правды для аватаров (#0016 Avatar) и канваса (#0023):
 * если завтра поменяем иконку для «архитектора», обе локации обновятся
 * синхронно. Цвет фона аватара берётся отдельно — из токенов
 * `--color-role-*`, заданных в [src/webview/app/app.css](../../app/app.css).
 *
 * Тип `Role` дублируется здесь намеренно — webview не должен импортировать
 * константы из extension'а (ESLint boundary). Когда добавим новую роль,
 * правка в трёх местах: extension-роли, этот маппинг, `--color-role-*`
 * в app.css.
 *
 * Роль `programmer` (#0041) — реализационный уровень иерархии команды
 * (см. `src/extension/team/hierarchy.ts`), берёт иконку `Code` (не
 * `Wrench`, который занят tool-карточками в `tool-icons.ts`).
 */
export type Role = 'product' | 'architect' | 'programmer' | 'user' | 'system';

export const roleIcons: Record<Role, LucideIcon> = {
  product: Package,
  architect: Compass,
  programmer: Code,
  user: User,
  system: Cog,
};
