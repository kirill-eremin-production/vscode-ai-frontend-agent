import clsx from 'clsx';
import { roleIcons, type Role } from './role-icons';

/**
 * Аватар роли — круглый/квадратный значок с иконкой.
 *
 * Цвет фона берётся из `--color-role-*` (см. #0015 app.css), иконка —
 * из общего маппинга `roleIcons`. Если когда-то понадобится показывать
 * аватар не-агента (например, аватар модели или пользователя по имени) —
 * добавляем второй компонент `UserAvatar`, не растягиваем этот.
 */
export type AvatarSize = 'sm' | 'md' | 'lg';
export type AvatarShape = 'circle' | 'square';

export interface AvatarProps {
  role: Role;
  size?: AvatarSize;
  shape?: AvatarShape;
  className?: string;
  title?: string;
}

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-5 w-5',
  md: 'h-7 w-7',
  lg: 'h-10 w-10',
};

const SIZE_PX: Record<AvatarSize, number> = {
  sm: 12,
  md: 16,
  lg: 22,
};

const ROLE_BG: Record<Role, string> = {
  product: 'bg-[var(--color-role-product)]',
  architect: 'bg-[var(--color-role-architect)]',
  user: 'bg-[var(--color-role-user)]',
  system: 'bg-[var(--color-role-system)]',
};

export function Avatar(props: AvatarProps) {
  const size = props.size ?? 'md';
  const shape = props.shape ?? 'circle';
  const Icon = roleIcons[props.role];
  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center text-[var(--vscode-button-foreground)] shrink-0',
        SIZE_CLASS[size],
        ROLE_BG[props.role],
        shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        props.className
      )}
      title={props.title ?? props.role}
      aria-label={props.title ?? props.role}
      role="img"
    >
      <Icon size={SIZE_PX[size]} aria-hidden />
    </span>
  );
}
