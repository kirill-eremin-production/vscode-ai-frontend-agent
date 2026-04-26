import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Компактный пилюль-индикатор. Используется для статусов рана и для
 * `kind` сессий (#0012 user-agent / agent-agent).
 *
 * Варианты — семантические, а не цветовые: компонент-потребитель не
 * должен знать, что `success` это зелёный (это решает токен в #0015).
 */
export type BadgeVariant = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  title?: string;
}

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  // mix-blend через `color-mix` даёт фон, читающийся на любой теме без
  // отдельного токена под каждый вариант. Текст — base-токен.
  neutral: 'text-foreground bg-[color-mix(in_srgb,currentColor_12%,transparent)]',
  accent: 'text-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]',
  danger: 'text-danger bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)]',
  warning: 'text-warning bg-[color-mix(in_srgb,var(--color-warning)_22%,transparent)]',
  success: 'text-success bg-[color-mix(in_srgb,var(--color-success)_22%,transparent)]',
};

export function Badge(props: BadgeProps) {
  const variant = props.variant ?? 'neutral';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-medium leading-none uppercase tracking-wide',
        VARIANT_CLASS[variant],
        props.className
      )}
      title={props.title}
    >
      {props.children}
    </span>
  );
}
